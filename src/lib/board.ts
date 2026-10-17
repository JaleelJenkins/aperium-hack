/**
 * Portfolio board (PRD F6.1): one swimlane per project, grouped by client, with
 * workflow columns. Everything here is a read model over the pipeline tables;
 * the board never writes.
 *
 *   Triage            mail on this project still moving through the pipeline
 *   Waiting on us     open client asks, our commitments, deadlines, risks
 *   Waiting on client their open commitments
 *   Needs approval    proposed draft replies and internal tasks (human in the loop)
 *   Done              closed signals, recorded decisions, executed/rejected actions
 *
 * Threads with no project yet go to a single "Needs triage" lane at the top.
 */
import type { DB } from "./db";
import type { Evidence } from "./contracts";
import { evidenceHref } from "./evidence";
import { modelFamily } from "./router/leaderboard";
import { getLeaderboard, getRouterSettings, projectRouting, routeMessage, type ProjectRouting } from "./router/store";
import type { RoutingPolicyMode } from "./router/types";

export const COLUMNS = [
  { id: "triage", title: "Triage", hint: "New mail being processed" },
  { id: "on_us", title: "Waiting on us", hint: "Asks, our commitments, deadlines, risks" },
  { id: "on_client", title: "Waiting on client", hint: "What the client promised" },
  { id: "approval", title: "Needs approval", hint: "Drafts and tasks waiting on a person" },
  { id: "done", title: "Done", hint: "Closed, decided or sent" },
] as const;
export type ColumnId = (typeof COLUMNS)[number]["id"];

export type CardKind =
  | "email"
  | "ask"
  | "our_commitment"
  | "their_commitment"
  | "deadline"
  | "decision"
  | "risk"
  | "draft_reply"
  | "internal_task"
  | "new_project";

export type Health = "on_track" | "at_risk" | "blocked";
export type DueState = "overdue" | "soon" | "later";

export interface BoardCard {
  id: string;
  /** "signal:<id>" | "action:<id>" | "email:<id>": what the evidence drawer opens. */
  ref: string;
  /** Jira-style ticket key, e.g. "HP-4" (client initials + sequence). Null for raw mail. */
  key: string | null;
  kind: CardKind;
  title: string;
  /** Secondary line: sender for mail, recipient for drafts, status for failures. */
  detail: string | null;
  dueAt: string | null;
  dueState: DueState | null;
  /** Where clicking the card goes: the evidence (email line / PDF page) or the message. */
  href: string;
  /** Short evidence label for the mono chip, e.g. "EMAIL · L4", "FloorPlan.pdf · p.2". */
  evidenceLabel: string | null;
  evidenceKind: "message" | "pdf" | "image" | "audio" | null;
  review: { verdict: "pass" | "revise"; model: string | null; score: number | null } | null;
  producedBy: string | null;
  status: string | null;
  at: string;
  /** Which Reason -> Review pair the router sends this card's email to, and why. */
  route: RouteTrace | null;
}

export interface RouteTrace {
  pairId: string;
  pairLabel: string; // "Haiku 5.5 → Sonnet 5.5"
  pairShort: string; // "Haiku → Sonnet"
  policy: RoutingPolicyMode;
  escalated: boolean;
  triggers: string[];
  reason: string;
  estCostUsd: number;
  estLatencyMs: number;
  /** true = decision recorded by the pipeline at ingest; false = live, under current policies. */
  recorded: boolean;
  /** Estimates come from an illustrative (not yet measured) leaderboard row. */
  illustrative: boolean;
}

export interface Lane {
  id: string; // project id, or "triage"
  name: string;
  clientId: string | null;
  clientName: string | null;
  summary: string;
  health: Health;
  lastContactAt: string | null;
  columns: Record<ColumnId, BoardCard[]>;
  /** Done is capped on the board; this is the uncapped count. */
  doneTotal: number;
  stats: { open: number; overdue: number; dueSoon: number; approvals: number; blockedByReview: number };
  /** Higher = needs attention sooner. Lanes sort by this within a client. */
  attention: number;
  /** The project's routing policy (null for the triage lane). */
  routing: ProjectRouting | null;
}

