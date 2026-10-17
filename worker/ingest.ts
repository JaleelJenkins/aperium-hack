/**
 * Ingest worker: polls every connected Gmail inbox and stores new mail.
 *
 *   npm run worker        # loop every POLL_INTERVAL_MS
 *   npm run worker:once   # one pass, then exit
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { config } from "../src/lib/config";
import { getDb } from "../src/lib/db";
import { listAccounts } from "../src/lib/gmail/client";
import { syncAll } from "../src/lib/ingest/sync";
import { applySeed, readSeed } from "../src/lib/seed";
import { hasApiKey, providerSummary } from "../src/lib/pipeline/llm";
import { defaultDeps, describe, runPipeline } from "../src/lib/pipeline/run";

const pipelineDeps = defaultDeps();

const once = process.argv.includes("--once");
let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function tick(): Promise<void> {
  const db = getDb();
  if (listAccounts(db).length === 0) {
    log("no Gmail account connected yet — open the dashboard and click Connect Gmail");
    return;
  }
  for (const r of await syncAll(db)) {
    if ("error" in r) {
      log(`${r.account}: ERROR ${r.error}`);
      continue;
    }
    const parts = [`${r.mode}`, `+${r.newEmailIds.length} new`];
    if (r.existing) parts.push(`${r.existing} already stored`);
    if (r.skipped) parts.push(`${r.skipped} skipped`);
    if (r.failed.length) parts.push(`${r.failed.length} failed (${r.failed.map((f) => f.error).join("; ")})`);
    if (r.newEmailIds.length || r.failed.length || r.mode === "bootstrap" || once) log(`${r.account}: ${parts.join(", ")}`);
  }
  // Extract, Resolve, Reason and Review whatever is waiting (new mail, or a backlog after adding an API key).
  try {
    for (const line of describe(await runPipeline(db, pipelineDeps))) log(line);
  } catch (err) {
    log(`pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
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
  const db = getDb();
  if (!(db.prepare(`SELECT 1 FROM clients LIMIT 1`).get())) {
    for (const w of applySeed(db, readSeed())) log(`seed: ${w}`);
    log("loaded seed/seed.json (clients, projects, model profiles)");
  }
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
