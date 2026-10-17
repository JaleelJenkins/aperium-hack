/**
 * Worker: polls every connected Gmail inbox and runs the full pipeline on what arrives
 * (Extract -> Resolve -> Reason -> Review -> Executor), every POLL_INTERVAL_MS.
 *
 *   npm run worker        # loop every POLL_INTERVAL_MS
 *   npm run worker:once   # one pass, then exit
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { config } from "../src/lib/config";
import { getDb } from "../src/lib/db";
import { runCycle } from "../src/lib/cycle";
import { listAccounts } from "../src/lib/gmail/client";
import { hasApiKey, providerSummary } from "../src/lib/pipeline/llm";
import { defaultDeps } from "../src/lib/pipeline/run";

const pipelineDeps = defaultDeps();

const once = process.argv.includes("--once");
let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function tick(): Promise<void> {
  const db = getDb();
  if (listAccounts(db).length === 0) log("no Gmail account connected yet — open the dashboard and click Connect Gmail");
  // Seed (empty DB) -> sync -> Extract -> Resolve -> Reason -> Review -> Executor, under the shared lease.
  const r = await runCycle(db, "worker", pipelineDeps);
  if (r.seeded) {
    for (const w of r.seeded) log(`seed: ${w}`);
    log("loaded seed/seed.json (clients, projects, model profiles)");
  }
  for (const s of r.sync) {
    if ("error" in s) {
      log(`${s.account}: ERROR ${s.error}`);
      continue;
    }
    const parts = [`${s.mode}`, `+${s.newEmailIds.length} new`];
    if (s.existing) parts.push(`${s.existing} already stored`);
    if (s.skipped) parts.push(`${s.skipped} skipped`);
    if (s.failed.length) parts.push(`${s.failed.length} failed (${s.failed.map((f) => f.error).join("; ")})`);
    if (s.newEmailIds.length || s.failed.length || s.mode === "bootstrap" || once) log(`${s.account}: ${parts.join(", ")}`);
  }
  if (!r.outcome.ran) {
    if (once) log("pipeline: another process (Sync now) is running it; skipped");
    return;
  }
  const x = r.outcome.executor;
  if (x.drafts || x.tasks || x.failed.length) {
    log(`executor: ${x.drafts} draft(s) created, ${x.tasks} task(s) added` + (x.failed.length ? `, ${x.failed.length} failed (${x.failed.map((f) => f.error).join("; ")})` : ""));
  }
}

function log(msg: string): void {
  console.log(`[ingest ${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  log(`db ${config.dbPath}; polling every ${config.pollIntervalMs}ms${once ? " (once)" : ""}`);
  log(
    hasApiKey()
      ? `pipeline (${providerSummary()}): extract with ${pipelineDeps.extractor!.model}, resolve with ${pipelineDeps.matcher.model}, reason/review with the routed pair`
      : "pipeline: no ANTHROPIC_API_KEY or OPENROUTER_API_KEY, so attachments are not extracted, projects are matched by word overlap, and Reason/Review are skipped",
  );
  do {
    try {
      await tick();
    } catch (err) {
      log(`tick failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
    if (once) break;
    await sleep(config.pollIntervalMs);
  } while (!stopping);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const stop = () => {
      clearTimeout(t);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

main().then(() => process.exit(0));
