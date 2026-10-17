/**
 * Server side of the pair router: settings, per-project policy, the leaderboard
 * (measured eval_runs rows replace illustrative seed rows), routing a stored message,
 * and recording decisions for the dry-run / pipeline.
 */
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { audit, type DB } from "../db";
import { finalizePairs, SEED_PAIR_ROWS, type SeedRow } from "./leaderboard";
import { inspectEmailPayloadForRouting, selectOptimalModelPair } from "./pairRouter";
import type { ModelId, ModelPairBenchmark, RoutingContext, RoutingDecision, RoutingPolicyMode, TrapId, TrapResult } from "./types";
import { POLICY_MODES, TRAP_IDS } from "./types";

const isPolicy = (v: unknown): v is RoutingPolicyMode => typeof v === "string" && (POLICY_MODES as string[]).includes(v);

// ---------------------------------------------------------------- settings

export interface RouterSettings {
  defaultPolicy: RoutingPolicyMode;
  pinnedPairId: string;
}

const DEFAULT_PINNED = "haiku-sonnet";

export const getRouterSettings = cache((db: DB): RouterSettings => {
  const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'router.%'`).all() as { key: string; value: string }[];
  const kv = new Map(rows.map((r) => [r.key, r.value]));
  const policy = kv.get("router.default_policy");
  return {
    defaultPolicy: isPolicy(policy) ? policy : "pareto_auto",
    pinnedPairId: kv.get("router.pinned_pair_id") ?? DEFAULT_PINNED,
  };
});

function setSetting(db: DB, key: string, value: string) {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function setDefaultPolicy(db: DB, mode: RoutingPolicyMode) {
  if (!isPolicy(mode)) throw new Error(`Unknown policy ${mode}`);
  setSetting(db, "router.default_policy", mode);
  audit(db, "user", "router.default_policy", null, { mode });
}

/** "Promote to default router": pin this pair globally. */
export function promotePair(db: DB, pairId: string) {
  const pair = getLeaderboard(db).find((p) => p.id === pairId);
  if (!pair) throw new Error(`Unknown pair ${pairId}`);
  if (!pair.available) throw new Error(`${pair.label} has no provider adapter yet`);
  db.transaction(() => {
    setSetting(db, "router.pinned_pair_id", pairId);
    setSetting(db, "router.default_policy", "pinned");
  })();
  audit(db, "user", "router.promoted", `pair:${pairId}`);
}

// ---------------------------------------------------------------- per-project policy

export interface ProjectRouting {
  projectId: string;
  /** What the project actually routes with (its own policy, or the inherited default). */
  policy: RoutingPolicyMode;
  pinnedPairId: string;
  inherited: boolean;
}

export function projectRouting(db: DB, projectId: string | null, settings = getRouterSettings(db)): ProjectRouting {
  const row = projectId
    ? (db.prepare(`SELECT routing_policy, pinned_pair_id FROM projects WHERE id = ?`).get(projectId) as
        | { routing_policy: string | null; pinned_pair_id: string | null }
        | undefined)
    : undefined;
  const own = isPolicy(row?.routing_policy) ? row!.routing_policy : null;
  return {
    projectId: projectId ?? "triage",
    policy: own ?? settings.defaultPolicy,
    pinnedPairId: row?.pinned_pair_id ?? settings.pinnedPairId,
    inherited: own === null,
  };
}

/** mode = null clears the override so the project inherits the global default. */
export function setProjectPolicy(db: DB, projectId: string, mode: RoutingPolicyMode | null, pinnedPairId?: string | null) {
  if (mode !== null && !isPolicy(mode)) throw new Error(`Unknown policy ${mode}`);
  const res = db
    .prepare(`UPDATE projects SET routing_policy = ?, pinned_pair_id = ? WHERE id = ?`)
    .run(mode, mode === "pinned" ? (pinnedPairId ?? DEFAULT_PINNED) : null, projectId);
  if (!res.changes) throw new Error(`Unknown project ${projectId}`);
  audit(db, "user", "router.project_policy", `project:${projectId}`, { mode, pinnedPairId });
}

// ---------------------------------------------------------------- leaderboard

/**
 * metrics_json contract for eval_runs rows the eval runner writes. A row only replaces the
 * illustrative seed row for its pair when every field is present.
 */
export interface EvalRunMetrics {
  raw_reason_accuracy: number;
  verified_accuracy: number;
  signal_recall: number;
  latency_p50_ms: number;
  cost_per_email_usd: number;
  trap_matrix: Record<TrapId, TrapResult>;
}

const PAIR_ID_FOR: Record<string, string> = {
  "claude-haiku|claude-sonnet": "haiku-sonnet",
  "claude-sonnet|claude-opus": "sonnet-opus",
  "claude-haiku|claude-haiku": "haiku-haiku",
  "gemini-flash|claude-haiku": "flash-haiku",
};

function measuredRows(db: DB): Map<string, SeedRow & { source: "measured"; measuredAt: string }> {
  const rows = db
    .prepare(
      `SELECT reason_profile_id, review_profile_id, finished_at, metrics_json FROM eval_runs
        WHERE finished_at IS NOT NULL AND metrics_json IS NOT NULL ORDER BY finished_at`,
    )
    .all() as { reason_profile_id: string; review_profile_id: string; finished_at: string; metrics_json: string }[];
  const out = new Map<string, SeedRow & { source: "measured"; measuredAt: string }>();
  for (const r of rows) {
    let m: Partial<EvalRunMetrics>;
    try {
      m = JSON.parse(r.metrics_json);
    } catch {
      continue;
    }
    const complete =
      [m.raw_reason_accuracy, m.verified_accuracy, m.signal_recall, m.latency_p50_ms, m.cost_per_email_usd].every((v) => typeof v === "number") &&
      m.trap_matrix &&
      TRAP_IDS.every((id) => m.trap_matrix?.[id]?.outcome);
    if (!complete) continue;
    const key = `${r.reason_profile_id}|${r.review_profile_id}`;
    const id = PAIR_ID_FOR[key] ?? key.replace(/claude-/g, "").replace("|", "-");
    out.set(id, {
      id,
      reasonModel: r.reason_profile_id as ModelId,
      reviewModel: r.review_profile_id as ModelId,
      rawReasonAccuracy: m.raw_reason_accuracy!,
      verifiedAccuracy: m.verified_accuracy!,
      signalRecall: m.signal_recall!,
      avgLatencyMs: m.latency_p50_ms!,
      costPer1kEmailsUsd: m.cost_per_email_usd! * 1000,
      trapMatrix: m.trap_matrix!,
      source: "measured",
      measuredAt: r.finished_at, // ordered by finished_at, so the latest run per pair wins
    });
  }
  return out;
}

/** Illustrative seed rows, with any fully measured pair replacing its seed row. */
export const getLeaderboard = cache((db: DB): ModelPairBenchmark[] => {
  const measured = measuredRows(db);
  const rows = SEED_PAIR_ROWS.map((r) => measured.get(r.id) ?? r);
  for (const [id, r] of measured) if (!SEED_PAIR_ROWS.some((s) => s.id === id)) rows.push(r);
  return finalizePairs(rows);
});

// ---------------------------------------------------------------- routing a stored message

const getOurAddresses = cache((db: DB): string[] => [
  ...(db.prepare(`SELECT email FROM gmail_accounts`).all() as { email: string }[]).map((r) => r.email),
  ...(db.prepare(`SELECT DISTINCT account FROM threads`).all() as { account: string }[]).map((r) => r.account),
]);

const getContactsByClient = cache((db: DB): Map<string, string[]> => {
  const rows = db.prepare(`SELECT email, client_id FROM contacts`).all() as { email: string; client_id: string }[];
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.client_id) ?? [];
    list.push(r.email);
    map.set(r.client_id, list);
  }
  return map;
});

interface MessageRow {
  id: string;
  sender_email: string | null;
  raw_text: string;
  project_id: string | null;
  project_name: string | null;
  client_domains: string | null;
  client_id: string | null;
}

/** Builds the RoutingContext for a stored message (attachments, keywords, sender, project policy). */
export function contextForMessage(
  db: DB,
  messageId: string,
  settings = getRouterSettings(db),
): { ctx: RoutingContext; projectId: string | null } | null {
  const m = db
    .prepare(
      `SELECT m.gmail_message_id AS id, m.sender_email, m.raw_text, t.project_id, p.name AS project_name,
              c.domains_json AS client_domains, c.id AS client_id
         FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE m.gmail_message_id = ?`,
    )
    .get(messageId) as MessageRow | undefined;
  if (!m) return null;
  const attachments = db.prepare(`SELECT mime_type AS mimeType FROM attachments WHERE message_id = ?`).all(messageId) as { mimeType: string }[];
  const contacts = m.client_id ? (getContactsByClient(db).get(m.client_id) ?? []) : [];
  const ours = getOurAddresses(db);
  let domains: string[] = [];
  try {
    domains = m.client_domains ? JSON.parse(m.client_domains) : [];
  } catch {
    // keep empty
  }
  const routing = projectRouting(db, m.project_id, settings);
  const ctx = inspectEmailPayloadForRouting(
    { senderEmail: m.sender_email, text: m.raw_text, attachments },
    {
      id: routing.projectId,
      name: m.project_name ?? undefined,
      clientDomains: domains,
      knownContacts: contacts,
      ourAddresses: ours,
      policyMode: routing.policy,
      pinnedPairId: routing.pinnedPairId,
    },
  );
  return { ctx, projectId: m.project_id };
}

/** Routes a stored message under the current policies. Doesn't persist. */
export function routeMessage(db: DB, messageId: string, leaderboard = getLeaderboard(db), settings = getRouterSettings(db)): RoutingDecision | null {
  const built = contextForMessage(db, messageId, settings);
  return built ? selectOptimalModelPair(built.ctx, leaderboard) : null;
}

export function recordDecision(db: DB, messageId: string, d: RoutingDecision, opts: { runId: string | null; source: "dry_run" | "pipeline"; projectId: string | null }) {
  db.prepare(
    `INSERT INTO route_decisions (id, run_id, message_id, project_id, policy, pair_id, escalated, triggers_json, reason, est_cost_usd, est_latency_ms, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), opts.runId, messageId, opts.projectId, d.policyApplied, d.selectedPair.id, d.wasEscalated ? 1 : 0,
    JSON.stringify(d.escalationTriggers), d.routingReason, d.estimatedCostUsd, d.estimatedLatencyMs, opts.source,
  );
}

