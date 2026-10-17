/**
 * Evidence drawer read model (PRD F6.4 + F6.5): everything the right-hand slide-over
 * shows for one card, plus the "Caught by review" vault of blocked claims.
 * One click on a card opens this; the source is visible without leaving the board.
 */
import type { DB } from "./db";
import type { Evidence } from "./contracts";
import { attachmentNames, evidenceLinkFor, modelNames, routeResolver, ticketKeys, type CardKind, type EvidenceLink, type RouteTrace } from "./board";
import { quoteLine } from "./evidence";

export type InspectRef = { type: "signal" | "action" | "email"; id: string } | { type: "caught" };

export function parseInspectRef(v: string | undefined): InspectRef | null {
  if (!v) return null;
  if (v === "caught") return { type: "caught" };
  const i = v.indexOf(":");
  const type = v.slice(0, i);
  const id = v.slice(i + 1);
  if (!id || (type !== "signal" && type !== "action" && type !== "email")) return null;
  return { type, id };
}

export interface SourceView {
  link: EvidenceLink;
  /** message evidence */
  messageId: string | null;
  sender: string | null;
  subject: string | null;
  sentAt: string | null;
  lines: { n: number; text: string; hit: boolean }[];
  /** pdf / image evidence: URL the drawer embeds */
  fileUrl: string | null;
  quote: string | null;
}

export interface ProjectRef {
  id: string;
  name: string;
  clientName: string;
}

export interface Inspection {
  ref: string;
  key: string | null;
  kind: CardKind;
  title: string;
  status: string;
  dueAt: string | null;
  project: ProjectRef | null;
  draft: { to: string[]; subject: string; body: string } | null;
  sources: SourceView[];
  audit: {
    producer: string | null;
    claim: string;
    originalText: string | null;
    reviewer: string | null;
    verdict: string | null;
    score: number | null;
    reason: string | null;
  } | null;
  messageHref: string | null;
  /** Present for actions: what the approval controls need. */
  approval: ApprovalInfo | null;
  /** Which Reason/Review pair the router chose for the source email, and why. */
  routing: RouteTrace | null;
  /** Each model's own note for the source email (latest run). */
  reasoning: ModelNotes | null;
}

export interface ApprovalInfo {
  actionId: string;
  type: "draft_reply" | "internal_task" | "new_project";
  status: string;
  error: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  gmailDraftId: string | null;
  /** The model's version, when a person edited it. */
  original: { to?: string[]; subject?: string; body?: string; title?: string; notes?: string } | null;
  payload: { to?: string[]; subject?: string; body?: string; title?: string; notes?: string };
  /** new_project cards: where it could be filed. */
  newProject: { suggestedName: string; clientId: string | null; clientName: string | null; closestProjectId: string | null; projects: { id: string; name: string }[]; reason: string | null } | null;
  /** For "save as rule" on reject. */
  projectName: string | null;
  clientName: string | null;
}

export interface ModelNotes {
  reasonModel: string | null;
  reviewModel: string | null;
  reasonNote: string | null;
  reviewNote: string | null;
}

/** Latest pipeline run's notes for a message; null when the message hasn't been reasoned. */
function notesFor(db: DB, messageId: string | null, model: (id: string | null) => string | null): ModelNotes | null {
  if (!messageId) return null;
  const r = db
    .prepare(
      `SELECT reason_profile_id, review_profile_id, reason_trace, review_trace FROM pipeline_runs
        WHERE message_id = ? AND error IS NULL ORDER BY at DESC LIMIT 1`,
    )
    .get(messageId) as { reason_profile_id: string; review_profile_id: string; reason_trace: string | null; review_trace: string | null } | undefined;
  if (!r) return null;
  return {
    reasonModel: model(r.reason_profile_id),
    reviewModel: r.review_profile_id === "none" ? null : model(r.review_profile_id),
    reasonNote: r.reason_trace,
    reviewNote: r.review_trace,
  };
}

