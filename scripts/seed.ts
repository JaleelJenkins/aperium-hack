/**
 * Load clients, contacts, projects and model profiles from seed/seed.json.
 *   npm run seed
 *   npm run seed -- --summaries    also overwrite project summaries with the seed versions
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { config } from "../src/lib/config";
import { getDb } from "../src/lib/db";
import { applySeed, readSeed } from "../src/lib/seed";

const seed = readSeed();
const overwriteSummaries = process.argv.includes("--summaries");
const warnings = applySeed(getDb(), seed, { overwriteSummaries });
if (overwriteSummaries) console.log("Project summaries reset to seed/seed.json.");
console.log(
  `Seeded ${seed.clients.length} clients, ${seed.projects.length} projects, ${seed.model_profiles.length} model profiles into ${config.dbPath}.`,
);
for (const w of warnings) console.warn(`  ! ${w}`);
