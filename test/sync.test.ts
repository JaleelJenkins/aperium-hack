import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/lib/db";
import { syncAccount } from "../src/lib/ingest/sync";
import { FakeGmail, filePart, message, textPart } from "./helpers";

const ACCOUNT = "pulse-test@gmail.com";
let db: DB;
let gmail: FakeGmail;
let dataDir: string;
const opts = () => ({ dataDir, bootstrapDays: 7, bootstrapMax: 50 });

beforeEach(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO gmail_accounts (email, refresh_token) VALUES (?, 'rt')`).run(ACCOUNT);
  gmail = new FakeGmail();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-test-"));
});

const cursor = () => (db.prepare(`SELECT history_id FROM gmail_accounts`).get() as { history_id: string | null }).history_id;
const emailIds = () =>
  (db.prepare(`SELECT gmail_message_id AS id FROM messages ORDER BY received_at`).all() as { id: string }[]).map((r) => r.id);

describe("syncAccount", () => {
  it("bootstraps existing inbox mail, oldest first, then sets the history cursor", async () => {
    gmail.deliver(message("a", { internalDate: 1 }));
    gmail.deliver(message("b", { internalDate: 2 }));
    const r = await syncAccount(db, gmail, ACCOUNT, opts());
    expect(r.mode).toBe("bootstrap");
    expect(r.newEmailIds).toEqual(["a", "b"]);
    expect(cursor()).toBe(String(gmail.historyId));
    expect(emailIds()).toEqual(["a", "b"]);
  });

  it("picks up only new mail from history on the next poll, without refetching", async () => {
    gmail.deliver(message("a"));
    await syncAccount(db, gmail, ACCOUNT, opts());
    gmail.calls.getMessage = [];

    gmail.deliver(message("c"));
    const r = await syncAccount(db, gmail, ACCOUNT, opts());
    expect(r.mode).toBe("history");
    expect(r.newEmailIds).toEqual(["c"]);
    expect(gmail.calls.getMessage).toEqual(["c"]);

    const again = await syncAccount(db, gmail, ACCOUNT, opts());
    expect(again.newEmailIds).toEqual([]);
  });

  it("skips our own drafts and sent mail", async () => {
    await syncAccount(db, gmail, ACCOUNT, opts());
    gmail.deliver(message("draft", { labelIds: ["DRAFT"] }));
    gmail.deliver(message("sent", { labelIds: ["SENT"] }));
    gmail.deliver(message("in", { labelIds: ["INBOX"] }));
    const r = await syncAccount(db, gmail, ACCOUNT, opts());
    expect(r.newEmailIds).toEqual(["in"]);
    expect(gmail.calls.getMessage).toEqual(["in"]);
  });

  it("does not advance the cursor when a message fails, then recovers", async () => {
    await syncAccount(db, gmail, ACCOUNT, opts());
    const before = cursor();
    gmail.deliver(message("ok1"));
    gmail.deliver(message("flaky"));
    gmail.failGet.add("flaky");

    const r1 = await syncAccount(db, gmail, ACCOUNT, opts());
    expect(r1.newEmailIds).toEqual(["ok1"]);
    expect(r1.failed.map((f) => f.id)).toEqual(["flaky"]);
    expect(cursor()).toBe(before);

    gmail.failGet.clear();
    const r2 = await syncAccount(db, gmail, ACCOUNT, opts());
    expect(r2.newEmailIds).toEqual(["flaky"]);
    expect(r2.existing).toBe(1);
    expect(cursor()).toBe(String(gmail.historyId));
  });

  it("re-bootstraps when Gmail says the history cursor expired", async () => {
    gmail.deliver(message("a"));
    await syncAccount(db, gmail, ACCOUNT, opts());
    gmail.deliver(message("b"));
    gmail.expired = true;
    const r = await syncAccount(db, gmail, ACCOUNT, opts());
    expect(r.mode).toBe("bootstrap");
    expect(r.newEmailIds).toEqual(["b"]);
    const actions = (db.prepare(`SELECT verb FROM audit_events`).all() as { verb: string }[]).map((x) => x.verb);
    expect(actions).toContain("sync.history_expired");
  });

  it("stores PDFs and images on disk and records skipped files", async () => {
    await syncAccount(db, gmail, ACCOUNT, opts());
    const pdf = Buffer.from("%PDF-1.4 fake");
    gmail.attachments.set("att-pdf", pdf);
    gmail.attachments.set("att-logo", Buffer.alloc(800));
    gmail.deliver(
      message("withfiles", {
        payload: {
          partId: "",
          mimeType: "multipart/mixed",
          filename: "",
          headers: [],
          body: { size: 0 },
          parts: [
            textPart("text/plain", "Contract attached.", "0"),
            filePart("1", "SOW v2.pdf", "application/pdf", pdf.length, { attachmentId: "att-pdf" }),
            filePart("2", "logo.png", "image/png", 800, { attachmentId: "att-logo", contentId: "logo@x", inline: true }),
            filePart("4", "voice-memo.m4a", "audio/mp4", 90_000, { attachmentId: "att-audio" }),
            filePart("3", "notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 5000, {
              attachmentId: "att-docx",
            }),
          ],
        },
      }),
    );
    await syncAccount(db, gmail, ACCOUNT, opts());

    const rows = db
      .prepare(`SELECT filename, kind, status, storage_path, sha256 FROM attachments ORDER BY part_id`)
      .all() as { filename: string; kind: string; status: string; storage_path: string | null; sha256: string | null }[];
    expect(rows.map((r) => [r.filename, r.kind, r.status])).toEqual([
      ["SOW v2.pdf", "pdf", "stored"],
      ["logo.png", "image", "skipped"],
      ["notes.docx", "other", "skipped"],
      ["voice-memo.m4a", "audio", "skipped"],
    ]);
    expect(fs.readFileSync(path.join(dataDir, rows[0].storage_path!)).toString()).toBe("%PDF-1.4 fake");
    expect(rows[0].sha256).toHaveLength(64);

    const msg = db
      .prepare(`SELECT status, clean_text, thread_id FROM messages WHERE gmail_message_id = 'withfiles'`)
      .get() as { status: string; clean_text: string; thread_id: string };
    expect(msg).toMatchObject({ status: "ingested", clean_text: "Contract attached." });
    const thread = db.prepare(`SELECT subject, project_id FROM threads WHERE gmail_thread_id = ?`).get(msg.thread_id);
    expect(thread).toEqual({ subject: "Subject withfiles", project_id: null });
  });
});
