/**
 * One full cycle of the headless workflow, shared by the worker loop, "Sync now"
 * on the dashboard, and `npm run pipeline`:
 *
 *   seed (empty DB only) -> Gmail sync -> Extract -> Resolve -> Reason -> Review -> Executor
 *
 * The pipeline half runs under a lease in app_settings, so the worker and the web app
 * (separate processes on the same SQLite file) never process the same email twice or
 * pay for the same model call twice.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import { draftApiFor, listAccounts } from "./gmail/client";
import { syncAll } from "./ingest/sync";
import { runExecutor, type ExecuteResult } from "./pipeline/execute";
import { recoverInterrupted } from "./pipeline/review";
import { defaultDeps, runPipeline, type PipelineDeps, type PipelineResult } from "./pipeline/run";
import { applySeed, readSeed } from "./seed";

const LOCK_KEY = "pipeline.lock";
const LEASE_MS = 15 * 60_000;

/** Loads seed/seed.json (clients, projects, model profiles) when the DB has no clients yet. */
export function ensureSeeded(db: DB): string[] | null {
  if (db.prepare(`SELECT 1 FROM clients LIMIT 1`).get()) return null;
  return applySeed(db, readSeed());
}

/** Takes the pipeline lease, or returns null if another process holds a live one. */
export function acquirePipelineLock(db: DB, owner: string, now = Date.now()): string | null {
  const token = `${owner}:${randomUUID()}`;
  const r = db
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE CAST(json_extract(app_settings.value, '$.until') AS INTEGER) < ?`,
    )
    .run(LOCK_KEY, JSON.stringify({ token, until: now + LEASE_MS }), now);
  return Number(r.changes) ? token : null;
}

export function releasePipelineLock(db: DB, token: string): void {
  db.prepare(`DELETE FROM app_settings WHERE key = ? AND json_extract(value, '$.token') = ?`).run(LOCK_KEY, token);
}

/** True while some process is running the pipeline (for the dashboard's status line). */
export function pipelineBusy(db: DB, now = Date.now()): boolean {
  const r = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(LOCK_KEY) as { value: string } | undefined;
  if (!r) return false;
  try {
    return (JSON.parse(r.value) as { until: number }).until > now;
  } catch {
    return false;
  }
}

export type PipelineOutcome =
  | { ran: true; pipeline: PipelineResult; executor: ExecuteResult }
  | { ran: false; reason: "busy" };

/** Extract -> Resolve -> Reason -> Review -> Executor over everything waiting, under the lease. */
export async function processWaiting(db: DB, owner: string, deps: PipelineDeps = defaultDeps()): Promise<PipelineOutcome> {
  const token = acquirePipelineLock(db, owner);
  if (!token) return { ran: false, reason: "busy" };
  try {
    // Holding the lease means nobody else is mid-run: anything left "reasoning"/"reviewing" was interrupted.
    recoverInterrupted(db);
    // Loop until nothing moves: each stage takes a batch, and a big inbox needs several.
    let pipeline = await runPipeline(db, deps);
    for (let i = 0; i < 10 && moved(pipeline); i++) {
      const next = await runPipeline(db, deps);
      if (!moved(next)) break;
      pipeline = merge(pipeline, next);
    }
    const executor = await runExecutor(db, draftApiFor(db));
    return { ran: true, pipeline, executor };
  } finally {
    releasePipelineLock(db, token);
  }
}

function moved(r: PipelineResult): boolean {
  return !!(
    (r.extract?.messages ?? 0) ||
    r.resolve.assigned.length ||
    r.resolve.inherited ||
    r.resolve.cards.length ||
    (r.reasonReview?.reasoned ?? 0) ||
    (r.reasonReview?.reviewed ?? 0)
  );
}

function merge(a: PipelineResult, b: PipelineResult): PipelineResult {
  return {
    extract:
      a.extract && b.extract
        ? { messages: a.extract.messages + b.extract.messages, attachments: a.extract.attachments + b.extract.attachments, failed: [...a.extract.failed, ...b.extract.failed] }
        : (a.extract ?? b.extract),
    resolve: {
      ...b.resolve,
      assigned: [...a.resolve.assigned, ...b.resolve.assigned],
      inherited: a.resolve.inherited + b.resolve.inherited,
      cards: [...a.resolve.cards, ...b.resolve.cards],
      failed: [...a.resolve.failed, ...b.resolve.failed],
    },
    reasonReview:
      a.reasonReview && b.reasonReview
        ? {
            reasoned: a.reasonReview.reasoned + b.reasonReview.reasoned,
            reviewed: a.reasonReview.reviewed + b.reasonReview.reviewed,
            failed: [...a.reasonReview.failed, ...b.reasonReview.failed],
            perMessage: [...a.reasonReview.perMessage, ...b.reasonReview.perMessage],
          }
        : (a.reasonReview ?? b.reasonReview),
  };
}

export interface CycleResult {
  seeded: string[] | null;
  sync: Awaited<ReturnType<typeof syncAll>>;
  outcome: PipelineOutcome;
}

/** Everything, in order. The worker calls this every poll. */
export async function runCycle(db: DB, owner: string, deps?: PipelineDeps): Promise<CycleResult> {
  const seeded = ensureSeeded(db);
  const sync = listAccounts(db).length ? await syncAll(db) : [];
  const outcome = await processWaiting(db, owner, deps);
  return { seeded, sync, outcome };
}
