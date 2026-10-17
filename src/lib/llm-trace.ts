/**
 * Makes pipeline progress visible in the terminal that runs it (npm run dev for
 * Sync now, npm run worker, npm run pipeline), and records every model call in
 * llm_calls so `npm run pipeline:watch` in another terminal can show what is in
 * flight right now and flag anything that looks stuck.
 *
 *   [pipeline 15:23:31] → reason   claude-haiku-5-5  "Re: Reception wall: site photo…"
 *   [pipeline 15:23:38] ✓ reason   7.1s  "Re: Reception wall: site photo…"
 *   [pipeline 15:23:40] ↻ review   retry 1 in 2.0s: 429 rate limited  "Fwd: Pilot go-live"
 *   [pipeline 15:24:01] ✓ email 5/15  Fwd: Pilot go-live → Driver app pilot · 1 signal  (reason 6.2s + review 9.8s)
 *
 * Set PIPELINE_LOG=quiet to keep only the per-email and summary lines.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import { setCallObserver, type CallObserver } from "./pipeline/llm";

const quiet = () => process.env.PIPELINE_LOG === "quiet";
const time = () => new Date().toTimeString().slice(0, 8);
export const log = (msg: string) => console.log(`[pipeline ${time()}] ${msg}`);

function stageOf(hint?: string): { stage: string; messageId: string | null } {
  const [kind, id] = (hint ?? "").split(":");
  if (kind === "reason" || kind === "review") return { stage: kind, messageId: id ?? null };
  if (kind.startsWith("extract")) return { stage: "extract", messageId: null };
  if (kind === "resolve") return { stage: "resolve", messageId: null };
  return { stage: kind || "other", messageId: null };
}

const short = (s: string | null | undefined, n = 48) => (s ? `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"` : "");

/** Installs the tracer for one pipeline run; returns a function that removes it. */
export function traceCalls(db: DB, source: string): () => void {
  const open = new Map<string, { stage: string; label: string | null }>();
  const obs: CallObserver = {
    start(info) {
      const id = randomUUID();
      const { stage, messageId } = stageOf(info.hint);
      let label = info.label ?? null;
      if (!label && messageId) {
        label = (db.prepare(`SELECT subject FROM messages WHERE gmail_message_id = ?`).get(messageId) as { subject: string | null } | undefined)?.subject ?? null;
      }
      open.set(id, { stage, label });
      db.prepare(
        `INSERT INTO llm_calls (id, source, stage, message_id, label, model, provider, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, source, stage, messageId, label, info.model, info.provider, new Date().toISOString());
      if (!quiet()) log(`→ ${stage.padEnd(8)} ${info.model.padEnd(18)} ${short(label)}`);
      return id;
    },
    retry(id, attempt, reason, waitMs) {
      const c = open.get(id);
      db.prepare(`UPDATE llm_calls SET attempts = ?, last_retry = ? WHERE id = ?`).run(attempt + 1, reason, id);
      log(`↻ ${(c?.stage ?? "call").padEnd(8)} retry ${attempt}${waitMs ? ` in ${(waitMs / 1000).toFixed(1)}s` : ""}: ${reason}  ${short(c?.label)}`);
    },
    end(id, r) {
      const c = open.get(id);
      open.delete(id);
      db.prepare(`UPDATE llm_calls SET finished_at = ?, ms = ?, error = ? WHERE id = ?`).run(new Date().toISOString(), r.ms, r.error ?? null, id);
      if (!r.ok) log(`✗ ${(c?.stage ?? "call").padEnd(8)} ${(r.ms / 1000).toFixed(1)}s  ${r.error}  ${short(c?.label)}`);
      else if (!quiet()) log(`✓ ${(c?.stage ?? "call").padEnd(8)} ${(r.ms / 1000).toFixed(1)}s  ${short(c?.label)}`);
    },
  };
  setCallObserver(obs);
  // Keep a day of call history.
  db.prepare(`DELETE FROM llm_calls WHERE started_at < ?`).run(new Date(Date.now() - 86_400_000).toISOString());
  return () => {
    setCallObserver(null);
    // A call that never ended (process killed mid-call) shouldn't look in flight forever.
    for (const id of open.keys()) db.prepare(`UPDATE llm_calls SET finished_at = ?, error = COALESCE(error, 'abandoned') WHERE id = ? AND finished_at IS NULL`).run(new Date().toISOString(), id);
  };
}
