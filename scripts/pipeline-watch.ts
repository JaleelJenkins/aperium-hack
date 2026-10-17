/**
 * Live view of the pipeline from any terminal, whoever is running it (Sync now in
 * npm run dev, the worker, or npm run pipeline). Refreshes every 2 seconds.
 *
 *   npm run pipeline:watch
 *   npm run pipeline:watch -- --once     # print once and exit
 *
 * Shows who holds the run, progress, every model call in flight with how long it
 * has been waiting (flagged STUCK after PIPELINE_STUCK_SECONDS, default 45), recent
 * retries and failures, and the last emails that finished.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { getDb } from "../src/lib/db";
import { latestBatch } from "../src/lib/run-log";

const once = process.argv.includes("--once");
const STUCK_S = Number(process.env.PIPELINE_STUCK_SECONDS) || 45;
const db = getDb();

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const cut = (s: string | null, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);

function render(): string {
  const now = Date.now();
  const out: string[] = [];
  out.push(c.bold(`Pipeline watch · ${new Date().toTimeString().slice(0, 8)}`) + c.dim("  (Ctrl+C to stop)"));

  const lock = db.prepare(`SELECT value FROM app_settings WHERE key = 'pipeline.lock'`).get() as { value: string } | undefined;
  const lease = lock ? (JSON.parse(lock.value) as { token: string; until: number }) : null;
  const holder = lease && lease.until > now ? lease.token.split(":")[0] : null;

  const b = latestBatch(db);
  if (b && !b.finishedAt) {
    const el = now - Date.parse(b.startedAt);
    const total = Math.max(b.total, b.done);
    const width = 30;
    const fill = total ? Math.round((b.done / total) * width) : 0;
    out.push(`${c.yellow("● running")}  ${holder ?? b.source}  [${"█".repeat(fill)}${"·".repeat(width - fill)}] ${b.done}/${total} emails · ${secs(el)}`);
  } else if (b) {
    out.push(`${c.green("✓ idle")}  last run (${b.source}) finished ${b.done}/${b.total} in ${secs(b.elapsedMs ?? 0)}${b.error ? c.red(`  error: ${b.error}`) : ""}`);
  } else {
    out.push(c.dim("No runs yet. Click Sync now, or run npm run pipeline."));
  }

  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status ORDER BY status`).all() as { status: string; n: number }[];
  out.push(c.dim(`messages: ${counts.map((r) => `${r.status} ${r.n}`).join(" · ") || "none"}`));

  const inflight = db
    .prepare(`SELECT stage, model, provider, label, started_at, attempts, last_retry FROM llm_calls WHERE finished_at IS NULL ORDER BY started_at`)
    .all() as { stage: string; model: string; provider: string | null; label: string | null; started_at: string; attempts: number; last_retry: string | null }[];
  out.push("");
  out.push(c.bold(`In flight (${inflight.length})`));
  if (!inflight.length) out.push(c.dim(holder ? "  no model call right now (reading files / saving)" : "  nothing"));
  for (const r of inflight) {
    const ms = now - Date.parse(r.started_at);
    const flag = ms > STUCK_S * 1000 ? c.red(` STUCK? ${secs(ms)}`) : ms > (STUCK_S * 1000) / 2 ? c.yellow(` slow ${secs(ms)}`) : ` ${secs(ms)}`;
    const retry = r.provider?.includes("→")
      ? c.yellow(`  ↪ also on OpenRouter (${r.last_retry})`)
      : r.attempts > 1
        ? c.yellow(`  attempt ${r.attempts} (${r.last_retry})`)
        : "";
    out.push(`  ${r.stage.padEnd(8)} ${r.model.padEnd(20)}${flag.padEnd(14)} ${cut(r.label, 50)}${retry}`);
  }

  const since = new Date(now - 10 * 60_000).toISOString();
  const trouble = db
    .prepare(
      `SELECT stage, label, ms, attempts, last_retry, error, provider FROM llm_calls
        WHERE started_at > ? AND (error IS NOT NULL OR attempts > 1 OR provider LIKE 'failover:%' OR provider LIKE '%→%')
        ORDER BY started_at DESC LIMIT 8`,
    )
    .all(since) as { stage: string; label: string | null; ms: number | null; attempts: number; last_retry: string | null; error: string | null; provider: string | null }[];
  if (trouble.length) {
    out.push("");
    out.push(c.bold("Failovers, retries and errors (last 10 min)"));
    for (const t of trouble) {
      const failover = t.provider?.startsWith("failover:") ? t.provider.slice("failover:".length) : null;
      out.push(
        `  ${t.error ? c.red("✗") : failover ? c.yellow("↪") : c.yellow("↻")} ${t.stage.padEnd(8)} ${cut(t.label, 40).padEnd(40)} ` +
          (t.error
            ? c.red(cut(t.error, 70))
            : failover
              ? c.yellow(`answered by ${failover === "openrouter" ? "OpenRouter" : "Anthropic"} after: ${t.last_retry}`)
              : c.yellow(`${t.attempts} attempts, last: ${t.last_retry}`)) +
          (t.ms != null ? c.dim(` · ${secs(t.ms)}`) : ""),
      );
    }
  }

  const avg = db
    .prepare(
      `SELECT stage, COUNT(*) AS n, AVG(ms) AS avg, MAX(ms) AS max FROM llm_calls
        WHERE started_at > ? AND finished_at IS NOT NULL AND error IS NULL GROUP BY stage ORDER BY stage`,
    )
    .all(since) as { stage: string; n: number; avg: number; max: number }[];
  if (avg.length) {
    out.push("");
    out.push(c.bold("Model calls, last 10 min"));
    out.push("  " + avg.map((a) => `${a.stage} ${a.n}× avg ${secs(a.avg)} max ${secs(a.max)}`).join(c.dim("  ·  ")));
  }

  if (b?.lines.length) {
    out.push("");
    out.push(c.bold("Finished emails"));
    for (const l of b.lines.slice(0, 8)) {
      const d = l.detail;
      const t = d?.reasonMs != null ? c.dim(`  reason ${secs(d.reasonMs)}${d.reviewMs != null ? ` + review ${secs(d.reviewMs)}` : ""}`) : "";
      out.push(`  ${l.kind === "failed" ? c.red("✗") : c.green("✓")} ${cut(l.line, 90)}${t}`);
    }
  }

  // Emails sitting mid-stage with no call in flight while a run holds the lease: likely lost.
  if (holder && !inflight.length) {
    const mid = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status IN ('reasoning', 'reviewing')`).get() as { n: number }).n;
    if (mid) out.push("", c.yellow(`${mid} email(s) mid-stage with no model call in flight. If this lasts, stop the app/worker and run again: interrupted emails are picked up automatically.`));
  }
  return out.join("\n");
}

if (once) {
  console.log(render());
  process.exit(0);
}
const tick = () => {
  process.stdout.write("\x1b[2J\x1b[H" + render() + "\n");
};
tick();
setInterval(tick, 2000);
