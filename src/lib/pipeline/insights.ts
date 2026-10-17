/**
 * Insights and health (PRD F4, P0): three deterministic rules over the stored signals,
 * then each project's health. No model calls, so it runs after every pipeline pass,
 * with or without an API key, and gives the same answer every time.
 *
 *   unanswered_ask          an open client ask, older than ASK_SLA_HOURS, with no reply
 *                           from us later in the thread. High once the ask is past due.
 *   deadline_no_commitment  an open deadline (or ask with a due date) inside the next
 *                           48 h, and no commitment from us on the project since it came
 *                           in. High inside 24 h or once past due.
 *   overdue_commitment      something we committed to whose due date has passed. Always high.
 *
 * Health: any open high insight -> blocked; any open medium -> at_risk; else on_track.
 * Model-made insights (Reason) count toward health too; dismissed ones don't.
 *
 * Each rule insight is keyed "<kind>:<signal id>": a rerun refreshes it rather than adding
 * a copy, a condition that stops holding marks it resolved, and a person's dismissal sticks.
 */
import { randomUUID } from "node:crypto";
import { audit, type DB } from "../db";

export const RULE_MODEL = "rule";
const HOUR = 3600 * 1000;
const DEADLINE_WINDOW_MS = 48 * HOUR;
const URGENT_MS = 24 * HOUR;

export type Severity = "low" | "medium" | "high";
export type Health = "on_track" | "at_risk" | "blocked";
export type RuleKind = "unanswered_ask" | "deadline_no_commitment" | "overdue_commitment";

export function askSlaHours(): number {
  const n = Number(process.env.ASK_SLA_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

export interface RuleHit {
  key: string;
  kind: RuleKind;
  projectId: string;
  signalId: string;
  severity: Severity;
  text: string;
  suggestedAction: string;
  evidenceJson: string;
}

interface SignalRow {
  id: string;
  project_id: string;
  message_id: string | null;
  type: string;
  text: string;
  due_at: string | null;
  evidence_json: string;
  created_at: string;
  received_at: string | null;
  thread_id: string | null;
  sender_email: string | null;
  account: string | null;
}

const quoteText = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);
const time = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/** Signals plus the message each came from (when it came, which thread, who sent it). */
function openSignals(db: DB): SignalRow[] {
  return db
    .prepare(
      `SELECT s.id, s.project_id, s.message_id, s.type, s.text, s.due_at, s.evidence_json, s.created_at,
              m.received_at, m.thread_id, m.sender_email, m.account
         FROM signals s
         JOIN projects p ON p.id = s.project_id AND p.status != 'archived'
         LEFT JOIN messages m ON m.gmail_message_id = s.message_id
        WHERE s.status = 'open'`,
    )
    .all() as unknown as SignalRow[];
}

/** Did we write anything in this thread after `afterIso`? Ours = sent from the inbox's own address or labeled SENT. */
function weRepliedSince(db: DB, threadId: string, afterIso: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages
        WHERE thread_id = ? AND received_at > ?
          AND (lower(sender_email) = lower(account) OR label_ids LIKE '%"SENT"%')
        LIMIT 1`,
    )
    .get(threadId, afterIso);
  return !!row;
}

/** Any commitment from us on this project made at or after `sinceIso`? */
function weCommittedSince(db: DB, projectId: string, sinceIso: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM signals s LEFT JOIN messages m ON m.gmail_message_id = s.message_id
        WHERE s.project_id = ? AND s.type = 'our_commitment' AND s.status != 'superseded'
          AND COALESCE(m.received_at, s.created_at) >= ?
        LIMIT 1`,
    )
    .get(projectId, sinceIso);
  return !!row;
}

/** Evaluate the three rules. Pure read: returns what should be open right now. */
export function evaluateRules(db: DB, now: Date = new Date()): RuleHit[] {
  const t = now.getTime();
  const sla = askSlaHours();
  const hits: RuleHit[] = [];
  const signals = openSignals(db);

  for (const s of signals) {
    const due = time(s.due_at);
    const hasDue = !Number.isNaN(due);
    const base = { projectId: s.project_id, signalId: s.id, evidenceJson: s.evidence_json };
    const from = s.received_at ?? s.created_at;
    const fromUs = !!s.sender_email && !!s.account && s.sender_email.toLowerCase() === s.account.toLowerCase();

    // 1. Client ask with no reply from us after SLA hours.
    if (s.type === "ask" && !fromUs) {
      const ageMs = t - time(from);
      if (ageMs >= sla * HOUR && !(s.thread_id && weRepliedSince(db, s.thread_id, from))) {
        const pastDue = hasDue && due < t;
        hits.push({
          ...base,
          key: `unanswered_ask:${s.id}`,
          kind: "unanswered_ask",
          severity: pastDue ? "high" : "medium",
          text: `No reply in ${Math.floor(ageMs / HOUR)}h to: "${quoteText(s.text)}"`,
          suggestedAction: pastDue ? "Reply today: this ask is past due." : "Reply or acknowledge, even if the full answer comes later.",
        });
      }
    }

    // 2. Deadline inside 48 h with no commitment from us since it arrived.
    if ((s.type === "deadline" || s.type === "ask") && hasDue && due - t <= DEADLINE_WINDOW_MS && !weCommittedSince(db, s.project_id, from)) {
      const urgent = due - t <= URGENT_MS;
      hits.push({
        ...base,
        key: `deadline_no_commitment:${s.id}`,
        kind: "deadline_no_commitment",
        severity: urgent ? "high" : "medium",
        text: `${due < t ? "Deadline passed" : "Due within 48h"} and nobody has committed: "${quoteText(s.text)}"`,
        suggestedAction: "Confirm an owner and a date with the client.",
      });
    }

    // 3. Our own commitment, past due.
    if (s.type === "our_commitment" && hasDue && due < t) {
      const days = Math.max(1, Math.floor((t - due) / (24 * HOUR)));
      hits.push({
        ...base,
        key: `overdue_commitment:${s.id}`,
        kind: "overdue_commitment",
        severity: "high",
        text: `We're ${days} day${days === 1 ? "" : "s"} late on: "${quoteText(s.text)}"`,
        suggestedAction: "Deliver it, or send the client a new date and the reason.",
      });
    }
  }
  return hits;
}

