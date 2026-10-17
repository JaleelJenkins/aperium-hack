import type { gmail_v1 } from "googleapis";
import type { GmailApi } from "../src/lib/gmail/client";

export const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Part = gmail_v1.Schema$MessagePart;

export function textPart(mimeType: string, body: string, partId = "0", charset = "UTF-8"): Part {
  return {
    partId,
    mimeType,
    filename: "",
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }],
    body: { size: body.length, data: b64url(Buffer.from(body, charset.toLowerCase() === "iso-8859-1" ? "latin1" : "utf8")) },
  };
}

export function filePart(
  partId: string,
  filename: string,
  mimeType: string,
  size: number,
  opts: { attachmentId?: string; data?: Buffer; contentId?: string; inline?: boolean } = {},
): Part {
  const headers = [{ name: "Content-Type", value: `${mimeType}; name="${filename}"` }];
  headers.push({ name: "Content-Disposition", value: `${opts.inline ? "inline" : "attachment"}; filename="${filename}"` });
  if (opts.contentId) headers.push({ name: "Content-ID", value: `<${opts.contentId}>` });
  return {
    partId,
    mimeType,
    filename,
    headers,
    body: { size, attachmentId: opts.attachmentId, data: opts.data ? b64url(opts.data) : undefined },
  };
}

export function message(
  id: string,
  opts: {
    from?: string;
    to?: string;
    subject?: string;
    date?: string;
    internalDate?: number;
    labelIds?: string[];
    payload?: Part;
    threadId?: string;
  } = {},
): gmail_v1.Schema$Message {
  const payload = opts.payload ?? textPart("text/plain", `Hello from ${id}`);
  payload.headers = [
    ...(payload.headers ?? []),
    { name: "From", value: opts.from ?? '"Jane Client" <jane@acme.com>' },
    { name: "To", value: opts.to ?? "pulse-test@gmail.com" },
    { name: "Subject", value: opts.subject ?? `Subject ${id}` },
    { name: "Date", value: opts.date ?? "Fri, 16 Oct 2026 09:00:00 -0700" },
    { name: "Message-ID", value: `<${id}@mail.acme.com>` },
  ];
  return {
    id,
    threadId: opts.threadId ?? `t-${id}`,
    labelIds: opts.labelIds ?? ["INBOX", "UNREAD"],
    snippet: `snippet ${id}`,
    internalDate: String(opts.internalDate ?? Date.parse("2026-10-16T16:00:00Z")),
    payload,
  };
}

/** In-memory Gmail with a history log, enough to drive syncAccount. */
export class FakeGmail implements GmailApi {
  messages = new Map<string, gmail_v1.Schema$Message>();
  attachments = new Map<string, Buffer>();
  history: { id: number; messageId: string; labelIds: string[] }[] = [];
  historyId = 1000;
  expired = false;
  failGet = new Set<string>();
  calls = { getMessage: [] as string[], listHistory: 0, listMessageIds: 0 };

  deliver(msg: gmail_v1.Schema$Message): void {
    this.messages.set(msg.id!, msg);
    this.historyId += 1;
    this.history.push({ id: this.historyId, messageId: msg.id!, labelIds: msg.labelIds ?? [] });
  }

  async getProfile() {
    return { emailAddress: "pulse-test@gmail.com", historyId: String(this.historyId) };
  }
  async listHistory(startHistoryId: string) {
    this.calls.listHistory++;
    if (this.expired) throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
    const start = Number(startHistoryId);
    const entries = this.history.filter((h) => h.id > start);
    return {
      history: entries.map((h) => ({
        id: String(h.id),
        messagesAdded: [{ message: { id: h.messageId, labelIds: h.labelIds } }],
      })),
      historyId: String(this.historyId),
      nextPageToken: null,
    };
  }
  async listMessageIds() {
    this.calls.listMessageIds++;
    return [...this.messages.values()]
      .filter((m) => m.labelIds?.includes("INBOX"))
      .map((m) => m.id!)
      .reverse(); // Gmail lists newest first
  }
  async getMessage(id: string) {
    this.calls.getMessage.push(id);
    if (this.failGet.has(id)) throw new Error("backendError");
    const m = this.messages.get(id);
    if (!m) throw Object.assign(new Error("Not Found"), { code: 404 });
    return structuredClone(m);
  }
  async getAttachment(_messageId: string, attachmentId: string) {
    const b = this.attachments.get(attachmentId);
    if (!b) throw new Error(`no attachment ${attachmentId}`);
    return b;
  }
}
