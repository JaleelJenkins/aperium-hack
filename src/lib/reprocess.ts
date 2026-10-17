/**
 * Back to the 15 seed emails, processed once. Keeps one stored copy of each seed
 * email (matched by its fixed Message-ID), removes any other mail from the database
 * (it stays in Gmail), clears everything the pipeline produced, and puts the seed
 * emails back in the queue so the next Sync now / worker pass runs Reason and Review
 * on each exactly once. Clients, projects, summaries and review rules are kept.
 */
import type { DB } from "./db";
import { audit } from "./db";
import { removeMessages, type RemovableMessage } from "./ingest/remove";
import { runInsights } from "./pipeline/insights";

const SEED_ID = /^<seed\.([^@>]+)@northbeam\.seed>$/;

export interface ReprocessPlan {
  keep: { id: string; key: string; subject: string | null }[];
  remove: (RemovableMessage & { why: "not a seed email" | "duplicate copy" })[];
  outputs: { signals: number; insights: number; actions: number; reviews: number; runs: number };
}

const count = (db: DB, sql: string) => (db.prepare(sql).get() as { n: number }).n;

export function planReprocess(db: DB): ReprocessPlan {
  const rows = db
    .prepare(`SELECT gmail_message_id AS id, sender_email, subject, thread_id, rfc_message_id FROM messages ORDER BY received_at, gmail_message_id`)
    .all() as (RemovableMessage & { rfc_message_id: string | null })[];
  const seen = new Set<string>();
  const plan: ReprocessPlan = {
    keep: [],
    remove: [],
    outputs: {
      signals: count(db, `SELECT COUNT(*) AS n FROM signals`),
      insights: count(db, `SELECT COUNT(*) AS n FROM insights`),
      actions: count(db, `SELECT COUNT(*) AS n FROM actions`),
      reviews: count(db, `SELECT COUNT(*) AS n FROM model_reviews`),
      runs: count(db, `SELECT COUNT(*) AS n FROM pipeline_runs`),
    },
  };
  for (const r of rows) {
    const key = SEED_ID.exec(r.rfc_message_id ?? "")?.[1];
    const m = { id: r.id, sender_email: r.sender_email, subject: r.subject, thread_id: r.thread_id };
    if (!key) plan.remove.push({ ...m, why: "not a seed email" });
    else if (seen.has(key)) plan.remove.push({ ...m, why: "duplicate copy" });
    else {
      seen.add(key);
      plan.keep.push({ id: r.id, key, subject: r.subject });
    }
  }
  return plan;
}

export function applyReprocess(db: DB, plan: ReprocessPlan, opts: { dataDir?: string } = {}): void {
  removeMessages(db, plan.remove, opts);
  db.transaction(() => {
    for (const t of ["signals", "insights", "actions", "model_reviews", "pipeline_runs"]) db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM route_decisions WHERE source = 'pipeline'`);
    db.exec(`DELETE FROM pipeline_batches`); // the board's run panel starts fresh too
    db.exec(`DELETE FROM app_settings WHERE key = 'pipeline.lock'`);
    // Filed threads with their attachments read go straight back to Reason; anything else restarts at Extract.
    db.exec(`
      UPDATE messages SET error = NULL, status = CASE
        WHEN (SELECT project_id FROM threads t WHERE t.gmail_thread_id = messages.thread_id) IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.gmail_message_id
                          AND a.kind IN ('pdf', 'image') AND a.status = 'stored')
        THEN 'resolved' ELSE 'ingested' END`);
    db.exec(`UPDATE review_rules SET hits = 0, last_hit_at = NULL`);
    audit(db, "user", "pipeline.reprocess", null, { kept: plan.keep.length, removed: plan.remove.length, cleared: plan.outputs });
    // Insights are gone, so health must drop back too, not wait for the next pipeline run.
    runInsights(db);
  })();
}
