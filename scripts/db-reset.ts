/**
 * Seed reset (PRD build plan, hour 5): back to a clean demo state.
 * Wipes ingested mail and all pipeline output, restores the seeded clients,
 * projects and model profiles, and clears the history cursor so the next sync
 * re-bootstraps. Keeps the Gmail connection and model choices.
 *
 *   npm run db:reset            # keep Gmail connected
 *   npm run db:reset -- --all   # also disconnect Gmail (wipes tokens)
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import fs from "node:fs";
import { config } from "../src/lib/config";
import { getDb } from "../src/lib/db";
import { readSeed, resetToSeed } from "../src/lib/seed";

const all = process.argv.includes("--all");
const warnings = resetToSeed(getDb(), readSeed(), { disconnect: all });
fs.rmSync(config.attachmentsDir, { recursive: true, force: true });
console.log(`Reset ${config.dbPath} to seed state${all ? " and disconnected Gmail" : ""}.`);
for (const w of warnings) console.warn(`  ! ${w}`);
