/**
 * Evidence anchors. Every signal, insight and action downstream must point at
 * one of these so a judge can reach the source in two clicks.
 *
 *   email:<messageId>#L<line>[-L<line>]   a line range of emails.body_clean
 *   attachment:<attachmentId>#p<page>     a PDF page (Extract fills page text)
 *   attachment:<attachmentId>             an image
 */

export function bodyLines(bodyClean: string): string[] {
  return bodyClean.split("\n");
}

export function emailLineRef(emailId: string, from: number, to?: number): string {
  return to && to !== from ? `email:${emailId}#L${from}-L${to}` : `email:${emailId}#L${from}`;
}

export type EvidenceRef =
  | { type: "email"; emailId: string; from: number; to: number }
  | { type: "attachment"; attachmentId: string; page?: number };

export function parseEvidenceRef(ref: string): EvidenceRef | null {
  let m = /^email:([^#]+)#L(\d+)(?:-L(\d+))?$/.exec(ref);
  if (m) {
    const from = Number(m[2]);
    return { type: "email", emailId: m[1], from, to: m[3] ? Number(m[3]) : from };
  }
  m = /^attachment:([^#]+)(?:#p(\d+))?$/.exec(ref);
  if (m) return { type: "attachment", attachmentId: m[1], page: m[2] ? Number(m[2]) : undefined };
  return null;
}

/** Dashboard URL for a reference. */
export function evidenceHref(ref: string): string | null {
  const r = parseEvidenceRef(ref);
  if (!r) return null;
  if (r.type === "email") return `/emails/${encodeURIComponent(r.emailId)}#L${r.from}`;
  const base = `/api/attachments/${encodeURIComponent(r.attachmentId)}`;
  return r.page ? `${base}#page=${r.page}` : base;
}
