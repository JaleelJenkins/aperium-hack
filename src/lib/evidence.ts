/**
 * "Evidence or it doesn't ship": the server checks every pointer an AI item
 * cites before the item is stored, and drops items left with none. It also
 * turns evidence into dashboard links so a judge reaches the source in two
 * clicks.
 */
import type { DB } from "./db";
import type { Evidence } from "./contracts";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** 1-based line in clean_text where the quote starts, or null if it isn't there. */
export function quoteLine(cleanText: string, quote: string): number | null {
  const q = norm(quote);
  if (!q) return null;
  // Normalize line by line, remembering where each line starts in the joined
  // text, so a quote spanning lines maps back to the line it starts on.
  const starts: number[] = [];
  let joined = "";
  cleanText.split("\n").forEach((line, i) => {
    const n = norm(line);
    if (i > 0 && joined && n) joined += " ";
    starts.push(joined.length);
    joined += n;
  });
  const at = joined.indexOf(q);
  if (at < 0) return null;
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= at) line++;
  return line + 1;
}

export type EvidenceCheck = { ok: true } | { ok: false; reason: string };

export function checkEvidence(db: DB, ev: Evidence): EvidenceCheck {
  if (ev.kind === "message") {
    const m = db.prepare(`SELECT clean_text FROM messages WHERE gmail_message_id = ?`).get(ev.message_id) as
      | { clean_text: string }
      | undefined;
    if (!m) return { ok: false, reason: `unknown message ${ev.message_id}` };
    return norm(m.clean_text).includes(norm(ev.quote))
      ? { ok: true }
      : { ok: false, reason: "quote not found in message" };
  }

  const a = db.prepare(`SELECT kind, status, extracted_text, meta_json FROM attachments WHERE id = ?`).get(ev.attachment_id) as
    | { kind: string; status: string; extracted_text: string | null; meta_json: string | null }
    | undefined;
  if (!a) return { ok: false, reason: `unknown attachment ${ev.attachment_id}` };
  if (a.status !== "stored" && a.status !== "extracted") return { ok: false, reason: "attachment was not stored" };

  if (ev.kind === "attachment_page") {
    if (a.kind !== "pdf") return { ok: false, reason: "page evidence on a non-PDF" };
    const meta = a.meta_json ? (JSON.parse(a.meta_json) as { pages?: number; pageText?: string[] }) : {};
    if (meta.pages && ev.page > meta.pages) return { ok: false, reason: `page ${ev.page} > ${meta.pages}` };
    if (ev.quote && meta.pageText?.[ev.page - 1] !== undefined && !norm(meta.pageText[ev.page - 1]).includes(norm(ev.quote))) {
      return { ok: false, reason: `quote not found on page ${ev.page}` };
    }
    return { ok: true };
  }
  if (ev.kind === "attachment_region") {
    return a.kind === "image" ? { ok: true } : { ok: false, reason: "region evidence on a non-image" };
  }
  return ev.end_s >= ev.start_s ? { ok: true } : { ok: false, reason: "end before start" };
}

/**
 * Keep only the evidence that checks out; drop items left with none.
 * Returns what was dropped so it can be logged.
 */
export function keepSupported<T extends { evidence: Evidence[] }>(
  db: DB,
  items: T[],
): { kept: T[]; dropped: { item: T; reasons: string[] }[] } {
  const kept: T[] = [];
  const dropped: { item: T; reasons: string[] }[] = [];
  for (const item of items) {
    const reasons: string[] = [];
    const valid = item.evidence.filter((ev) => {
      const r = checkEvidence(db, ev);
      if (!r.ok) reasons.push(r.reason);
      return r.ok;
    });
    if (valid.length) kept.push({ ...item, evidence: valid });
    else dropped.push({ item, reasons });
  }
  return { kept, dropped };
}

/** Dashboard link for a piece of evidence. Pass the message's clean_text to land on the exact line. */
export function evidenceHref(ev: Evidence, cleanText?: string): string {
  if (ev.kind === "message") {
    const line = cleanText ? quoteLine(cleanText, ev.quote) : null;
    return `/messages/${encodeURIComponent(ev.message_id)}${line ? `#L${line}` : ""}`;
  }
  const base = `/api/attachments/${encodeURIComponent(ev.attachment_id)}`;
  if (ev.kind === "attachment_page") return `${base}#page=${ev.page}`;
  if (ev.kind === "attachment_time") return `${base}#t=${ev.start_s},${ev.end_s}`;
  return base;
}