// ---------------------------------------------------------------- dry-run batches

export interface RouteRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  emails: number;
  escalated: number;
  pairs: Record<string, number>;
  triggers: Record<string, number>;
}

export function startDryRun(db: DB): { runId: string; messageIds: string[] } {
  const runId = randomUUID();
  db.prepare(`INSERT INTO route_runs (id, kind) VALUES (?, 'dry_run')`).run(runId);
  const messageIds = (db.prepare(`SELECT gmail_message_id AS id FROM messages ORDER BY received_at`).all() as { id: string }[]).map((r) => r.id);
  return { runId, messageIds };
}

export function dryRunOne(db: DB, runId: string, messageId: string): RoutingDecision | null {
  const run = db.prepare(`SELECT id FROM route_runs WHERE id = ? AND finished_at IS NULL`).get(runId);
  if (!run) throw new Error("Run not found or already finished");
  const built = contextForMessage(db, messageId);
  if (!built) return null;
  const d = selectOptimalModelPair(built.ctx, getLeaderboard(db));
  recordDecision(db, messageId, d, { runId, source: "dry_run", projectId: built.projectId });
  return d;
}

export function finishDryRun(db: DB, runId: string): RouteRunSummary {
  const rows = db.prepare(`SELECT pair_id, escalated, triggers_json FROM route_decisions WHERE run_id = ?`).all(runId) as {
    pair_id: string; escalated: number; triggers_json: string;
  }[];
  const pairs: Record<string, number> = {};
  const triggers: Record<string, number> = {};
  for (const r of rows) {
    pairs[r.pair_id] = (pairs[r.pair_id] ?? 0) + 1;
    for (const t of JSON.parse(r.triggers_json) as string[]) triggers[t] = (triggers[t] ?? 0) + 1;
  }
  const escalated = rows.filter((r) => r.escalated).length;
  db.prepare(
    `UPDATE route_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), emails = ?, escalated = ?, summary_json = ? WHERE id = ?`,
  ).run(rows.length, escalated, JSON.stringify({ pairs, triggers }), runId);
  audit(db, "user", "router.dry_run", `route_run:${runId}`, { emails: rows.length, escalated });
  return latestRun(db)!;
}

