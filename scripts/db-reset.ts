/**
 * Wipe ingested mail so the next sync re-bootstraps. Keeps the Gmail connection.
 *   npm run db:reset            # clear emails, attachments, audit log, history cursor
 *   npm run db:reset -- --all   # also forget the connected Gmail account
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import fs from "node:fs";
import { config } from "../src/lib/config";
import { getDb } from "../src/lib/db";

const db = getDb();
const all = process.argv.includes("--all");
db.transaction(() => {
  db.exec(`DELETE FROM attachments; DELETE FROM emails; DELETE FROM audit_log;`);
  if (all) db.exec(`DELETE FROM gmail_accounts;`);
  else db.exec(`UPDATE gmail_accounts SET history_id = NULL, last_synced_at = NULL, last_error = NULL;`);
})();
fs.rmSync(config.attachmentsDir, { recursive: true, force: true });
console.log(`Reset ${config.dbPath}${all ? " (including Gmail connection)" : ""}.`);
