/**
 * Turns seed/emails.ts into RFC 2822 messages for Gmail's messages.insert.
 * Pure (no network), so it is unit-tested and also powers --dry-run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dateFmt, dueDate, SEED_EMAILS, seedMessageId, type SeedEmail } from "../../seed/emails";

export const SEED_ASSETS_DIR = path.resolve("seed/assets");

export interface MimeAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MimeInput {
  from: { name: string; email: string };
  to: string;
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  text: string;
  attachments: MimeAttachment[];
}

/** RFC 2047 encoded-word, only when the value isn't plain ASCII. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function address(a: { name: string; email: string }): string {
  const name = /[",.:;<>@()[\]\\]/.test(a.name) ? `"${a.name.replace(/(["\\])/g, "\\$1")}"` : a.name;
  return `${encodeHeader(name)} <${a.email}>`;
}

/** RFC 2822 date with the local UTC offset, e.g. "Sat, 17 Oct 2026 09:14:00 -0700". */
export function rfc2822Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())} ${sign}${oh}${om}`;
}

function b64Lines(data: Buffer): string {
  return (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** Build a complete MIME message (CRLF line endings). */
export function buildMime(m: MimeInput): string {
  const boundary = `cp_${crypto.createHash("sha1").update(m.messageId).digest("hex").slice(0, 24)}`;
  const headers = [
    `From: ${address(m.from)}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${rfc2822Date(m.date)}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
    "X-Client-Pulse-Seed: 1",
  ];
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(Buffer.from(m.text.replace(/\r?\n/g, "\r\n"), "utf8")),
  ].join("\r\n");

  if (m.attachments.length === 0) {
    return [...headers, textPart].join("\r\n") + "\r\n";
  }

  const parts = [textPart];
  for (const a of m.attachments) {
    const name = encodeHeader(a.filename);
    parts.push(
      [
        `Content-Type: ${a.contentType}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        b64Lines(a.data),
      ].join("\r\n"),
    );
  }
  return (
    [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, ""].join("\r\n") +
    "\r\n" +
    parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("") +
    `--${boundary}--\r\n`
  );
}

export interface BuiltSeedMessage {
  email: SeedEmail;
  messageId: string;
  /** Message-ID of the thread's first email, for replies. */
  rootMessageId: string | null;
  date: Date;
  raw: string;
  /** Ground truth with absolute dates, for data/seed-run.json and the eval. */
  labels: {
    key: string;
    subject: string;
    rfc_message_id: string;
    project_id: string;
    asks: string[];
    deadlines: { text: string; due_at: string }[];
    expected_insights: string[];
    trap: SeedEmail["labels"]["trap"];
    attachments: string[];
  };
}

/** Build every seed email, oldest first, relative to the anchor time. */
export function buildSeedMessages(anchor: Date, inbox: string, assetsDir = SEED_ASSETS_DIR): BuiltSeedMessage[] {
  const fmt = dateFmt(anchor);
  return [...SEED_EMAILS]
    .sort((a, b) => b.sent_hours_ago - a.sent_hours_ago)
    .map((email) => {
      const messageId = seedMessageId(email.key);
      const rootMessageId = email.reply_to ? seedMessageId(email.reply_to) : null;
      const date = new Date(anchor.getTime() - email.sent_hours_ago * 3_600_000);
      const attachments = email.attachments.map((a) => ({
        filename: a.file,
        contentType: a.contentType,
        data: fs.readFileSync(path.join(assetsDir, a.file)),
      }));
      const raw = buildMime({
        from: email.from,
        to: inbox,
        subject: email.subject,
        date,
        messageId,
        inReplyTo: rootMessageId ?? undefined,
        references: rootMessageId ?? undefined,
        text: email.body(fmt),
        attachments,
      });
      return {
        email,
        messageId,
        rootMessageId,
        date,
        raw,
        labels: {
          key: email.key,
          subject: email.subject,
          rfc_message_id: messageId,
          project_id: email.labels.project_id,
          asks: email.labels.asks,
          deadlines: email.labels.deadlines.map((d) => ({ text: d.text, due_at: dueDate(anchor, d.due_days) })),
          expected_insights: email.labels.expected_insights,
          trap: email.labels.trap,
          attachments: email.attachments.map((a) => a.file),
        },
      };
    });
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
