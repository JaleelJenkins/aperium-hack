/**
 * Demo-day preflight (README demo checklist, as code). Each check says what to do when it
 * isn't ready. "fail" blocks the live demo; "warn" degrades it.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { DB } from "./db";
import { listSnapshots } from "./snapshot";
import { LIVE_DEMO_PLACEHOLDER, liveDemoSender } from "./seed";

export type Level = "ok" | "warn" | "fail";
export interface Check {
  level: Level;
  label: string;
  fix?: string;
}

const COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const STALE_SYNC_MS = 90_000;
const n = (db: DB, sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { n: number }).n;

export function runPreflight(db: DB, opts: { now?: number; env?: Record<string, string | undefined>; expectedSeedEmails?: number } = {}): Check[] {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const out: Check[] = [];
  const add = (level: Level, label: string, fix?: string) => out.push({ level, label, fix });

  // Configuration
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"].filter((k) => !env[k]);
  if (missing.length) add("fail", `Missing ${missing.join(", ")}`, "npm run setup, then fill .env.local");
  else add("ok", "Google OAuth + token encryption configured");
  const keys = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"].filter((k) => env[k]?.trim());
  if (!keys.length) add("fail", "No model key: ANTHROPIC_API_KEY or OPENROUTER_API_KEY not set", "add one to .env.local; Reason and Review can't run without it");
  else add("ok", `${keys.join(" + ")} set`);

  // Live demo sender
  const sender = liveDemoSender();
  if (!sender) add("fail", "Live demo sender not configured", "set LIVE_DEMO_SENDER=<teammate's phone address> in .env.local, then npm run seed");
  else if (!n(db, `SELECT COUNT(*) AS n FROM contacts WHERE email = ?`, sender))
    add("fail", `Live demo sender ${sender} isn't a client contact yet`, "npm run seed");
  else add("ok", `Live demo sender ${sender} maps to a client`);
  if (n(db, `SELECT COUNT(*) AS n FROM contacts WHERE email = ?`, LIVE_DEMO_PLACEHOLDER) && sender)
    add("warn", "Placeholder contact still in the database", "npm run seed");

  // Gmail connection + worker
  const acct = db.prepare(`SELECT email, scope, last_synced_at, last_error FROM gmail_accounts ORDER BY created_at LIMIT 1`).get() as
    | { email: string; scope: string | null; last_synced_at: string | null; last_error: string | null }
    | undefined;
  if (!acct) {
    add("fail", "No Gmail inbox connected", "npm run dev, open http://localhost:3000, Connect Gmail");
  } else {
    add("ok", `Inbox connected: ${acct.email}`);
    if (acct.last_error) add("fail", `Last sync failed: ${acct.last_error}`, "Reconnect Gmail (Testing-mode tokens expire after ~7 days)");
    if (!(acct.scope ?? "").includes(COMPOSE_SCOPE)) add("fail", "gmail.compose not granted: approved replies can't become drafts", "Reconnect Gmail");
    const age = acct.last_synced_at ? now - Date.parse(acct.last_synced_at) : Infinity;
    if (age > STALE_SYNC_MS)
      add("warn", acct.last_synced_at ? `Last sync ${Math.round(age / 1000)}s ago: is the worker running?` : "Never synced", "npm run worker (in its own terminal)");
    else add("ok", `Worker syncing (last sync ${Math.round(age / 1000)}s ago)`);
  }

  // Data
  const demoRows = n(db, `SELECT COUNT(*) AS n FROM messages WHERE gmail_message_id LIKE 'demo-%'`);
  if (demoRows) add("fail", `${demoRows} dev-only demo:ui messages on the board`, "npm run demo:ui -- --clear");
  const expected = opts.expectedSeedEmails ?? 15;
  const seeded = n(db, `SELECT COUNT(*) AS n FROM messages WHERE rfc_message_id LIKE '<seed.%'`);
  if (seeded < expected) add("warn", `Seed inbox: ${seeded}/${expected} seed emails ingested`, "npm run seed:inbox, then let the worker sync");
  else add("ok", `Seed inbox: ${seeded}/${expected} seed emails ingested`);

  const signals = n(db, `SELECT COUNT(*) AS n FROM signals WHERE id NOT LIKE 'demo-%'`);
  const blocked = n(db, `SELECT COUNT(*) AS n FROM model_reviews WHERE verdict = 'block' AND id NOT LIKE 'demo-%'`);
  if (!signals) add("warn", "Pipeline hasn't produced any signals yet", "run the Reason/Review pipeline over the seed inbox");
  else add(blocked >= 3 ? "ok" : "warn", `Pipeline output: ${signals} signals, ${blocked} claims caught by review (target: 3+ of 4 traps)`);

  const measured = n(db, `SELECT COUNT(*) AS n FROM eval_runs WHERE finished_at IS NOT NULL AND metrics_json IS NOT NULL`);
  if (!measured) add("warn", "Scoreboard shows illustrative numbers only", "run the eval before the demo (not live)");
  else add("ok", `Scoreboard: ${measured} measured eval run(s)`);

  // Evidence files on disk
  const files = db.prepare(`SELECT storage_path FROM attachments WHERE status IN ('stored','extracted') AND storage_path IS NOT NULL`).all() as {
    storage_path: string;
  }[];
  const lost = files.filter((f) => !fs.existsSync(path.resolve(config.dataDir, f.storage_path))).length;
  if (lost) add("fail", `${lost} attachment file(s) missing on disk: evidence links will 404`, "npm run demo:restore, or re-sync");
  else add("ok", `${files.length} attachment files on disk`);

  // Fallback
  const pre = listSnapshots().find((s) => s.name === "pre-demo");
  if (!pre) add("warn", "No pre-demo snapshot", "npm run demo:snapshot once the board looks right");
  else add("ok", `pre-demo snapshot from ${pre.createdAt} (${pre.counts.messages} messages)`);

  return out;
}
