/**
 * Live run log: what `npm run pipeline` prints, recorded per run so the board can
 * show it. Every Sync now (and worker) run is a batch; each email that finishes
 * appends one line (where it was filed, what Reason/Review produced, how long it took),
 * and the batch closes with totals and the wall-clock time.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./db";

export interface EmailOutcome {
  messageId: string;
  /** Filed to a project in this run (or inherited from its thread). */
  filed?: { project: string; by: string; confidence: number | null };
  /** Sent to a "New project?" card instead. */
  card?: boolean;
  counts?: { signals: number; insights: number; actions: number; caught: number; revised: number };
  reasonMs?: number | null;
  reviewMs?: number | null;
  costUsd?: number;
  failed?: string;
}

export interface LogLine {
  id: number;
  at: string;
  kind: "email" | "card" | "failed" | "info";
  messageId: string | null;
  line: string;
  detail: {
    subject?: string | null;
    project?: string | null;
    client?: string | null;
    signals?: number;
    insights?: number;
    actions?: number;
    caught?: number;
    revised?: number;
    reasonMs?: number | null;
    reviewMs?: number | null;
    costUsd?: number;
    by?: string | null;
  } | null;
}

export interface BatchSummary {
  reviewed: number;
  filed: number;
  cards: number;
  failed: number;
  signals: number;
  actions: number;
  caught: number;
  approvals: number;
  costUsd: number;
}

export interface Batch {
  id: string;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  elapsedMs: number | null;
  summary: BatchSummary | null;
  error: string | null;
  lines: LogLine[];
}

const WAITING = `status IN ('ingested', 'extracted', 'resolved', 'reasoning', 'reasoned', 'reviewing')`;

export function startBatch(db: DB, source: string): string {
  const id = randomUUID();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${WAITING}`).get() as { n: number }).n;
  db.prepare(`INSERT INTO pipeline_batches (id, source, started_at, total) VALUES (?, ?, ?, ?)`).run(id, source, new Date().toISOString(), total);
  // Keep the last 20 runs.
  db.prepare(`DELETE FROM pipeline_batches WHERE id NOT IN (SELECT id FROM pipeline_batches ORDER BY started_at DESC LIMIT 20)`).run();
  return id;
}

/** One line per finished email, written as soon as that email is done. */
export function logEmail(db: DB, batchId: string, o: EmailOutcome): void {
  const m = db
    .prepare(
      `SELECT m.subject, p.name AS project, c.name AS client FROM messages m
         JOIN threads t ON t.gmail_thread_id = m.thread_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE m.gmail_message_id = ?`,
    )
    .get(o.messageId) as { subject: string | null; project: string | null; client: string | null } | undefined;
  const subject = m?.subject || "(no subject)";
  let kind: LogLine["kind"] = "email";
  let line: string;
  if (o.failed) {
    kind = "failed";
    line = `${subject}: ${o.failed}`;
  } else if (o.card) {
    kind = "card";
    line = `${subject} → New project? card (no confident match)`;
  } else {
    const c = o.counts;
    const parts = c
      ? [
          c.signals && `${c.signals} signal${c.signals === 1 ? "" : "s"}`,
          c.actions && `${c.actions} to approve`,
          c.caught && `${c.caught} caught`,
          c.revised && `${c.revised} revised`,
        ].filter(Boolean)
      : [];
    line = `${subject} → ${m?.project ?? "filed"}${parts.length ? ` · ${parts.join(", ")}` : c ? " · nothing to act on" : ""}`;
  }
  db.prepare(`INSERT INTO pipeline_log (batch_id, kind, message_id, line, detail_json) VALUES (?, ?, ?, ?, ?)`).run(
    batchId,
    kind,
    o.messageId,
    line,
    JSON.stringify({
      subject: m?.subject ?? null,
      project: m?.project ?? null,
      client: m?.client ?? null,
      ...o.counts,
      reasonMs: o.reasonMs ?? null,
      reviewMs: o.reviewMs ?? null,
      costUsd: o.costUsd ?? 0,
      by: o.filed?.by ?? null,
    }),
  );
  // Done = emails that left the queue (reviewed, carded, failed), counted once each.
  db.prepare(
    `UPDATE pipeline_batches SET done = (SELECT COUNT(DISTINCT message_id) FROM pipeline_log WHERE batch_id = ? AND kind != 'info') WHERE id = ?`,
  ).run(batchId, batchId);
}

export function finishBatch(db: DB, batchId: string, startedMs: number, error?: string): void {
  const rows = db.prepare(`SELECT kind, detail_json FROM pipeline_log WHERE batch_id = ?`).all(batchId) as { kind: string; detail_json: string | null }[];
  const s: BatchSummary = { reviewed: 0, filed: 0, cards: 0, failed: 0, signals: 0, actions: 0, caught: 0, approvals: 0, costUsd: 0 };
  for (const row of rows) {
    const d = row.detail_json ? (JSON.parse(row.detail_json) as LogLine["detail"]) : null;
    if (row.kind === "card") s.cards++;
    else if (row.kind === "failed") s.failed++;
    else if (row.kind === "email") {
      s.filed++;
      if (d?.signals !== undefined) s.reviewed++;
      s.signals += d?.signals ?? 0;
      s.actions += d?.actions ?? 0;
      s.caught += d?.caught ?? 0;
      s.costUsd += d?.costUsd ?? 0;
    }
  }
  s.approvals = (db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE status = 'proposed'`).get() as { n: number }).n;
  db.prepare(`UPDATE pipeline_batches SET finished_at = ?, elapsed_ms = ?, summary_json = ?, error = ? WHERE id = ?`).run(
    new Date().toISOString(),
    Date.now() - startedMs,
    JSON.stringify(s),
    error ?? null,
    batchId,
  );
}

export function latestBatch(db: DB): Batch | null {
  const b = db.prepare(`SELECT * FROM pipeline_batches ORDER BY started_at DESC LIMIT 1`).get() as
    | {
        id: string;
        source: string;
        started_at: string;
        finished_at: string | null;
        total: number;
        done: number;
        elapsed_ms: number | null;
        summary_json: string | null;
        error: string | null;
      }
    | undefined;
  if (!b) return null;
  const lines = (
    db
      .prepare(`SELECT id, at, kind, message_id, line, detail_json FROM pipeline_log WHERE batch_id = ? ORDER BY id DESC LIMIT 60`)
      .all(b.id) as { id: number; at: string; kind: LogLine["kind"]; message_id: string | null; line: string; detail_json: string | null }[]
  ).map((l) => ({
    id: l.id,
    at: l.at,
    kind: l.kind,
    messageId: l.message_id,
    line: l.line,
    detail: l.detail_json ? (JSON.parse(l.detail_json) as LogLine["detail"]) : null,
  }));
  return {
    id: b.id,
    source: b.source,
    startedAt: b.started_at,
    finishedAt: b.finished_at,
    total: b.total,
    done: b.done,
    elapsedMs: b.elapsed_ms,
    summary: b.summary_json ? (JSON.parse(b.summary_json) as BatchSummary) : null,
    error: b.error,
    lines,
  };
}
