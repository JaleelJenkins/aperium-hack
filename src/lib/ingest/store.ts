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

export function emailExists(db: DB, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM emails WHERE id = ?`).get(id);
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
  if (emailExists(db, messageId)) return "exists";

  const msg = await api.getMessage(messageId);
  const parsed = parseGmailMessage(msg);
  if (!isInbound(parsed.labelIds)) return "skipped";

  const dataDir = opts.dataDir ?? config.dataDir;
  const stored = await Promise.all(parsed.attachments.map((a) => fetchAttachment(api, parsed, a, dataDir)));

  const inserted = db.transaction(() => {
    const res = insertEmail(db, account, parsed);
    if (res === 0) return false; // another process got here first
    const ins = db.prepare(
      `INSERT INTO attachments
        (id, email_id, part_id, gmail_attachment_id, filename, mime_type, size, kind, is_inline,
         content_id, sha256, storage_path, status, error)
       VALUES (@id, @email_id, @part_id, @gmail_attachment_id, @filename, @mime_type, @size, @kind, @is_inline,
         @content_id, @sha256, @storage_path, @status, @error)`,
    );
    for (const row of stored) ins.run(row);
    audit(db, "worker", "email.ingested", "email", parsed.id, {
      threadId: parsed.threadId,
      from: parsed.from?.email ?? null,
      subject: parsed.subject,
      bodySource: parsed.bodySource,
      cleanLines: parsed.bodyClean ? parsed.bodyClean.split("\n").length : 0,
      attachments: stored.map((s) => ({ id: s.id, kind: s.kind, status: s.status })),
    });
    return true;
  })();

  return inserted ? "new" : "exists";
}

function insertEmail(db: DB, account: string, e: ParsedEmail): number {
  return db
    .prepare(
      `INSERT OR IGNORE INTO emails
        (id, account, thread_id, rfc_message_id, in_reply_to, references_header, from_name, from_email,
         to_json, cc_json, subject, sent_at, received_at, snippet, label_ids, body_source, body_raw, body_clean)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.id,
      account,
      e.threadId,
      e.rfcMessageId,
      e.inReplyTo,
      e.references,
      e.from?.name ?? null,
      e.from?.email ?? null,
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
  id: string;
  email_id: string;
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
    email_id: email.id,
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

  // Extract handles PDFs and images; everything else is recorded so it shows up, but not downloaded.
  if (a.kind === "other") return { ...row, error: "unsupported type" };
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
