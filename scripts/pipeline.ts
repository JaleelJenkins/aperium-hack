/**
 * Run Extract + Resolve once over everything waiting, without polling Gmail.
 *   npm run pipeline
 * Useful after seeding, after adding ANTHROPIC_API_KEY, or after `npm run seed -- --summaries`.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { getDb } from "../src/lib/db";
import { hasApiKey } from "../src/lib/pipeline/llm";
import { defaultDeps, describe, runPipeline } from "../src/lib/pipeline/run";

const deps = defaultDeps();
console.log(
  hasApiKey()
    ? `Extract with ${deps.extractor!.model}, resolve with ${deps.matcher.model}.`
    : "No ANTHROPIC_API_KEY in .env.local: skipping Extract; Resolve uses word overlap with project summaries.",
);
const db = getDb();
const r = await runPipeline(db, deps);
const lines = describe(r);
console.log(lines.length ? lines.join("\n") : "Nothing waiting.");
const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status ORDER BY status`).all() as { status: string; n: number }[];
console.log(`Messages by status: ${counts.map((c) => `${c.status} ${c.n}`).join(", ") || "none yet"}`);
