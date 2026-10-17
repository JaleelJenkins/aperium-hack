/**
 * Back to the 15 seed emails, processed once.
 *   npm run pipeline:reset             # shows what would change
 *   npm run pipeline:reset -- --yes    # does it; then click Sync now (or run npm run pipeline)
 *   npm run pipeline:reset -- --yes --force   # also when a stopped run left its lock behind
 * Keeps clients, projects, summaries, review rules and the Gmail connection. Removed
 * mail stays in Gmail. Stop the worker first so it doesn't process mid-reset.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { pipelineBusy } from "../src/lib/cycle";
import { getDb } from "../src/lib/db";
import { applyReprocess, planReprocess } from "../src/lib/reprocess";

const yes = process.argv.includes("--yes");
// A run killed mid-way (Ctrl+C on npm run dev) leaves its lease for up to 15 min; --force clears it.
const force = process.argv.includes("--force");
const db = getDb();
const plan = planReprocess(db);
const o = plan.outputs;

console.log(`Seed emails kept: ${plan.keep.length}`);
if (plan.keep.length !== 15) console.log(`  ! expected 15. Run npm run seed:inbox to add any that are missing from Gmail.`);
console.log(`Other mail removed from the board: ${plan.remove.length}`);
for (const m of plan.remove) console.log(`  - ${m.subject ?? "(no subject)"}  <${m.sender_email ?? "?"}>  (${m.why})`);
console.log(`Pipeline output cleared: ${o.signals} signals, ${o.insights} insights, ${o.actions} actions, ${o.reviews} review verdicts, ${o.runs} runs`);

if (!yes) {
  console.log("\nNothing changed yet. Run again with -- --yes to apply.");
  process.exit(0);
}
if (pipelineBusy(db) && !force) {
  console.log(
    "\nThe pipeline looks busy (worker or Sync now). Stop npm run dev and the worker with Ctrl+C, then run:\n" +
      "  npm run pipeline:reset -- --yes --force",
  );
  process.exit(1);
}
applyReprocess(db, plan);
console.log("\nDone. Click Sync now on the dashboard (or run npm run pipeline) to process the 15 emails once.");