export function latestRun(db: DB): RouteRunSummary | null {
  const r = db
    .prepare(`SELECT * FROM route_runs WHERE kind = 'dry_run' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`)
    .get() as { id: string; started_at: string; finished_at: string; emails: number; escalated: number; summary_json: string | null } | undefined;
  if (!r) return null;
  const s = r.summary_json ? (JSON.parse(r.summary_json) as { pairs: Record<string, number>; triggers: Record<string, number> }) : { pairs: {}, triggers: {} };
  return { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, emails: r.emails, escalated: r.escalated, pairs: s.pairs, triggers: s.triggers };
}

/** Per-email decisions of the latest dry-run, for the scoreboard's run table. */
export function runDecisions(db: DB, runId: string) {
  return db
    .prepare(
      `SELECT d.message_id, m.subject, m.sender_email, d.project_id, p.name AS project_name, d.policy, d.pair_id, d.escalated,
              d.triggers_json, d.reason, d.est_cost_usd, d.est_latency_ms
         FROM route_decisions d JOIN messages m ON m.gmail_message_id = d.message_id
         LEFT JOIN projects p ON p.id = d.project_id
        WHERE d.run_id = ? ORDER BY m.received_at`,
    )
    .all(runId) as {
    message_id: string; subject: string | null; sender_email: string | null; project_id: string | null; project_name: string | null;
    policy: RoutingPolicyMode; pair_id: string; escalated: number; triggers_json: string; reason: string; est_cost_usd: number; est_latency_ms: number;
  }[];
}
