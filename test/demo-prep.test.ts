import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/lib/db";
import { applySeed, LIVE_DEMO_PLACEHOLDER, readSeed } from "../src/lib/seed";
import { runPreflight } from "../src/lib/preflight";
import { listSnapshots, restoreSnapshot, saveSnapshot } from "../src/lib/snapshot";

const count = (db: DB, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe("live demo sender", () => {
  const prev = process.env.LIVE_DEMO_SENDER;
  afterEach(() => {
    if (prev === undefined) delete process.env.LIVE_DEMO_SENDER;
    else process.env.LIVE_DEMO_SENDER = prev;
  });

  it("without LIVE_DEMO_SENDER the placeholder stays and seeding says what to set", () => {
    delete process.env.LIVE_DEMO_SENDER;
    const db = openDb(":memory:");
    const warnings = applySeed(db, readSeed());
    expect(warnings.some((w) => w.includes("LIVE_DEMO_SENDER"))).toBe(true);
    expect(db.prepare(`SELECT client_id FROM contacts WHERE email = ?`).get(LIVE_DEMO_PLACEHOLDER)).toBeTruthy();
  });

  it("LIVE_DEMO_SENDER replaces the placeholder and removes the stale row", () => {
    delete process.env.LIVE_DEMO_SENDER;
    const db = openDb(":memory:");
    applySeed(db, readSeed()); // earlier seed with the placeholder
    process.env.LIVE_DEMO_SENDER = "  Teammate.Phone@Gmail.com ";
    const warnings = applySeed(db, readSeed());
    expect(warnings.filter((w) => w.includes("LIVE_DEMO_SENDER"))).toEqual([]);
    expect(db.prepare(`SELECT client_id FROM contacts WHERE email = ?`).get("teammate.phone@gmail.com")).toEqual({ client_id: "harbor-pine" });
    expect(db.prepare(`SELECT 1 FROM contacts WHERE email = ?`).get(LIVE_DEMO_PLACEHOLDER)).toBeUndefined();
  });

  it("ignores a malformed LIVE_DEMO_SENDER", () => {
    process.env.LIVE_DEMO_SENDER = "not-an-email";
    const emails = readSeed().clients.flatMap((c) => c.contacts.map((ct) => ct.email.toLowerCase()));
    expect(emails).toContain(LIVE_DEMO_PLACEHOLDER);
  });
});

describe("demo snapshots", () => {
  const prevDataDir = process.env.DATA_DIR;
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-snap-"));
    process.env.DATA_DIR = dir;
    db = openDb(path.join(dir, "reasoning-intelligence.db"));
    applySeed(db, readSeed());
    db.prepare(`INSERT INTO threads (gmail_thread_id, account, project_id) VALUES ('t1', 'a@x.com', 'harbor-lobby')`).run();
    db.prepare(
      `INSERT INTO messages (gmail_message_id, thread_id, account, received_at, body_source, raw_text, clean_text)
       VALUES ('m1', 't1', 'a@x.com', '2026-10-17T09:00:00Z', 'text/plain', 'hi', 'hi')`,
    ).run();
    db.prepare(`INSERT INTO gmail_accounts (email, refresh_token, history_id) VALUES ('inbox@x.com', 'enc-old', '100')`).run();
    fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dir, "attachments", "plan.pdf"), "%PDF snapshot");
  });
  afterEach(() => {
    db.close();
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
  });

  it("restores data and attachment files, keeping the live Gmail cursor", () => {
    const saved = saveSnapshot(db, "pre-demo");
    expect(saved.counts.messages).toBe(1);
    expect(listSnapshots().map((s) => s.name)).toEqual(["pre-demo"]);

    // Rehearsal: new mail arrives, the cursor moves, files change, a project policy changes.
    db.prepare(
      `INSERT INTO messages (gmail_message_id, thread_id, account, received_at, body_source, raw_text, clean_text)
       VALUES ('m-live', 't1', 'a@x.com', '2026-10-17T10:00:00Z', 'text/plain', 'live', 'live')`,
    ).run();
    db.prepare(`UPDATE gmail_accounts SET history_id = '250', refresh_token = 'enc-new'`).run();
    db.prepare(`UPDATE projects SET routing_policy = 'pinned' WHERE id = 'harbor-lobby'`).run();
    fs.writeFileSync(path.join(dir, "attachments", "live.pdf"), "%PDF live");

    const r = restoreSnapshot(db, "pre-demo");
    expect(r.keptLiveGmail).toBe(true);
    expect((db.prepare(`SELECT gmail_message_id FROM messages`).all() as { gmail_message_id: string }[]).map((m) => m.gmail_message_id)).toEqual(["m1"]);
    expect(db.prepare(`SELECT history_id, refresh_token FROM gmail_accounts`).get()).toEqual({ history_id: "250", refresh_token: "enc-new" });
    expect(db.prepare(`SELECT routing_policy FROM projects WHERE id = 'harbor-lobby'`).get()).toEqual({ routing_policy: "complexity_escalation" });
    expect(fs.readdirSync(path.join(dir, "attachments"))).toEqual(["plan.pdf"]);
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(count(db, "clients")).toBe(3);
  });

  it("preflight blocks on the things that break a live demo and passes when ready", () => {
    const blocking = (env: Record<string, string | undefined>) =>
      runPreflight(db, { env, now: Date.parse("2026-10-17T10:00:30Z"), expectedSeedEmails: 1 })
        .filter((c) => c.level === "fail")
        .map((c) => c.label);

    delete process.env.LIVE_DEMO_SENDER;
    const bare = blocking({});
    expect(bare.some((l) => l.startsWith("Missing GOOGLE_CLIENT_ID"))).toBe(true);
    expect(bare).toContain("No model key: ANTHROPIC_API_KEY or OPENROUTER_API_KEY not set");
    expect(bare).toContain("Live demo sender not configured");
    expect(bare).toContain("gmail.compose not granted: approved replies can't become drafts");

    process.env.LIVE_DEMO_SENDER = "phone@gmail.com";
    applySeed(db, readSeed());
    db.prepare(`UPDATE gmail_accounts SET scope = 'https://www.googleapis.com/auth/gmail.compose', last_synced_at = '2026-10-17T10:00:00Z'`).run();
    db.prepare(`UPDATE messages SET rfc_message_id = '<seed.harbor-01@northbeam.seed>'`).run();
    const env = { GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "x", TOKEN_ENCRYPTION_KEY: "x", ANTHROPIC_API_KEY: "x" };
    expect(blocking(env)).toEqual([]);

    db.prepare(`UPDATE gmail_accounts SET last_error = 'invalid_grant'`).run();
    expect(blocking(env)).toEqual(["Last sync failed: invalid_grant"]);
    delete process.env.LIVE_DEMO_SENDER;
  });

  it("refuses unknown names, bad names and schema mismatches", () => {
    expect(() => restoreSnapshot(db, "nope")).toThrow(/No snapshot "nope"/);
    expect(() => saveSnapshot(db, "../escape")).toThrow(/Snapshot names/);
    saveSnapshot(db, "old");
    db.exec("PRAGMA user_version = 99");
    expect(() => restoreSnapshot(db, "old")).toThrow(/schema v\d+, the live database is v99/);
    expect(count(db, "messages")).toBe(1); // nothing was touched
  });
});
