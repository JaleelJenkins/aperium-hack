/**
 * Remove ingested emails (and everything derived from them) from the app's
 * database. The emails stay in Gmail.
 *
 *   npm run mail:remove -- --ignored                 Google account notices, bounces (see src/lib/ingest/ignore.ts)
 *   npm run mail:remove -- --subject "recovery"      by subject text
 *   npm run mail:remove -- 18f3a2b4c5d6e7f8          by Gmail message id
 *   add --dry-run to list matches without removing
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { getDb } from "../src/lib/db";
import { findMessages, removeMessages } from "../src/lib/ingest/remove";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const ignored = args.includes("--ignored");
const subject = args.includes("--subject") ? args[args.indexOf("--subject") + 1] : undefined;
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--subject");

if (!ignored && subject === undefined && ids.length === 0) {
  console.log(`Usage:
  npm run mail:remove -- --ignored
  npm run mail:remove -- --subject "some subject text"
  npm run mail:remove -- <gmail message id>
Add --dry-run to preview.`);
  process.exit(1);
}

const db = getDb();
const matches = findMessages(db, { ids, ignored, subject });
if (matches.length === 0) {
  console.log("No matching emails in the database.");
  process.exit(0);
}

console.log(`${dryRun ? "Would remove" : "Removing"} ${matches.length} email(s):`);
for (const m of matches) console.log(`  ${m.id}  ${m.sender_email ?? "?"}  ${m.subject ?? "(no subject)"}`);
if (dryRun) process.exit(0);

removeMessages(db, matches);
console.log("Done. Refresh the dashboard. The emails are still in Gmail.");
