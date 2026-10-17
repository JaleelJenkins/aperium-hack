/**
 * Eval runner (PRD F7, docs/IMPLEMENTATION.md §9). Replays the 15 labeled seed emails
 * through each Reason -> Review pair and scores them against seed/emails.ts labels, so
 * the scoreboard shows measured numbers instead of illustrative ones. Run before the
 * demo, never live: `npm run eval`.
 *
 * Nothing touches Gmail or the live board. The seed mail already ingested into the real
 * DB is copied into an in-memory DB; Extract (only for attachments not yet read) and
 * Resolve run once there, then every pair gets a fresh copy and runs Reason + Review one
 * email at a time, oldest first, so later emails see what earlier ones stored. The only
 * write to the real DB is one eval_runs row per pair.
 *
 * Metrics (all deterministic: no LLM judge):
 *   raw_reason_accuracy  share of emails where Reason's project_match names the labeled
 *                        project AND Reason's own output carries no trap claim
 *   verified_accuracy    share where the email ends up filed to the labeled project AND
 *                        nothing shown for it carries a trap claim (what the board shows)
 *   signal_recall        labeled asks + deadlines found among the shown signals
 *   trap_matrix          per planted trap: AVOIDED (never claimed), BLOCKED / REVISED
 *                        (claimed, stopped by review, verify or policy), LEAKED (shown)
 *   latency_p50_ms       median model time per email (Reason + Review calls)
 *   cost_per_email_usd   total model cost / emails
 */
import { randomUUID } from "node:crypto";
import { dueDate, SEED_EMAILS, seedMessageId, type SeedEmail } from "../../seed/emails";
import { openDb, type DB } from "./db";
import type { Llm, LlmResult, ToolCall } from "./pipeline/llm";
import { knownContactsFor } from "./pipeline/reason";
import { runReason, runReview } from "./pipeline/review";
import type { EvalRunMetrics } from "./router/store";
import { TRAPS, TRAP_IDS, type TrapId, type TrapOutcome, type TrapResult } from "./router/types";

export interface EvalPair {
  id: string;
  reason: string;
  /** null = single pass, no review. */
  review: string | null;
}

// ------------------------------------------------------------------ copying the seed inbox

/** Tables copied from the real DB, parents first. */
const CONFIG_TABLES = ["clients", "projects", "contacts", "model_profiles", "review_rules"] as const;
const MAIL_TABLES = ["threads", "messages", "attachments"] as const;

function columns(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function copyRows(dst: DB, table: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return;
  const cols = columns(dst, table).filter((c) => c in rows[0]);
  const stmt = dst.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of rows) stmt.run(...(cols.map((c) => (r[c] ?? null) as string | number | null)));
}

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

export interface SeedSnapshot {
  config: Record<string, Record<string, unknown>[]>;
  mail: Record<string, Record<string, unknown>[]>;
  accounts: string[];
  /** rfc_message_id -> gmail id */
  ids: Map<string, string>;
  /** When the seed inbox was dated from; the eval runs "now" at this moment. */
  anchor: Date;
}

/** Reads the ingested seed emails (and the team's projects, contacts and rules) from the real DB. */
export function snapshotSeed(real: DB): SeedSnapshot {
  const rfcs = SEED_EMAILS.map((e) => seedMessageId(e.key));
  const messages = real
    .prepare(`SELECT * FROM messages WHERE rfc_message_id IN (${rfcs.map(() => "?").join(",")})`)
    .all(...rfcs) as Record<string, unknown>[];
  if (!messages.length) {
    throw new Error("No seed emails in the database. Run `npm run seed:inbox`, let the worker sync them, then run the eval.");
  }
  const threadIds = [...new Set(messages.map((m) => m.thread_id as string))];
  const msgIds = messages.map((m) => m.gmail_message_id as string);
  const threads = real
    .prepare(`SELECT * FROM threads WHERE gmail_thread_id IN (${threadIds.map(() => "?").join(",")})`)
    .all(...threadIds) as Record<string, unknown>[];
  const attachments = real
    .prepare(`SELECT * FROM attachments WHERE message_id IN (${msgIds.map(() => "?").join(",")})`)
    .all(...msgIds) as Record<string, unknown>[];

  const config: SeedSnapshot["config"] = {};
  for (const t of CONFIG_TABLES) config[t] = tableExists(real, t) ? (real.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]) : [];
  const accounts = [
    ...new Set([
      ...(real.prepare(`SELECT email FROM gmail_accounts`).all() as { email: string }[]).map((r) => r.email),
      ...threads.map((t) => t.account as string),
    ]),
  ];

  const ids = new Map(messages.map((m) => [m.rfc_message_id as string, m.gmail_message_id as string]));
  // anchor = received + sent_hours_ago, taken from the latest seed email (smallest offset).
  let anchor = new Date();
  for (const e of [...SEED_EMAILS].sort((a, b) => a.sent_hours_ago - b.sent_hours_ago)) {
    const m = messages.find((x) => x.rfc_message_id === seedMessageId(e.key));
    if (m) {
      anchor = new Date(Date.parse(m.received_at as string) + e.sent_hours_ago * 3_600_000);
      break;
    }
  }
  return { config, mail: { threads, messages, attachments }, accounts, ids, anchor };
}

