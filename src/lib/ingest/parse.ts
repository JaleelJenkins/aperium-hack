import type { gmail_v1 } from "googleapis";
import { convert as htmlToText } from "html-to-text";
import { cleanBody, normalize } from "./clean";

export type GmailMessage = gmail_v1.Schema$Message;
type Part = gmail_v1.Schema$MessagePart;

export interface Address {
  name: string | null;
  email: string;
}

export type AttachmentKind = "pdf" | "image" | "audio" | "video" | "other";

export interface ParsedAttachment {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  isInline: boolean;
  contentId: string | null;
  gmailAttachmentId: string | null;
  /** Small parts arrive inline in the message payload instead of by attachment id. */
  inlineData: Buffer | null;
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string | null;
  sentAt: string | null;
  receivedAt: string;
  snippet: string | null;
  labelIds: string[];
  bodySource: "text/plain" | "text/html" | "none";
  bodyRaw: string;
  bodyClean: string;
  attachments: ParsedAttachment[];
}

export function parseGmailMessage(msg: GmailMessage): ParsedEmail {
  if (!msg.id || !msg.threadId || !msg.payload) {
    throw new Error(`Gmail message is missing id/threadId/payload (id=${msg.id ?? "?"})`);
  }
  const payload = msg.payload;
  const h = headerMap(payload.headers ?? []);

  const { plain, html } = findBodies(payload);
  let bodySource: ParsedEmail["bodySource"] = "none";
  let bodyRaw = "";
  if (plain !== null && plain.trim() !== "") {
    bodySource = "text/plain";
    bodyRaw = plain;
  } else if (html !== null) {
    bodySource = "text/html";
    bodyRaw = htmlToPlain(html);
  }
  bodyRaw = normalize(bodyRaw).trim();

  return {
    id: msg.id,
    threadId: msg.threadId,
    rfcMessageId: h.get("message-id") ?? null,
    inReplyTo: h.get("in-reply-to") ?? null,
    references: h.get("references") ?? null,
    from: parseAddressList(h.get("from") ?? "")[0] ?? null,
    to: parseAddressList(h.get("to") ?? ""),
    cc: parseAddressList(h.get("cc") ?? ""),
    subject: h.get("subject") ?? null,
    sentAt: toIso(h.get("date")),
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    snippet: msg.snippet ?? null,
    labelIds: msg.labelIds ?? [],
    bodySource,
    bodyRaw,
    bodyClean: bodyRaw ? cleanBody(bodyRaw) : "",
    attachments: findAttachments(payload),
  };
}

// ---------------------------------------------------------------- headers

function headerMap(headers: gmail_v1.Schema$MessagePartHeader[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const { name, value } of headers) {
    if (!name || value == null) continue;
    const key = name.toLowerCase();
    if (!m.has(key)) m.set(key, value); // first occurrence wins
  }
  return m;
}

function partHeader(part: Part, name: string): string | null {
  const h = part.headers?.find((x) => x.name?.toLowerCase() === name);
  return h?.value ?? null;
}

function toIso(date: string | undefined): string | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Parses `"Doe, Jane" <jane@x.com>, bob@y.com, Ann <ann@z.com>` respecting quotes. */
export function parseAddressList(value: string): Address[] {
  const out: Address[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    if ((ch === "," || ch === ";") && !inQuotes && !inAngle) {
      pushAddress(out, current);
      current = "";
    } else {
      current += ch;
    }
  }
  pushAddress(out, current);
  return out;
}

function pushAddress(out: Address[], raw: string): void {
  const s = raw.trim();
  if (!s) return;
  const m = /^(.*)<([^>]+)>\s*$/.exec(s);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, "$1").trim();
    out.push({ name: name || null, email: m[2].trim().toLowerCase() });
  } else if (s.includes("@")) {
    out.push({ name: null, email: s.replace(/^"|"$/g, "").toLowerCase() });
  }
}

// ---------------------------------------------------------------- bodies

function walk(part: Part, visit: (p: Part) => void): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function isAttachmentPart(part: Part): boolean {
  if (part.filename) return true;
  const disp = partHeader(part, "content-disposition") ?? "";
  return /^\s*attachment/i.test(disp);
}

function findBodies(payload: Part): { plain: string | null; html: string | null } {
  let plain: string | null = null;
  let html: string | null = null;
  walk(payload, (p) => {
    if (isAttachmentPart(p) || !p.body?.data) return;
    const mime = (p.mimeType ?? "").toLowerCase();
    if (mime === "text/plain" && plain === null) plain = decodeText(p);
    else if (mime === "text/html" && html === null) html = decodeText(p);
  });
  return { plain, html };
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeText(part: Part): string {
  const bytes = decodeBase64Url(part.body!.data!);
  const ctype = partHeader(part, "content-type") ?? "";
  const charset = /charset="?([^";\s]+)"?/i.exec(ctype)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function htmlToPlain(html: string): string {
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      // Gmail and Outlook wrap quoted history in these; drop it like the plain-text cleaner does.
      { selector: "div.gmail_quote", format: "skip" },
      { selector: "blockquote", format: "skip" },
      { selector: "div#appendonsend", format: "skip" },
    ],
  });
}

// ------------------------------------------------------------ attachments

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|ogg|opus|amr)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|avi)$/i;

export function attachmentKind(mimeType: string, filename: string): AttachmentKind {
  const mime = mimeType.toLowerCase();
  if (mime === "application/pdf" || /\.pdf$/i.test(filename)) return "pdf";
  if (mime.startsWith("image/") || IMAGE_EXT.test(filename)) return "image";
  if (mime.startsWith("audio/") || AUDIO_EXT.test(filename)) return "audio";
  if (mime.startsWith("video/") || VIDEO_EXT.test(filename)) return "video";
  return "other";
}

function findAttachments(payload: Part): ParsedAttachment[] {
  const out: ParsedAttachment[] = [];
  walk(payload, (p) => {
    const mime = p.mimeType ?? "application/octet-stream";
    const contentId = partHeader(p, "content-id")?.replace(/^<|>$/g, "") ?? null;
    const isFileLike = isAttachmentPart(p) || (mime.toLowerCase().startsWith("image/") && !!contentId);
    if (!isFileLike) return;
    if (mime.toLowerCase().startsWith("multipart/")) return;
    if (!p.body?.attachmentId && !p.body?.data) return;

    const disp = partHeader(p, "content-disposition") ?? "";
    const filename = p.filename || (contentId ? `inline-${contentId.split("@")[0]}` : `part-${p.partId}`);
    out.push({
      partId: p.partId ?? String(out.length),
      filename,
      mimeType: mime,
      size: p.body?.size ?? 0,
      kind: attachmentKind(mime, filename),
      isInline: /^\s*inline/i.test(disp) || (!!contentId && !/^\s*attachment/i.test(disp)),
      contentId,
      gmailAttachmentId: p.body?.attachmentId ?? null,
      inlineData: p.body?.data ? decodeBase64Url(p.body.data) : null,
    });
  });
  return out;
}