export interface ClientGroup {
  id: string;
  name: string;
  domains: string[];
  health: Health;
  lanes: Lane[];
}

export interface Board {
  triage: Lane | null;
  clients: ClientGroup[];
  totals: { projects: number; open: number; overdue: number; approvals: number; blockedByReview: number; atRisk: number };
}

export type BoardFilter = "all" | "attention";

const DONE_CAP = 4;
const SOON_MS = 48 * 3600 * 1000;
const HEALTH_RANK: Record<Health, number> = { on_track: 0, at_risk: 1, blocked: 2 };

const emptyColumns = (): Record<ColumnId, BoardCard[]> => ({
  triage: [],
  on_us: [],
  on_client: [],
  approval: [],
  done: [],
});

function parseEvidence(json: string | null): Evidence[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Evidence[]) : [];
  } catch {
    return [];
  }
}

function parseStrings(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function dueState(dueAt: string | null, now: number): DueState | null {
  if (!dueAt) return null;
  const t = Date.parse(dueAt);
  if (Number.isNaN(t)) return null;
  if (t < now) return "overdue";
  return t - now <= SOON_MS ? "soon" : "later";
}

export interface EvidenceLink {
  href: string;
  label: string | null;
  kind: BoardCard["evidenceKind"];
}

/**
 * Link + mono chip label for one piece of evidence. Exported for the evidence drawer.
 * filenameFor resolves attachment ids so a PDF chip reads "FloorPlan.pdf · p.2".
 */
export function evidenceLinkFor(
  ev: Evidence | undefined,
  cleanTextFor: (messageId: string) => string | undefined,
  filenameFor: (attachmentId: string) => string | undefined,
  fallbackMessageId: string | null,
): EvidenceLink {
  if (!ev) {
    return { href: fallbackMessageId ? `/messages/${encodeURIComponent(fallbackMessageId)}` : "#", label: null, kind: null };
  }
  if (ev.kind === "message") {
    const href = evidenceHref(ev, cleanTextFor(ev.message_id));
    const line = href.match(/#L(\d+)$/)?.[1];
    return { href, label: line ? `EMAIL · L${line}` : "EMAIL", kind: "message" };
  }
  const name = filenameFor(ev.attachment_id);
  if (ev.kind === "attachment_page") return { href: evidenceHref(ev), label: `${name ?? "PDF"} · p.${ev.page}`, kind: "pdf" };
  if (ev.kind === "attachment_region") return { href: evidenceHref(ev), label: name ?? "Image", kind: "image" };
  return { href: evidenceHref(ev), label: `${name ?? "Audio"} · ${ev.start_s}s`, kind: "audio" };
}

/** "Harbor & Pine Architects" -> "HP", "Vector Freight" -> "VF", "Acme" -> "AC". */
export function clientPrefix(name: string): string {
  const words = name.replace(/&/g, " ").split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  const p = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? "XX").slice(0, 2);
  return p.toUpperCase();
}

/**
 * Ticket keys for every signal and action: client prefix + creation order within that
 * client ("HP-1", "HP-2", ...). Stable as long as rows aren't deleted, which the pipeline
 * never does outside a demo reset.
 */
export function ticketKeys(db: DB): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT x.id, c.name AS client_name FROM (
         SELECT id, project_id, created_at FROM signals
         UNION ALL
         SELECT id, project_id, created_at FROM actions WHERE project_id IS NOT NULL
       ) x JOIN projects p ON p.id = x.project_id JOIN clients c ON c.id = p.client_id
       ORDER BY c.id, x.created_at, x.id`,
    )
    .all() as { id: string; client_name: string }[];
  const keys = new Map<string, string>();
  const seq = new Map<string, number>();
  for (const r of rows) {
    const prefix = clientPrefix(r.client_name);
    const n = (seq.get(prefix) ?? 0) + 1;
    seq.set(prefix, n);
    keys.set(r.id, `${prefix}-${n}`);
  }
  return keys;
}

/**
 * Model profile id -> concrete model name ("claude-haiku" -> "claude-haiku-5-5"), so cards
 * show the real model in the chain of custody. Unknown ids pass through unchanged.
 */
export function modelNames(db: DB): (id: string | null) => string | null {
  const rows = db.prepare(`SELECT id, model_name FROM model_profiles`).all() as { id: string; model_name: string }[];
  const map = new Map(rows.map((r) => [r.id, r.model_name]));
  return (id) => (id == null ? null : (map.get(id) ?? id));
}

/** Filenames for attachment ids, for evidence chips. */
export function attachmentNames(db: DB, ids: Iterable<string>): Map<string, string> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = db
    .prepare(`SELECT id, filename FROM attachments WHERE id IN (${list.map(() => "?").join(",")})`)
    .all(...list) as { id: string; filename: string }[];
  return new Map(rows.map((r) => [r.id, r.filename]));
}

interface ProjectRow {
  id: string;
  client_id: string;
  client_name: string;
  domains_json: string;
  name: string;
  summary: string;
  health: Health;
  last_contact_at: string | null;
}
interface SignalRow {
  id: string;
  project_id: string;
  message_id: string | null;
  type: Exclude<CardKind, "email" | "draft_reply" | "internal_task" | "new_project">;
  text: string;
  due_at: string | null;
  status: string;
  evidence_json: string;
  produced_by_model: string;
  reviewed_by_model: string | null;
  review_verdict: string | null;
  review_score: number | null;
  created_at: string;
}
interface ActionRow {
  id: string;
  project_id: string | null;
  message_id: string | null;
  type: "draft_reply" | "internal_task" | "new_project";
  payload_json: string;
  status: string;
  evidence_json: string;
  produced_by_model: string;
  reviewed_by_model: string | null;
  review_verdict: string | null;
  review_score: number | null;
  created_at: string;
  decided_at: string | null;
  error: string | null;
}
interface MailRow {
  id: string;
  project_id: string | null;
  sender_name: string | null;
  sender_email: string | null;
  subject: string | null;
  status: string;
  error: string | null;
  received_at: string;
  guessed_client: string | null;
}

function reviewOf(verdict: string | null, model: string | null, score: number | null): BoardCard["review"] {
  return verdict === "pass" || verdict === "revise" ? { verdict, model, score } : null;
}

export function getBoard(db: DB, opts: { filter?: BoardFilter; now?: number } = {}): Board {
  const now = opts.now ?? Date.now();
  const filter = opts.filter ?? "all";

  const projects = db
    .prepare(
      `SELECT p.id, p.client_id, c.name AS client_name, c.domains_json, p.name, p.summary, p.health, p.last_contact_at
         FROM projects p JOIN clients c ON c.id = p.client_id
        WHERE p.status != 'archived'
        ORDER BY c.name, p.name`,
    )
    .all() as ProjectRow[];

  const signals = db
    .prepare(
      `SELECT id, project_id, message_id, type, text, due_at, status, evidence_json, produced_by_model,
              reviewed_by_model, review_verdict, review_score, created_at
         FROM signals WHERE status != 'superseded'`,
    )
    .all() as SignalRow[];

  const actions = db
    .prepare(
      `SELECT id, project_id, message_id, type, payload_json, status, evidence_json, produced_by_model,
              reviewed_by_model, review_verdict, review_score, created_at, decided_at, error
         FROM actions`,
    )
    .all() as ActionRow[];

  // Mail not yet through the pipeline, plus everything on unassigned threads.
  // guessed_client: sender's contact or domain match, so triage cards say who it's probably from.
  const mail = db
    .prepare(
      `SELECT m.gmail_message_id AS id, t.project_id, m.sender_name, m.sender_email, m.subject, m.status, m.error,
              m.received_at,
              COALESCE(
                (SELECT cl.name FROM contacts ct JOIN clients cl ON cl.id = ct.client_id WHERE ct.email = lower(m.sender_email)),
                (SELECT cl.name FROM clients cl, json_each(cl.domains_json) d
                  WHERE lower(m.sender_email) LIKE '%@' || d.value)
              ) AS guessed_client
         FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id
        WHERE m.status != 'dismissed' AND (t.project_id IS NULL OR m.status != 'reviewed')
        ORDER BY m.received_at DESC
        LIMIT 300`,
    )
    .all() as MailRow[];

  const blockedByProject = new Map(
    (
      db
        .prepare(`SELECT project_id, COUNT(*) AS n FROM model_reviews WHERE verdict = 'block' AND project_id IS NOT NULL GROUP BY project_id`)
        .all() as { project_id: string; n: number }[]
    ).map((r) => [r.project_id, r.n]),
  );

  // clean_text lookups for evidence line anchors, loaded once for all cited messages.
  const citedIds = new Set<string>();
  for (const r of [...signals, ...actions]) {
    for (const ev of parseEvidence(r.evidence_json)) if (ev.kind === "message") citedIds.add(ev.message_id);
  }
  const cleanText = new Map<string, string>();
  if (citedIds.size) {
    const ids = [...citedIds];
    const rows = db
      .prepare(`SELECT gmail_message_id AS id, clean_text FROM messages WHERE gmail_message_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as { id: string; clean_text: string }[];
    for (const r of rows) cleanText.set(r.id, r.clean_text);
  }
  const textFor = (id: string) => cleanText.get(id);
  const citedAttachments: string[] = [];
  for (const r of [...signals, ...actions]) {
    for (const ev of parseEvidence(r.evidence_json)) if (ev.kind !== "message") citedAttachments.push(ev.attachment_id);
  }
  const names = attachmentNames(db, citedAttachments);
  const nameFor = (id: string) => names.get(id);
  const keys = ticketKeys(db);
  const model = modelNames(db);

  // Routing: a decision the pipeline recorded at ingest wins; otherwise route live under current policies,
  // so a policy change or a promoted pair shows up on the board immediately.
  const routerSettings = getRouterSettings(db);
  const leaderboard = getLeaderboard(db);
  const pairById = new Map(leaderboard.map((p) => [p.id, p]));
  const recorded = db.prepare(
    `SELECT policy, pair_id, escalated, triggers_json, reason, est_cost_usd, est_latency_ms FROM route_decisions
      WHERE message_id = ? AND source = 'pipeline' ORDER BY at DESC LIMIT 1`,
  );
  const routes = new Map<string, RouteTrace | null>();
  const routeFor = (messageId: string | null): RouteTrace | null => {
    if (!messageId) return null;
    if (routes.has(messageId)) return routes.get(messageId)!;
    let trace: RouteTrace | null = null;
    const r = recorded.get(messageId) as
      | { policy: RoutingPolicyMode; pair_id: string; escalated: number; triggers_json: string; reason: string; est_cost_usd: number; est_latency_ms: number }
      | undefined;
    if (r) {
      const p = pairById.get(r.pair_id);
      trace = {
        pairId: r.pair_id,
        pairLabel: p?.label ?? r.pair_id,
        pairShort: p ? `${modelFamily(p.reasonModel)} → ${modelFamily(p.reviewModel)}` : r.pair_id,
        policy: r.policy,
        escalated: r.escalated === 1,
        triggers: parseStrings(r.triggers_json),
        reason: r.reason,
        estCostUsd: r.est_cost_usd,
        estLatencyMs: r.est_latency_ms,
        recorded: true,
        illustrative: p?.source === "illustrative",
      };
    } else {
      const d = routeMessage(db, messageId, leaderboard, routerSettings);
      if (d) {
        const p = d.selectedPair;
        trace = {
          pairId: p.id,
          pairLabel: p.label,
          pairShort: `${modelFamily(p.reasonModel)} → ${modelFamily(p.reviewModel)}`,
          policy: d.policyApplied,
          escalated: d.wasEscalated,
          triggers: d.escalationTriggers,
          reason: d.routingReason,
          estCostUsd: d.estimatedCostUsd,
          estLatencyMs: d.estimatedLatencyMs,
          recorded: false,
          illustrative: p.source === "illustrative",
        };
      }
    }
    routes.set(messageId, trace);
    return trace;
  };

  const lanes = new Map<string, Lane>();
  const doneAll = new Map<string, BoardCard[]>();
  for (const p of projects) {
    lanes.set(p.id, {
      id: p.id,
      name: p.name,
      clientId: p.client_id,
      clientName: p.client_name,
      summary: p.summary,
      health: p.health,
      lastContactAt: p.last_contact_at,
      columns: emptyColumns(),
      doneTotal: 0,
      stats: { open: 0, overdue: 0, dueSoon: 0, approvals: 0, blockedByReview: blockedByProject.get(p.id) ?? 0 },
      attention: 0,
      routing: projectRouting(db, p.id, routerSettings),
    });
    doneAll.set(p.id, []);
  }

  const triage: Lane = {
    id: "triage",
    name: "Needs triage",
    clientId: null,
    clientName: null,
    summary: "Mail not filed to a project yet. Low-confidence matches wait here for a person.",
    health: "on_track",
    lastContactAt: null,
    columns: emptyColumns(),
    doneTotal: 0,
    stats: { open: 0, overdue: 0, dueSoon: 0, approvals: 0, blockedByReview: 0 },
    attention: 0,
    routing: null,
  };

  for (const s of signals) {
    const lane = lanes.get(s.project_id);
    if (!lane) continue;
    const link = evidenceLinkFor(parseEvidence(s.evidence_json)[0], textFor, nameFor, s.message_id);
    const card: BoardCard = {
      id: s.id,
      ref: `signal:${s.id}`,
      key: keys.get(s.id) ?? null,
      kind: s.type,
      title: s.text,
      detail: null,
      dueAt: s.due_at,
      dueState: s.status === "open" ? dueState(s.due_at, now) : null,
      href: link.href,
      evidenceLabel: link.label,
      evidenceKind: link.kind,
      review: reviewOf(s.review_verdict, model(s.reviewed_by_model), s.review_score),
      producedBy: model(s.produced_by_model),
      status: s.status,
      at: s.created_at,
      route: routeFor(s.message_id),
    };
    if (s.status !== "open" || s.type === "decision") {
      doneAll.get(s.project_id)!.push(card);
    } else if (s.type === "their_commitment") {
      lane.columns.on_client.push(card);
    } else {
      lane.columns.on_us.push(card);
    }
  }

  for (const a of actions) {
    const lane = a.project_id ? lanes.get(a.project_id) : triage;
    if (!lane) continue;
    let payload: { to?: string[]; subject?: string; body?: string; title?: string; suggested_name?: string } = {};
    try {
      payload = JSON.parse(a.payload_json);
    } catch {
      // keep empty
    }
    const link = evidenceLinkFor(parseEvidence(a.evidence_json)[0], textFor, nameFor, a.message_id);
    const title =
      a.type === "draft_reply"
        ? payload.subject || "Draft reply"
        : a.type === "internal_task"
          ? payload.title || "Internal task"
          : `New project? ${payload.suggested_name ?? ""}`.trim();
    const card: BoardCard = {
      id: a.id,
      ref: `action:${a.id}`,
      key: keys.get(a.id) ?? null,
      kind: a.type,
      title,
      detail: a.type === "draft_reply" && payload.to?.length ? `To ${payload.to.join(", ")}` : null,
      dueAt: null,
      dueState: null,
      href: link.href,
      evidenceLabel: link.label,
      evidenceKind: link.kind,
      review: reviewOf(a.review_verdict, model(a.reviewed_by_model), a.review_score),
      producedBy: model(a.produced_by_model),
      status: a.status === "failed" ? `failed: ${a.error ?? "unknown error"}` : a.status,
      at: a.decided_at ?? a.created_at,
      route: routeFor(a.message_id),
    };
    // Approved/edited wait here until the executor creates the draft; failures stay visible to retry.
    if (a.status === "proposed" || a.status === "approved" || a.status === "edited" || a.status === "failed") lane.columns.approval.push(card);
    else if (a.project_id) doneAll.get(a.project_id)!.push(card);
  }

  for (const m of mail) {
    const lane = m.project_id ? lanes.get(m.project_id) : triage;
    if (!lane) continue;
    const from = m.sender_name || m.sender_email || "unknown sender";
    lane.columns.triage.push({
      id: m.id,
      ref: `email:${m.id}`,
      key: null,
      kind: "email",
      title: m.subject || "(no subject)",
      detail: m.project_id ? from : `${from}${m.guessed_client ? ` · likely ${m.guessed_client}` : ""}`,
      dueAt: null,
      dueState: null,
      href: `/messages/${encodeURIComponent(m.id)}`,
      evidenceLabel: null,
      evidenceKind: null,
      review: null,
      producedBy: null,
      status: m.status === "failed" ? `failed: ${m.error ?? "unknown error"}` : m.status,
      at: m.received_at,
      route: routeFor(m.id),
    });
  }

  const byDue = (a: BoardCard, b: BoardCard) =>
    (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) || b.at.localeCompare(a.at);
  const byRecent = (a: BoardCard, b: BoardCard) => b.at.localeCompare(a.at);

  for (const lane of lanes.values()) {
    lane.columns.on_us.sort(byDue);
    lane.columns.on_client.sort(byDue);
    lane.columns.approval.sort(byRecent);
    const done = doneAll.get(lane.id)!.sort(byRecent);
    lane.doneTotal = done.length;
    lane.columns.done = done.slice(0, DONE_CAP);

    const openCards = [...lane.columns.on_us, ...lane.columns.on_client];
    lane.stats.open = openCards.length;
    lane.stats.overdue = openCards.filter((c) => c.dueState === "overdue").length;
    lane.stats.dueSoon = openCards.filter((c) => c.dueState === "soon").length;
    lane.stats.approvals = lane.columns.approval.length;
    // Overdue work can't be "on track", whatever the stored health says.
    if (lane.stats.overdue > 0 && lane.health === "on_track") lane.health = "at_risk";
    lane.attention =
      HEALTH_RANK[lane.health] * 100 + lane.stats.overdue * 10 + lane.stats.dueSoon * 5 + lane.stats.approvals * 3 + lane.stats.open;
  }
  triage.stats.approvals = triage.columns.approval.length;
  triage.stats.open = triage.columns.triage.length;

  const groups = new Map<string, ClientGroup>();
  for (const p of projects) {
    const lane = lanes.get(p.id)!;
    if (filter === "attention" && lane.health === "on_track" && lane.stats.approvals === 0 && lane.stats.dueSoon === 0) {
      continue;
    }
    let g = groups.get(p.client_id);
    if (!g) {
      let domains: string[] = [];
      try {
        domains = JSON.parse(p.domains_json);
      } catch {
        // keep empty
      }
      g = { id: p.client_id, name: p.client_name, domains, health: "on_track", lanes: [] };
      groups.set(p.client_id, g);
    }
    g.lanes.push(lane);
    if (HEALTH_RANK[lane.health] > HEALTH_RANK[g.health]) g.health = lane.health;
  }
  const clients = [...groups.values()];
  for (const g of clients) g.lanes.sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name));
  const clientAttention = (g: ClientGroup) => Math.max(...g.lanes.map((l) => l.attention));
  clients.sort((a, b) => clientAttention(b) - clientAttention(a) || a.name.localeCompare(b.name));

  const all = [...lanes.values()];
  return {
    triage: triage.columns.triage.length || triage.columns.approval.length ? triage : null,
    clients,
    totals: {
      projects: all.length,
      open: all.reduce((n, l) => n + l.stats.open, 0),
      overdue: all.reduce((n, l) => n + l.stats.overdue, 0),
      approvals: all.reduce((n, l) => n + l.stats.approvals, 0) + triage.stats.approvals,
      blockedByReview: all.reduce((n, l) => n + l.stats.blockedByReview, 0),
      atRisk: all.filter((l) => l.health !== "on_track").length,
    },
  };
}

/**
 * Sidebar: clients with their worst project health, derived exactly as the board does
 * (so an overdue item turns the dot amber here too). Small tables; fine on every page.
 */
export function listClientsForNav(db: DB): { id: string; name: string; projects: number; health: Health }[] {
  return getBoard(db)
    .clients.map((g) => ({ id: g.id, name: g.name, projects: g.lanes.length, health: g.health }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