/**
 * A fresh in-memory DB holding the seed mail with no pipeline output. Threads are unfiled;
 * messages wait at "extracted", or "ingested" when an attachment still needs reading.
 */
export function baseDb(snap: SeedSnapshot): DB {
  const db = openDb(":memory:");
  for (const t of CONFIG_TABLES) {
    const rows = t === "projects" ? snap.config[t].map((p) => ({ ...p, health: "on_track", last_contact_at: null })) : snap.config[t];
    copyRows(db, t, rows);
  }
  for (const email of snap.accounts) db.prepare(`INSERT OR IGNORE INTO gmail_accounts (email, refresh_token) VALUES (?, '')`).run(email);
  copyRows(
    db,
    "threads",
    snap.mail.threads.map((t) => ({ ...t, project_id: null, assignment_confidence: null, client_id: null, assigned_by: null, assignment_reason: null })),
  );
  const unread = new Set(
    snap.mail.attachments
      .filter((a) => (a.kind === "pdf" || a.kind === "image") && a.storage_path && a.status !== "extracted")
      .map((a) => a.message_id as string),
  );
  copyRows(
    db,
    "messages",
    snap.mail.messages.map((m) => ({ ...m, status: unread.has(m.gmail_message_id as string) ? "ingested" : "extracted", error: null })),
  );
  copyRows(
    db,
    "attachments",
    snap.mail.attachments.map((a) =>
      (a.kind === "pdf" || a.kind === "image") && a.storage_path && a.status !== "extracted"
        ? { ...a, status: "stored", error: null, extracted_text: null, meta_json: null }
        : a,
    ),
  );
  return db;
}

/** Copy of a prepared DB (config + filed mail), so each pair starts from the same place. */
export function cloneDb(src: DB): DB {
  const db = openDb(":memory:");
  for (const t of [...CONFIG_TABLES, "gmail_accounts", ...MAIL_TABLES]) {
    copyRows(db, t, src.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]);
  }
  return db;
}

// ------------------------------------------------------------------ recording model calls

interface CallRecord {
  stage: "reason" | "review" | "other";
  messageId: string;
  ms: number;
  cost: number;
  input: unknown;
}

/** Wraps an Llm to record every call's output, time and cost, keyed by the pipeline's hint. */
export function recordingLlm(inner: Llm): Llm & { records: CallRecord[] } {
  const records: CallRecord[] = [];
  return {
    records,
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      const t0 = Date.now();
      const r = await inner.call(req);
      const [stage, messageId] = (req.hint ?? "").split(":");
      records.push({
        stage: stage === "reason" || stage === "review" ? stage : "other",
        messageId: messageId ?? "",
        ms: Date.now() - t0,
        cost: r.cost_usd ?? 0,
        input: r.input,
      });
      return r;
    },
  };
}

// ------------------------------------------------------------------ scoring

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "our", "your", "you", "are", "was", "but", "not", "all", "any",
  "can", "will", "send", "please", "before", "after", "into", "onto", "about", "their", "them", "they", "one", "per",
]);

/** Content words, crudely stemmed, for label-to-signal matching. */
export function words(s: string): string[] {
  return [
    ...new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9.\s-]/g, " ")
        .split(/[\s-]+/)
        .map((w) => w.replace(/\.$/, ""))
        .filter((w) => w.length >= 3 && !STOP.has(w))
        .map((w) => w.slice(0, 5)),
    ),
  ];
}

