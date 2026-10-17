/**
 * Eval runner: replay the 15 labeled seed emails through each Reason -> Review pair and
 * write measured numbers to eval_runs, which the scoreboard shows instead of the
 * illustrative ones. Run it before the demo, never live. Needs a model key and the seed
 * inbox already ingested (npm run seed:inbox, then let the worker sync).
 *
 *   npm run eval                         every available pair on the leaderboard
 *   npm run eval -- --pair haiku-sonnet  one pair (repeat --pair for more)
 *   npm run eval -- --dry                score and print, don't write eval_runs
 *
 * Uses an in-memory copy of the seed mail: no Gmail calls, and the live board is untouched.
 * Cost is roughly 15 emails x 2 model calls per pair (a few dollars for all pairs with Opus).
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { getDb } from "../src/lib/db";
import { baseDb, evalPair, saveEvalRun, snapshotSeed, type EvalPair } from "../src/lib/eval";
import { claudeExtractor, runExtract } from "../src/lib/pipeline/extract";
import { hasApiKey, pipelineLlm, providerSummary } from "../src/lib/pipeline/llm";
import { claudeMatcher, runResolve } from "../src/lib/pipeline/resolve";
import { config } from "../src/lib/config";
import { getLeaderboard } from "../src/lib/router/store";

const args = process.argv.slice(2);
const wanted = args.flatMap((a, i) => (a === "--pair" && args[i + 1] ? [args[i + 1]] : []));
const dry = args.includes("--dry");

if (!hasApiKey()) {
  console.error("No ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env.local. The eval calls real models.");
  process.exit(1);
}

const real = getDb();
const board = getLeaderboard(real);
const pairs: EvalPair[] = (wanted.length ? wanted.map((id) => board.find((p) => p.id === id) ?? id) : board.filter((p) => p.available)).map((p) => {
  if (typeof p === "string") {
    console.error(`Unknown pair "${p}". Pairs: ${board.map((b) => b.id).join(", ")}`);
    process.exit(1);
  }
  if (!p.available) console.warn(`! ${p.id}: a model in this pair has no configured provider; its calls will fail.`);
  return { id: p.id, reason: p.reasonModel, review: p.reviewModel };
});

const snap = snapshotSeed(real);
console.log(`Models via ${providerSummary()}. ${snap.ids.size}/15 seed emails found; anchor ${snap.anchor.toISOString()}.`);
console.log(`Pairs: ${pairs.map((p) => p.id).join(", ")}${dry ? " (dry run: nothing saved)" : ""}\n`);

const llm = pipelineLlm();
const prepared = baseDb(snap);

// Shared prep, once: read any attachment the live pipeline couldn't, then file each thread.
const ex = await runExtract(prepared, claudeExtractor(llm), { dataDir: config.dataDir, limit: 100 });
if (ex.attachments || ex.failed.length) console.log(`extract: ${ex.attachments} attachment(s) read${ex.failed.length ? `, ${ex.failed.length} failed: ${ex.failed[0].error}` : ""}`);
const rs = await runResolve(prepared, claudeMatcher(llm), { limit: 100 });
console.log(`resolve: ${rs.assigned.length} filed, ${rs.inherited} inherited, ${rs.cards.length} left for a person\n`);

const pct = (x: number) => `${Math.round(x * 100)}%`;
for (const pair of pairs) {
  const started = new Date();
  process.stdout.write(`${pair.id.padEnd(14)} running… `);
  try {
    const r = await evalPair(prepared, snap, pair, llm);
    const m = r.metrics;
    console.log(
      `raw ${pct(m.raw_reason_accuracy)} → verified ${pct(m.verified_accuracy)} · recall ${pct(m.signal_recall)} · ` +
        `traps ${m.traps_caught}/4 · p50 ${(m.latency_p50_ms / 1000).toFixed(1)}s · $${m.cost_per_email_usd.toFixed(4)}/email` +
        (m.failed ? ` · ${m.failed} email(s) didn't finish` : ""),
    );
    for (const [id, t] of Object.entries(m.trap_matrix)) console.log(`    ${id} ${t.outcome.padEnd(8)} ${t.note}`);
    for (const e of r.emails.filter((x) => x.error)) console.log(`    ! ${e.key}: ${e.error}`);
    if (!dry) saveEvalRun(real, r, started);
  } catch (err) {
    console.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (!dry) console.log("\nSaved to eval_runs. The scoreboard now shows measured rows for these pairs.");
