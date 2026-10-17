import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db";
import { isIgnoredSender } from "../src/lib/ingest/ignore";
import { findMessages, removeMessages } from "../src/lib/ingest/remove";
import { syncAccount } from "../src/lib/ingest/sync";
import { FakeGmail, filePart, message, textPart } from "./helpers";

const ACCOUNT = "test.aperium.ai@gmail.com";
afterEach(() => {
  delete process.env.IGNORE_SENDERS;
});

describe("ignored senders", () => {
  it("matches Google account notices and bounces, not clients", () => {
    expect(isIgnoredSender("no-reply@accounts.google.com")).toBe(true);
    expect(isIgnoredSender("MAILER-DAEMON@googlemail.com")).toBe(true);
    expect(isIgnoredSender("dana@harborpine.com")).toBe(false);
    expect(isIgnoredSender("amara.okafor.md@gmail.com")).toBe(false);
  });

  it("honours IGNORE_SENDERS addresses and @domains", () => {
    process.env.IGNORE_SENDERS = "news@vendor.com, @spam.example";
    expect(isIgnoredSender("news@vendor.com")).toBe(true);
    expect(isIgnoredSender("anyone@spam.example")).toBe(true);
    expect(isIgnoredSender("sales@vendor.com")).toBe(false);
  });

  it("ingest skips them", async () => {
    const db = openDb(":memory:");
    db.prepare(`INSERT INTO gmail_accounts (email, refresh_token) VALUES (?, 'rt')`).run(ACCOUNT);
    const g = new FakeGmail();
    g.deliver(message("google", { from: "Google <no-reply@accounts.google.com>", subject: "Security alert" }));
    g.deliver(message("client", { from: "Dana <dana@harborpine.com>" }));
    const r = await syncAccount(db, g, ACCOUNT, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ign-")) });
    expect(r.newEmailIds).toEqual(["client"]);
    expect(r.skipped).toBe(1);
  });
});

describe("removeMessages", () => {
  it("removes the message, its thread, attachments, files and derived signals", async () => {
    const db = openDb(":memory:");
    db.prepare(`INSERT INTO gmail_accounts (email, refresh_token) VALUES (?, 'rt')`).run(ACCOUNT);
    db.prepare(`INSERT INTO clients (id, name) VALUES ('c', 'C')`).run();
    db.prepare(`INSERT INTO projects (id, client_id, name) VALUES ('p', 'c', 'P')`).run();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));
    const g = new FakeGmail();
    await syncAccount(db, g, ACCOUNT, { dataDir });
    g.attachments.set("a1", Buffer.from("%PDF"));
    g.deliver(
      message("old", {
        subject: "You've sent a recovery contact request",
        payload: {
          partId: "",
          mimeType: "multipart/mixed",
          filename: "",
          headers: [],
          body: { size: 0 },
          parts: [textPart("text/plain", "hi", "0"), filePart("1", "x.pdf", "application/pdf", 4, { attachmentId: "a1" })],
        },
      }),
    );
    g.deliver(message("keep"));
    await syncAccount(db, g, ACCOUNT, { dataDir });
    db.prepare(
      `INSERT INTO signals (id, project_id, message_id, type, text, evidence_json, produced_by_model) VALUES ('s1', 'p', 'old', 'ask', 't', '[]', 'm')`,
    ).run();
    expect(fs.existsSync(path.join(dataDir, "attachments", "old"))).toBe(true);

    const found = findMessages(db, { subject: "recovery contact" });
    expect(found.map((m) => m.id)).toEqual(["old"]);
    expect(removeMessages(db, found, { dataDir })).toBe(1);

    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(n(`SELECT COUNT(*) AS n FROM messages`)).toBe(1);
    expect(n(`SELECT COUNT(*) AS n FROM attachments`)).toBe(0);
    expect(n(`SELECT COUNT(*) AS n FROM signals`)).toBe(0);
    expect(n(`SELECT COUNT(*) AS n FROM threads WHERE gmail_thread_id = 't-old'`)).toBe(0);
    expect(n(`SELECT COUNT(*) AS n FROM threads WHERE gmail_thread_id = 't-keep'`)).toBe(1);
    expect(fs.existsSync(path.join(dataDir, "attachments", "old"))).toBe(false);
  });
});