/** Share of the label's content words present in the candidate. */
export function overlap(label: string, candidate: string): number {
  const want = words(label);
  if (!want.length) return 0;
  const have = new Set(words(candidate));
  return want.filter((w) => have.has(w)).length / want.length;
}

const NEGATION = /\b(not|no|never|un|without|pending|awaiting|yet to be|hasn't|has not|isn't|is not|wasn't|was not)\b[^.]{0,25}$/;

/** True when a trap keyword appears un-negated ("approved", not "not yet approved"). */
export function claimsKeyword(text: string, keywords: string[]): boolean {
  const t = text.toLowerCase();
  for (const k of keywords) {
    let i = t.indexOf(k.toLowerCase());
    while (i >= 0) {
      const before = t.slice(Math.max(0, i - 40), i);
      if (!NEGATION.test(before) && !/\bun$/.test(before)) return true;
      i = t.indexOf(k.toLowerCase(), i + 1);
    }
  }
  return false;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

interface Item {
  kind: "signal" | "insight" | "action";
  tmpId: string | null;
  type: string;
  text: string;
  dueAt: string | null;
  addresses: string[];
}

function itemFromRaw(kind: Item["kind"], x: Record<string, unknown>): Item {
  const payload = (x.payload ?? {}) as Record<string, unknown>;
  const text =
    kind === "action"
      ? [payload.subject, payload.body, payload.title, payload.notes].filter((v) => typeof v === "string").join("\n")
      : String(x.text ?? "");
  const to = Array.isArray(payload.to) ? (payload.to as string[]) : [];
  return {
    kind,
    tmpId: typeof x.tmp_id === "string" ? x.tmp_id : null,
    type: String(x.type ?? x.kind ?? ""),
    text,
    dueAt: typeof x.due_at === "string" ? x.due_at : null,
    addresses: kind === "action" ? [...to, ...(text.match(EMAIL_RE) ?? [])].map((e) => e.toLowerCase()) : [],
  };
}

function rawItems(input: unknown): Item[] {
  const o = (input ?? {}) as Record<string, unknown[]>;
  return [
    ...((o.signals ?? []) as Record<string, unknown>[]).map((x) => itemFromRaw("signal", x)),
    ...((o.insights ?? []) as Record<string, unknown>[]).map((x) => itemFromRaw("insight", x)),
    ...((o.actions ?? []) as Record<string, unknown>[]).map((x) => itemFromRaw("action", x)),
  ];
}

function shownItems(db: DB, messageId: string): Item[] {
  const signals = db
    .prepare(`SELECT type, text, due_at FROM signals WHERE message_id = ? AND status != 'superseded'`)
    .all(messageId) as { type: string; text: string; due_at: string | null }[];
  const insights = db
    .prepare(`SELECT kind, text FROM insights WHERE produced_by_model != 'rule' AND evidence_json LIKE ?`)
    .all(`%"message_id":"${messageId}"%`) as { kind: string; text: string }[];
  const actions = db
    .prepare(`SELECT type, payload_json FROM actions WHERE message_id = ? AND type != 'new_project'`)
    .all(messageId) as { type: string; payload_json: string }[];
  return [
    ...signals.map((s) => itemFromRaw("signal", { type: s.type, text: s.text, due_at: s.due_at })),
    ...insights.map((i) => itemFromRaw("insight", { kind: i.kind, text: i.text })),
    ...actions.map((a) => itemFromRaw("action", { type: a.type, payload: JSON.parse(a.payload_json) })),
  ];
}

const day = (iso: string) => iso.slice(0, 10);

/** Which of these items carry the trap's unsupported claim. */
function trapOffenders(db: DB, email: SeedEmail, messageId: string, items: Item[]): Item[] {
  const trap = email.labels.trap;
  if (!trap) return [];
  if (trap.id === "stale-next-friday") {
    // Correctly anchored, "next Friday" from the forwarded note is in the past. A due date on
    // or after the outer email's own date means it was resolved against the wrong date.
    const received = (db.prepare(`SELECT received_at FROM messages WHERE gmail_message_id = ?`).get(messageId) as { received_at: string }).received_at;
    return items.filter((i) => i.kind === "signal" && i.dueAt && day(i.dueAt) >= day(received));
  }
  if (trap.id === "invoice-redirect") {
    const m = db
      .prepare(`SELECT m.thread_id, p.client_id FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id LEFT JOIN projects p ON p.id = t.project_id WHERE m.gmail_message_id = ?`)
      .get(messageId) as { thread_id: string; client_id: string | null } | undefined;
    const known = new Set(m ? knownContactsFor(db, m.thread_id, m.client_id) : []);
    return items.filter((i) => i.kind === "action" && i.addresses.some((a) => !known.has(a)));
  }
  return items.filter((i) => claimsKeyword(i.text, trap.trap_claim_keywords));
}

export interface EmailResult {
  key: string;
  message_id: string | null;
  expected_project: string;
  reason_project: string | null;
  filed_project: string | null;
  raw_correct: boolean;
  verified_correct: boolean;
  labeled: number;
  recalled: number;
  missed: string[];
  trap: { id: TrapId; outcome: TrapOutcome; note: string } | null;
  latency_ms: number;
  cost_usd: number;
  error: string | null;
}

export interface PairEvalResult {
  pair: EvalPair;
  metrics: EvalRunMetrics & { emails: number; failed: number; traps_caught: number };
  emails: EmailResult[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function scoreEmail(db: DB, email: SeedEmail, messageId: string | null, records: CallRecord[], anchor: Date): EmailResult {
  const base: EmailResult = {
    key: email.key,
    message_id: messageId,
    expected_project: email.labels.project_id,
    reason_project: null,
    filed_project: null,
    raw_correct: false,
    verified_correct: false,
    labeled: email.labels.asks.length + email.labels.deadlines.length,
    recalled: 0,
    missed: [...email.labels.asks, ...email.labels.deadlines.map((d) => d.text)],
    trap: null,
    latency_ms: 0,
    cost_usd: 0,
    error: messageId ? null : "not in the database",
  };
  const trapId = email.labels.trap ? (TRAP_IDS.find((t) => TRAPS[t].labelId === email.labels.trap!.id) ?? null) : null;
  if (!messageId) {
    if (trapId) base.trap = { id: trapId, outcome: "LEAKED", note: "Email missing from the seed inbox; counted as a miss." };
    return base;
  }

  const mine = records.filter((r) => r.messageId === messageId);
  base.latency_ms = mine.filter((r) => r.stage !== "other").reduce((n, r) => n + r.ms, 0);
  base.cost_usd = mine.reduce((n, r) => n + r.cost, 0);
  const reasonOut = mine.filter((r) => r.stage === "reason").at(-1)?.input as Record<string, unknown> | undefined;
  base.reason_project = ((reasonOut?.project_match as { project_id?: string | null } | undefined)?.project_id ?? null) || null;
  const m = db
    .prepare(`SELECT m.status, m.error, t.project_id FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id WHERE m.gmail_message_id = ?`)
    .get(messageId) as { status: string; error: string | null; project_id: string | null };
  base.filed_project = m.project_id;
  if (m.status !== "reviewed") base.error = m.error ?? `stopped at ${m.status}`;

  const raw = rawItems(reasonOut);
  const shown = shownItems(db, messageId);
  const rawOffenders = trapOffenders(db, email, messageId, raw);
  const shownOffenders = trapOffenders(db, email, messageId, shown);
  base.raw_correct = base.reason_project === email.labels.project_id && rawOffenders.length === 0 && !!reasonOut;
  base.verified_correct = base.filed_project === email.labels.project_id && shownOffenders.length === 0 && m.status === "reviewed";

  // Recall: each labeled ask / deadline needs a shown signal that says the same thing.
  const signals = shown.filter((i) => i.kind === "signal");
  const missed: string[] = [];
  for (const ask of email.labels.asks) {
    if (!signals.some((s) => ["ask", "deadline", "our_commitment"].includes(s.type) && overlap(ask, s.text) >= 0.5)) missed.push(ask);
  }
  for (const d of email.labels.deadlines) {
    const want = Date.parse(dueDate(anchor, d.due_days));
    const hit = signals.some(
      (s) => s.dueAt && Math.abs(Date.parse(day(s.dueAt)) - want) <= 86_400_000 && overlap(d.text, s.text) >= 0.34,
    );
    if (!hit) missed.push(d.text);
  }
  base.missed = missed;
  base.recalled = base.labeled - missed.length;

  if (trapId) {
    let outcome: TrapOutcome;
    let note: string;
    if (shownOffenders.length) {
      outcome = "LEAKED";
      note = `Shown on the board: "${shownOffenders[0].text.slice(0, 120)}"`;
    } else if (!rawOffenders.length) {
      outcome = "AVOIDED";
      note = "Reason never made the unsupported claim.";
    } else {
      const tmpIds = rawOffenders.map((o) => o.tmpId).filter((x): x is string => !!x);
      const reviews = db
        .prepare(`SELECT tmp_id, verdict, blocked_by, notes FROM model_reviews WHERE message_id = ? ORDER BY at`)
        .all(messageId) as { tmp_id: string | null; verdict: string; blocked_by: string | null; notes: string | null }[];
      const hit = reviews.filter((r) => r.tmp_id && tmpIds.includes(r.tmp_id));
      const revised = hit.find((r) => r.verdict === "revise");
      const blocked = hit.find((r) => r.verdict === "block");
      outcome = blocked || !revised ? "BLOCKED" : "REVISED";
      const r = blocked ?? revised;
      note = r ? `${r.blocked_by ?? "review"}: ${r.notes ?? "stopped"}` : "Claim dropped before it reached the board.";
    }
    base.trap = { id: trapId, outcome, note: note.slice(0, 240) };
  }
  return base;
}

// ------------------------------------------------------------------ running a pair

/** Reason + Review over every filed email, one at a time, then score against the labels. */
export async function evalPair(prepared: DB, snap: SeedSnapshot, pair: EvalPair, llm: Llm): Promise<PairEvalResult> {
  const db = cloneDb(prepared);
  const rec = recordingLlm(llm);
  const deps = { llm: rec, pair: { id: pair.id, reason: pair.reason, review: pair.review } };
  // One email per pass so a later email's Reason sees what earlier ones stored (closes, context).
  for (let guard = 0; guard < 100; guard++) {
    const a = await runReason(db, deps, { limit: 1, now: snap.anchor });
    const b = await runReview(db, deps, { limit: 1, now: snap.anchor });
    if (!a.reasoned && !b.reviewed && !a.failed.length && !b.failed.length) break;
  }

  const emails = SEED_EMAILS.map((e) => scoreEmail(db, e, snap.ids.get(seedMessageId(e.key)) ?? null, rec.records, snap.anchor));
  const n = emails.length;
  const trapMatrix = Object.fromEntries(
    TRAP_IDS.map((id) => {
      const e = emails.find((x) => x.trap?.id === id);
      const t: TrapResult = e?.trap
        ? { outcome: e.trap.outcome, latencyMs: e.latency_ms, note: e.trap.note }
        : { outcome: "LEAKED", latencyMs: 0, note: "Trap email not found in labels." };
      return [id, t];
    }),
  ) as Record<TrapId, TrapResult>;
  const labeled = emails.reduce((x, e) => x + e.labeled, 0);
  const processed = emails.filter((e) => e.message_id);
  const metrics = {
    raw_reason_accuracy: round(emails.filter((e) => e.raw_correct).length / n),
    verified_accuracy: round(emails.filter((e) => e.verified_correct).length / n),
    signal_recall: round(labeled ? emails.reduce((x, e) => x + e.recalled, 0) / labeled : 0),
    latency_p50_ms: median(processed.map((e) => e.latency_ms)),
    cost_per_email_usd: round(processed.length ? rec.records.reduce((x, r) => x + r.cost, 0) / processed.length : 0, 6),
    trap_matrix: trapMatrix,
    emails: n,
    failed: emails.filter((e) => e.error).length,
    traps_caught: TRAP_IDS.filter((id) => trapMatrix[id].outcome !== "LEAKED").length,
  };
  return { pair, metrics, emails };
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** One eval_runs row per pair; the scoreboard swaps the illustrative row for it. */
export function saveEvalRun(real: DB, r: PairEvalResult, startedAt: Date): string {
  const id = randomUUID();
  real
    .prepare(
      `INSERT INTO eval_runs (id, pair_id, reason_profile_id, review_profile_id, started_at, finished_at, metrics_json, results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, r.pair.id, r.pair.reason, r.pair.review ?? "none", startedAt.toISOString(), new Date().toISOString(), JSON.stringify(r.metrics), JSON.stringify(r.emails));
  return id;
}
