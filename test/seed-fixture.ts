/** Shared fixture: the full seed inbox ingested exactly as Gmail would deliver it. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type DB } from "../src/lib/db";
import { syncAccount } from "../src/lib/ingest/sync";
import type { Extractor } from "../src/lib/pipeline/extract";
import { applySeed, readSeed } from "../src/lib/seed";
import { buildSeedMessages, SEED_ASSETS_DIR } from "../src/lib/seed-inbox";
import { FakeGmail, toGmailMessage } from "./helpers";

export const INBOX = "test.aperium.ai@gmail.com";
export const ANCHOR = new Date("2026-10-17T12:00:00-07:00");

/** Stand-in for Claude: what a correct extraction of each seed attachment contains. */
export const PAGES: Record<string, string[]> = {
  "harbor-lobby-floor-plan.pdf": [
    "LEVEL 1 (GROUND) - MARKED-UP PLAN\nELEVATORS RECEPTION DESK SEATING\nShift desk 1.2 m east",
    "LEVEL 2 (MEZZANINE) - MARKED-UP PLAN\nSCOPE OF WORK\nLobby redesign covers 2 levels: Level 1 (Ground) and Level 2 (Mezzanine).\nLevel 3 (tenant floor) is NOT IN SCOPE.",
  ],
  "lumen-quote-Q-2026-118.pdf": ["Northbeam Studio\nQuote Q-2026-118\nSTATUS: PROPOSED\nTotal (excl. tax) $12,400.00\nClient acceptance\nSignature"],
};
export const fakeExtractor: Extractor = {
  model: "fake-extract",
  async pdf(_d, filename) {
    return { pages: PAGES[filename] ?? [`${filename} page 1`], summary: `Summary of ${filename}` };
  },
  async image(_d, _m, filename) {
    return { description: `Screenshot ${filename}`, text: "" };
  },
};

/** Ingest the full seed inbox exactly as Gmail would deliver it. */
export async function seededDb(): Promise<{ db: DB; dataDir: string; idOf: Map<string, string> }> {
  const db = openDb(":memory:");
  applySeed(db, readSeed());
  db.prepare(`INSERT INTO gmail_accounts (email, refresh_token) VALUES (?, 'rt')`).run(INBOX);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipe-"));
  const g = new FakeGmail();
  await syncAccount(db, g, INBOX, { dataDir });
  const built = buildSeedMessages(ANCHOR, INBOX);
  const threadOf = new Map<string, string>();
  const idOf = new Map<string, string>();
  for (const [i, m] of built.entries()) {
    const id = `g${i}`;
    idOf.set(m.email.key, id);
    const threadId = m.rootMessageId ? threadOf.get(m.rootMessageId)! : `t${i}`;
    threadOf.set(m.messageId, threadId);
    for (const [pi, a] of m.email.attachments.entries()) g.attachments.set(`att-${id}-${pi + 1}`, fs.readFileSync(path.join(SEED_ASSETS_DIR, a.file)));
    g.deliver(toGmailMessage(m.raw, id, threadId, m.date.getTime()));
  }
  await syncAccount(db, g, INBOX, { dataDir });
  return { db, dataDir, idOf };
}

export const projectOf = (db: DB, messageId: string) =>
  (db.prepare(`SELECT t.project_id FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id WHERE m.gmail_message_id = ?`).get(messageId) as {
    project_id: string | null;
  }).project_id;

