/**
 * One-time local setup:
 *   - creates .env.local from .env.example (if missing)
 *   - generates TOKEN_ENCRYPTION_KEY (if empty)
 *   - loads seed/seed.json into the database
 *   - lists what's still left to fill in
 *
 *   npm run setup
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { config as loadEnv } from "dotenv";

const ENV = ".env.local";
const created = !fs.existsSync(ENV);
if (created) fs.copyFileSync(".env.example", ENV);

let env = fs.readFileSync(ENV, "utf8");
let generatedKey = false;
if (/^TOKEN_ENCRYPTION_KEY=\s*$/m.test(env)) {
  env = env.replace(/^TOKEN_ENCRYPTION_KEY=\s*$/m, `TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString("base64")}`);
  fs.writeFileSync(ENV, env);
  generatedKey = true;
}

loadEnv({ path: [ENV, ".env"], quiet: true });

const { config } = await import("../src/lib/config");
const { getDb } = await import("../src/lib/db");
const { applySeed, readSeed } = await import("../src/lib/seed");

const seed = readSeed();
const warnings = applySeed(getDb(), seed);

console.log("");
console.log(`  ✓ ${created ? "Created" : "Found"} ${ENV}`);
if (generatedKey) console.log("  ✓ Generated TOKEN_ENCRYPTION_KEY");
console.log(`  ✓ Seeded ${seed.clients.length} clients, ${seed.projects.length} projects, ${seed.model_profiles.length} model profiles`);
console.log(`    → ${config.dbPath}`);

const todo: string[] = [];
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) if (!process.env[k]) todo.push(`${k} in ${ENV} (see README → Google Cloud)`);
if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY)
  todo.push(`ANTHROPIC_API_KEY or OPENROUTER_API_KEY in ${ENV} (needed for Extract/Reason/Review, not for ingest)`);
todo.push(...warnings.map((w) => `${w} in seed/seed.json, then npm run seed`));

if (todo.length) {
  console.log("\n  Still to do:");
  for (const t of todo) console.log(`    - ${t}`);
}
console.log("\n  Then run, in two terminals:\n    npm run dev\n    npm run worker\n");