export interface CaughtClaim {
  id: string;
  claim: string;
  notes: string;
  blockedBy: "review" | "verify" | "policy" | null;
  /** Team rule that decided it, if any. */
  rule: { code: string; text: string } | null;
  producer: string | null;
  reviewer: string | null;
  score: number | null;
  at: string;
  project: ProjectRef | null;
  source: SourceView | null;
  conflicting: SourceView[];
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Show the whole (short) message, or a window around the hit for long ones. */
const MAX_LINES = 40;

function messageSource(db: DB, messageId: string, quote: string | null, link: EvidenceLink): SourceView | null {
  const m = db
    .prepare(`SELECT gmail_message_id AS id, sender_name, sender_email, subject, sent_at, received_at, clean_text FROM messages WHERE gmail_message_id = ?`)
    .get(messageId) as
    | { id: string; sender_name: string | null; sender_email: string | null; subject: string | null; sent_at: string | null; received_at: string; clean_text: string }
    | undefined;
  if (!m) return null;
  const all = m.clean_text.split("\n");
  const hit = quote ? quoteLine(m.clean_text, quote) : null;
  // A quote can wrap onto following lines; highlight every line it covers.
  const hitLines = new Set<number>();
  if (hit && quote) {
    let remaining = quote.replace(/\s+/g, " ").trim().length;
    for (let n = hit; n <= all.length && remaining > 0; n++) {
      hitLines.add(n);
      remaining -= all[n - 1].replace(/\s+/g, " ").trim().length + 1;
    }
  }
  let start = 1;
  if (all.length > MAX_LINES && hit) start = Math.max(1, hit - Math.floor(MAX_LINES / 2));
  const lines = all.slice(start - 1, start - 1 + MAX_LINES).map((text, i) => ({ n: start + i, text, hit: hitLines.has(start + i) }));
  return {
    link,
    messageId: m.id,
    sender: m.sender_name ? `${m.sender_name} <${m.sender_email}>` : m.sender_email,
    subject: m.subject,
    sentAt: m.sent_at ?? m.received_at,
    lines,
    fileUrl: null,
    quote,
  };
}

function sourceFor(db: DB, ev: Evidence, names: Map<string, string>): SourceView | null {
  const textFor = (id: string) =>
    (db.prepare(`SELECT clean_text FROM messages WHERE gmail_message_id = ?`).get(id) as { clean_text: string } | undefined)?.clean_text;
  const link = evidenceLinkFor(ev, textFor, (id) => names.get(id), null);
  if (ev.kind === "message") return messageSource(db, ev.message_id, ev.quote, link);
  const quote = "quote" in ev && typeof ev.quote === "string" ? ev.quote : null;
  return {
    link,
    messageId: null,
    sender: null,
    subject: null,
    sentAt: null,
    lines: [],
    fileUrl: link.href,
    quote,
  };
}

function sourcesFor(db: DB, evidence: Evidence[]): SourceView[] {
  const names = attachmentNames(db, evidence.flatMap((e) => (e.kind === "message" ? [] : [e.attachment_id])));
  return evidence.map((e) => sourceFor(db, e, names)).filter((s): s is SourceView => s !== null);
}

function projectRef(db: DB, projectId: string | null): ProjectRef | null {
  if (!projectId) return null;
  const r = db
    .prepare(`SELECT p.id, p.name, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ?`)
    .get(projectId) as { id: string; name: string; client_name: string } | undefined;
  return r ? { id: r.id, name: r.name, clientName: r.client_name } : null;
}

export function inspect(db: DB, ref: InspectRef): Inspection | null {
  if (ref.type === "caught") return null;
  const keys = ticketKeys(db);
  const model = modelNames(db);
  const routeFor = routeResolver(db);
  const trail = (messageId: string | null) => ({ routing: routeFor(messageId), reasoning: notesFor(db, messageId, model) });

  if (ref.type === "signal") {
    const s = db.prepare(`SELECT * FROM signals WHERE id = ?`).get(ref.id) as
      | {
          id: string; project_id: string; message_id: string | null; type: CardKind; text: string; original_text: string | null;
          due_at: string | null; status: string; evidence_json: string; produced_by_model: string; reviewed_by_model: string | null;
          review_verdict: string | null; review_score: number | null; review_reason: string | null;
        }
      | undefined;
    if (!s) return null;
    return {
      ref: `signal:${s.id}`,
      key: keys.get(s.id) ?? null,
      kind: s.type,
      title: s.text,
      status: s.status,
      dueAt: s.due_at,
      project: projectRef(db, s.project_id),
      draft: null,
      sources: sourcesFor(db, parseJson<Evidence[]>(s.evidence_json, [])),
      audit: {
        producer: model(s.produced_by_model),
        claim: s.original_text ?? s.text,
        originalText: s.original_text,
        reviewer: model(s.reviewed_by_model),
        verdict: s.review_verdict,
        score: s.review_score,
        reason: s.review_reason,
      },
      messageHref: s.message_id ? `/messages/${encodeURIComponent(s.message_id)}` : null,
      approval: null,
      ...trail(s.message_id),
    };
  }

  if (ref.type === "action") {
    const a = db.prepare(`SELECT * FROM actions WHERE id = ?`).get(ref.id) as
      | {
          id: string; project_id: string | null; message_id: string | null; type: CardKind; payload_json: string;
          status: string; evidence_json: string; produced_by_model: string; reviewed_by_model: string | null;
          review_verdict: string | null; review_score: number | null; review_reason: string | null;
          thread_id: string | null; error: string | null; decided_by: string | null; decided_at: string | null;
          decision_reason: string | null; gmail_draft_id: string | null; original_payload_json: string | null;
        }
      | undefined;
    if (!a) return null;
    const p = parseJson<{ to?: string[]; subject?: string; body?: string; title?: string; notes?: string; suggested_name?: string }>(a.payload_json, {});
    const title =
      a.type === "draft_reply" ? p.subject || "Draft reply" : a.type === "internal_task" ? p.title || "Internal task" : `New project? ${p.suggested_name ?? ""}`.trim();
    return {
      ref: `action:${a.id}`,
      key: keys.get(a.id) ?? null,
      kind: a.type,
      title,
      status: a.status,
      dueAt: null,
      project: projectRef(db, a.project_id),
      draft:
        a.type === "draft_reply"
          ? { to: p.to ?? [], subject: p.subject ?? "", body: p.body ?? "" }
          : a.type === "internal_task"
            ? { to: [], subject: p.title ?? "", body: p.notes ?? "" }
            : null,
      sources: sourcesFor(db, parseJson<Evidence[]>(a.evidence_json, [])),
      audit: {
        producer: model(a.produced_by_model),
        claim: title,
        originalText: null,
        reviewer: model(a.reviewed_by_model),
        verdict: a.review_verdict,
        score: a.review_score,
        reason: a.review_reason,
      },
      messageHref: a.message_id ? `/messages/${encodeURIComponent(a.message_id)}` : null,
      approval: approvalInfo(db, a, p),
      ...trail(a.message_id),
    };
  }

  const m = db
    .prepare(`SELECT m.gmail_message_id AS id, m.subject, m.status, t.project_id FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id WHERE m.gmail_message_id = ?`)
    .get(ref.id) as { id: string; subject: string | null; status: string; project_id: string | null } | undefined;
  if (!m) return null;
  const link: EvidenceLink = { href: `/messages/${encodeURIComponent(m.id)}`, label: "EMAIL", kind: "message" };
  const src = messageSource(db, m.id, null, link);
  return {
    ref: `email:${m.id}`,
    key: null,
    kind: "email",
    title: m.subject || "(no subject)",
    status: m.status,
    dueAt: null,
    project: projectRef(db, m.project_id),
    draft: null,
    sources: src ? [src] : [],
    audit: null,
    messageHref: link.href,
    approval: null,
    ...trail(m.id),
  };
}

/** Claims stopped before they reached the board: review blocks, verify failures, policy guards. */
export function caughtClaims(db: DB): CaughtClaim[] {
  const rows = db
    .prepare(
      `SELECT mr.id, mr.project_id, mr.message_id, mr.produced_by_model, mr.reviewer_model, mr.blocked_by, mr.score, mr.notes, mr.claim_json,
              mr.conflicting_evidence_json, mr.at, rr.code AS rule_code, rr.text AS rule_text
         FROM model_reviews mr LEFT JOIN review_rules rr ON rr.id = mr.rule_id
        WHERE mr.verdict = 'block' ORDER BY mr.at DESC`,
    )
    .all() as {
    id: string; project_id: string | null; message_id: string | null; produced_by_model: string | null; reviewer_model: string | null;
    blocked_by: CaughtClaim["blockedBy"]; score: number | null; notes: string | null; claim_json: string | null;
    conflicting_evidence_json: string | null; at: string; rule_code: string | null; rule_text: string | null;
  }[];
  const model = modelNames(db);
  return rows.map((r) => {
    const claim = parseJson<{ text?: string; title?: string; payload?: { subject?: string } }>(r.claim_json, {});
    const msgLink: EvidenceLink = { href: r.message_id ? `/messages/${encodeURIComponent(r.message_id)}` : "#", label: "EMAIL", kind: "message" };
    return {
      id: r.id,
      claim: claim.text ?? claim.title ?? claim.payload?.subject ?? "(claim)",
      notes: r.notes ?? "",
      blockedBy: r.blocked_by,
      rule: r.rule_code ? { code: r.rule_code, text: r.rule_text ?? "" } : null,
      producer: model(r.produced_by_model),
      reviewer: model(r.reviewer_model),
      score: r.score,
      at: r.at,
      project: projectRef(db, r.project_id),
      source: r.message_id ? messageSource(db, r.message_id, null, msgLink) : null,
      conflicting: sourcesFor(db, parseJson<Evidence[]>(r.conflicting_evidence_json, [])),
    };
  });
}

export function caughtCount(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM model_reviews WHERE verdict = 'block'`).get() as { n: number }).n;
}

function approvalInfo(
  db: DB,
  a: {
    id: string; type: CardKind; status: string; project_id: string | null; error: string | null; decided_by: string | null;
    decided_at: string | null; decision_reason: string | null; gmail_draft_id: string | null; original_payload_json: string | null;
    payload_json: string;
  },
  payload: ApprovalInfo["payload"],
): ApprovalInfo {
  const type = a.type as ApprovalInfo["type"];
  const project = a.project_id
    ? (db.prepare(`SELECT p.name, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ?`).get(a.project_id) as
        | { name: string; client_name: string }
        | undefined)
    : undefined;
  let newProject: ApprovalInfo["newProject"] = null;
  if (type === "new_project") {
    const np = parseJson<{ suggested_name?: string; client_id?: string | null; closest_project_id?: string | null; reason?: string }>(a.payload_json, {});
    const clientId = np.client_id ?? null;
    const clientName = clientId ? ((db.prepare(`SELECT name FROM clients WHERE id = ?`).get(clientId) as { name: string } | undefined)?.name ?? null) : null;
    const projects = (
      clientId
        ? db.prepare(`SELECT id, name FROM projects WHERE client_id = ? AND status != 'archived' ORDER BY name`).all(clientId)
        : db.prepare(`SELECT p.id, c.name || ' / ' || p.name AS name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.status != 'archived' ORDER BY c.name, p.name`).all()
    ).map((r) => ({ ...(r as { id: string; name: string }) })); // plain objects: this crosses into a client component
    newProject = { suggestedName: np.suggested_name ?? "", clientId, clientName, closestProjectId: np.closest_project_id ?? null, projects, reason: np.reason ?? null };
  }
  return {
    actionId: a.id,
    type,
    status: a.status,
    error: a.error,
    decidedBy: a.decided_by,
    decidedAt: a.decided_at,
    decisionReason: a.decision_reason,
    gmailDraftId: a.gmail_draft_id,
    original: a.original_payload_json ? parseJson(a.original_payload_json, null) : null,
    payload,
    newProject,
    projectName: project?.name ?? null,
    clientName: project?.client_name ?? null,
  };
}
