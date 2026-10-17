import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { audit, type DB } from "../db";
import type { GmailApi } from "../gmail/client";
import { parseGmailMessage, type ParsedAttachment, type ParsedEmail } from "./parse";

export type IngestOutcome = "new" | "exists" | "skipped";

/** Inline images under this size are almost always signature logos and tracking pixels. */
const MIN_INLINE_IMAGE_BYTES = 4_000;

/** Kinds Extract handles in the hackathon build (PRD F2: audio/video are P2). */
const DOWNLOAD_KINDS = new Set(["pdf", "image"]);

export function messageExists(db: DB, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM messages WHERE gmail_message_id = ?`).get(id);
}

/** Labels that mean the message is ours, not inbound client mail. */
export function isInbound(labelIds: string[]): boolean {
  if (labelIds.includes("DRAFT")) return false;
  if (labelIds.includes("SENT") && !labelIds.includes("INBOX")) return false;
  return true;
}

/**
 * Fetch, parse, clean and store one Gmail message plus its attachments.
 * Idempotent: a message already in the DB is not fetched again.
 */
export async function ingestMessage(
  db: DB,
  api: GmailApi,
  account: string,
  messageId: string,
  opts: { dataDir?: string } = {},
): Promise<IngestOutcome> {
  if (messageExists(db, messageId)) return "exists";

  const parsed = parseGmailMessage(await api.getMessage(messageId));
  if (!isInbound(parsed.labelIds)) return "skipped";

  const dataDir = opts.dataDir ?? config.dataDir;
  const stored = await Promise.all(parsed.attachments.map((a) => fetchAttachment(api, parsed, a, dataDir)));

  const inserted = db.transaction(() => {
    upsertThread(db, account, parsed);
    if (insertMessage(db, account, parsed) === 0) return false; // another process got here first
    const ins = db.prepare(
      `INSERT INTO attachments
        (id, message_id, part_id, gmail_attachment_id, filename, mime_type, size, kind, is_inline,
         content_id, sha256, storage_path, status, error)
       VALUES (@id, @message_id, @part_id, @gmail_attachment_id, @filename, @mime_type, @size, @kind, @is_inline,
         @content_id, @sha256, @storage_path, @status, @error)`,
    );
    for (const row of stored) ins.run({ ...row });
    audit(db, "worker", "message.ingested", `message:${parsed.id}`, {
      threadId: parsed.threadId,
      from: parsed.from?.email ?? null,
      subject: parsed.subject,
      bodySource: parsed.bodySource,
      cleanLines: parsed.bodyClean ? parsed.bodyClean.split("\n").length : 0,
      attachments: stored.map((s) => ({ id: s.id, kind: s.kind, status: s.status })),
      latencyS: Math.round((Date.now() - Date.parse(parsed.receivedAt)) / 100) / 10,
    });
    return true;
  })();

  return inserted ? "new" : "exists";
}

function upsertThread(db: DB, account: string, e: ParsedEmail): void {
  db.prepare(
    `INSERT INTO threads (gmail_thread_id, account, subject, first_message_at, last_message_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(gmail_thread_id) DO UPDATE SET
       first_message_at = MIN(first_message_at, excluded.first_message_at),
       last_message_at  = MAX(last_message_at,  excluded.last_message_at)`,
  ).run(e.threadId, account, stripReplyPrefix(e.subject), e.receivedAt, e.receivedAt);
}

function stripReplyPrefix(subject: string | null): string | null {
  return subject ? subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim() : null;
}

function insertMessage(db: DB, account: string, e: ParsedEmail): number {
  return db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (gmail_message_id, thread_id, account, rfc_message_id, in_reply_to, references_header,
         sender_email, sender_name, to_json, cc_json, subject, sent_at, received_at, snippet,
         label_ids, body_source, raw_text, clean_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.id,
      e.threadId,
      account,
      e.rfcMessageId,
      e.inReplyTo,
      e.references,
      e.from?.email ?? null,
      e.from?.name ?? null,
      JSON.stringify(e.to),
      JSON.stringify(e.cc),
      e.subject,
      e.sentAt,
      e.receivedAt,
      e.snippet,
      JSON.stringify(e.labelIds),
      e.bodySource,
      e.bodyRaw,
      e.bodyClean,
    ).changes;
}

interface AttachmentRow {
  [key: string]: string | number | null;
  id: string;
  message_id: string;
  part_id: string;
  gmail_attachment_id: string | null;
  filename: string;
  mime_type: string;
  size: number;
  kind: string;
  is_inline: number;
  content_id: string | null;
  sha256: string | null;
  storage_path: string | null;
  status: "stored" | "skipped" | "failed";
  error: string | null;
}

async function fetchAttachment(
  api: GmailApi,
  email: ParsedEmail,
  a: ParsedAttachment,
  dataDir: string,
): Promise<AttachmentRow> {
  const row: AttachmentRow = {
    id: `${email.id}:${a.partId}`,
    message_id: email.id,
    part_id: a.partId,
    gmail_attachment_id: a.gmailAttachmentId,
    filename: a.filename,
    mime_type: a.mimeType,
    size: a.size,
    kind: a.kind,
    is_inline: a.isInline ? 1 : 0,
    content_id: a.contentId,
    sha256: null,
    storage_path: null,
    status: "skipped",
    error: null,
  };

  // Everything is recorded so it shows on the timeline; only what Extract handles is downloaded.
  if (!DOWNLOAD_KINDS.has(a.kind)) {
    return { ...row, error: a.kind === "other" ? "unsupported type" : `${a.kind} is on the roadmap (P2)` };
  }
  if (a.size > config.maxAttachmentBytes) return { ...row, error: `larger than ${config.maxAttachmentBytes} bytes` };
  if (a.kind === "image" && a.isInline && a.size > 0 && a.size < MIN_INLINE_IMAGE_BYTES) {
    return { ...row, error: "small inline image (likely logo or tracker)" };
  }

  try {
    const bytes = a.inlineData ?? (a.gmailAttachmentId ? await api.getAttachment(email.id, a.gmailAttachmentId) : null);
    if (!bytes) return { ...row, status: "failed", error: "no data" };

    const rel = path.join("attachments", safeName(email.id), `${safeName(a.partId)}-${safeName(a.filename)}`);
    const abs = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return {
      ...row,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      storage_path: rel,
      status: "stored",
    };
  } catch (err) {
    return { ...row, status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export function safeName(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 120) || "file";
}
