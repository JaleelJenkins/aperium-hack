/**
 * Demo state snapshots. Safe to run while `npm run dev` and the worker are up.
 *
 *   npm run demo:snapshot                 save data/snapshots/pre-demo
 *   npm run demo:snapshot -- golden       save under another name
 *   npm run demo:snapshot -- --list       list saved snapshots
 *   npm run demo:restore                  restore pre-demo (between rehearsals / on stage)
 *   npm run demo:restore -- golden
 *
 * Restore keeps the live Gmail connection, so the rehearsal email isn't re-ingested.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { getDb } from "../src/lib/db";
import { listSnapshots, restoreSnapshot, saveSnapshot } from "../src/lib/snapshot";

const [mode, ...rest] = process.argv.slice(2);
const list = rest.includes("--list");
const name = rest.find((a) => !a.startsWith("--")) ?? "pre-demo";

function printList() {
  const all = listSnapshots();
  if (!all.length) return console.log("No snapshots yet. Save one with: npm run demo:snapshot");
  for (const s of all) {
    const c = s.counts;
    console.log(
      `${s.name.padEnd(16)} ${s.createdAt}  v${s.userVersion}  ${c.messages} msgs · ${c.signals} signals · ${c.actions} actions · ${c.model_reviews} blocked/reviews`,
    );
  }
}

try {
  if (list) {
    printList();
  } else if (mode === "save") {
    const s = saveSnapshot(getDb(), name);
    console.log(`Saved snapshot "${s.name}": ${s.counts.messages} messages, ${s.counts.signals} signals, ${s.counts.actions} actions${s.hasAttachments ? ", attachments" : ""}.`);
    console.log(`Restore with: npm run demo:restore${s.name === "pre-demo" ? "" : ` -- ${s.name}`}`);
  } else if (mode === "restore") {
    const r = restoreSnapshot(getDb(), name);
    console.log(`Restored "${r.name}": ${r.rows} rows across ${r.tables} tables. The open dashboard updates on its next refresh.`);
    if (r.keptLiveGmail) console.log("Kept the current Gmail connection and sync cursor (mail already seen won't be re-ingested).");
  } else {
    console.error("Usage: tsx scripts/demo-snapshot.ts save|restore [name] [--list]");
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