export function healthFrom(severities: Iterable<string>): Health {
  let worst: Health = "on_track";
  for (const s of severities) {
    if (s === "high") return "blocked";
    if (s === "medium") worst = "at_risk";
  }
  return worst;
}

export interface InsightsResult {
  opened: number;
  updated: number;
  resolved: number;
  health: { project: string; from: Health; to: Health }[];
}

/**
 * Apply the rules to the insights table and recompute project health. Idempotent:
 * running it twice in a row changes nothing the second time.
 */
export function runInsights(db: DB, opts: { now?: Date } = {}): InsightsResult {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const out: InsightsResult = { opened: 0, updated: 0, resolved: 0, health: [] };

  db.transaction(() => {
    const hits = evaluateRules(db, now);
    const live = new Set(hits.map((h) => h.key));

    const existing = new Map(
      (db.prepare(`SELECT id, rule_key, status, severity, text FROM insights WHERE rule_key IS NOT NULL`).all() as {
        id: string; rule_key: string; status: string; severity: string; text: string;
      }[]).map((r) => [r.rule_key, r]),
    );
    // Reason may already have flagged the same thing from the same email; don't show it twice.
    const modelDup = db.prepare(
      `SELECT 1 FROM insights WHERE project_id = ? AND kind = ? AND produced_by_model != ? AND status = 'open'
          AND evidence_json LIKE ? LIMIT 1`,
    );
    const msgOf = db.prepare(`SELECT message_id FROM signals WHERE id = ?`);

    for (const h of hits) {
      const row = existing.get(h.key);
      if (row) {
        // Dismissed stays dismissed; resolved comes back if the condition holds again.
        if (row.status === "dismissed") continue;
        if (row.status === "resolved" || row.severity !== h.severity || row.text !== h.text) {
          db.prepare(`UPDATE insights SET status = 'open', severity = ?, text = ?, suggested_action = ?, resolved_at = NULL WHERE id = ?`).run(
            h.severity, h.text, h.suggestedAction, row.id,
          );
          if (row.status === "resolved") {
            audit(db, RULE_MODEL, "insight.reopened", `insight:${row.id}`, { kind: h.kind, severity: h.severity });
            out.opened++;
          } else out.updated++;
        }
        continue;
      }
      const messageId = (msgOf.get(h.signalId) as { message_id: string | null } | undefined)?.message_id;
      if (messageId && modelDup.get(h.projectId, h.kind, RULE_MODEL, `%"message_id":"${messageId}"%`)) continue;
      const id = randomUUID();
      db.prepare(
        `INSERT INTO insights (id, project_id, kind, severity, text, suggested_action, status, evidence_json, produced_by_model, rule_key, signal_id)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      ).run(id, h.projectId, h.kind, h.severity, h.text, h.suggestedAction, h.evidenceJson, RULE_MODEL, h.key, h.signalId);
      audit(db, RULE_MODEL, "insight.opened", `insight:${id}`, { kind: h.kind, severity: h.severity, signal: h.signalId });
      out.opened++;
    }

    for (const [key, row] of existing) {
      if (row.status !== "open" || live.has(key)) continue;
      db.prepare(`UPDATE insights SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(nowIso, row.id);
      audit(db, RULE_MODEL, "insight.resolved", `insight:${row.id}`, { key });
      out.resolved++;
    }

    // Health from every open insight, rule-made or model-made.
    const projects = db.prepare(`SELECT id, health FROM projects WHERE status != 'archived'`).all() as { id: string; health: Health }[];
    const sev = db.prepare(`SELECT severity FROM insights WHERE project_id = ? AND status = 'open'`);
    for (const p of projects) {
      const next = healthFrom((sev.all(p.id) as { severity: string }[]).map((r) => r.severity));
      if (next === p.health) continue;
      db.prepare(`UPDATE projects SET health = ? WHERE id = ?`).run(next, p.id);
      audit(db, RULE_MODEL, "project.health_changed", `project:${p.id}`, { from: p.health, to: next });
      out.health.push({ project: p.id, from: p.health, to: next });
    }
  })();
  return out;
}

/** A person closes an insight from the drawer. Rule insights stay closed on later runs. */
export function dismissInsight(db: DB, id: string, by: string, reason?: string): boolean {
  const r = db.prepare(`UPDATE insights SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'open'`).run(new Date().toISOString(), id);
  if (!r.changes) return false;
  audit(db, by, "insight.dismissed", `insight:${id}`, reason ? { reason } : undefined);
  runInsights(db); // health may drop now
  return true;
}
