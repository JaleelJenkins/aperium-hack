import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ReasonOutput, type Evidence } from "../src/lib/contracts";
import { decrypt, encrypt } from "../src/lib/crypto";
import { openDb, type DB } from "../src/lib/db";
import { checkEvidence, evidenceHref, keepSupported, quoteLine } from "../src/lib/evidence";
import { disconnectAccount, listAccounts, saveAccount } from "../src/lib/gmail/client";
import { applySeed, readSeed, resetToSeed } from "../src/lib/seed";

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
});

function dbWithMessage(): DB {
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO threads (gmail_thread_id, account) VALUES ('t1', 'a@x.com')`).run();
  db.prepare(
    `INSERT INTO messages (gmail_message_id, thread_id, account, received_at, body_source, raw_text, clean_text)
     VALUES ('m1', 't1', 'a@x.com', '2026-10-17T00:00:00Z', 'text/plain', '', ?)`,
  ).run("Hi team,\n\nThe lobby covers three floors.\nNeed the revised quote\nby Friday.");
  db.prepare(
    `INSERT INTO attachments (id, message_id, part_id, filename, mime_type, kind, status, meta_json)
     VALUES ('m1:1', 'm1', '1', 'plan.pdf', 'application/pdf', 'pdf', 'extracted', ?)`,
  ).run(JSON.stringify({ pages: 2, pageText: ["Ground floor plan", "Level 2 plan. Total: 2 floors"] }));
  return db;
}

describe("evidence: it doesn't ship without it", () => {
  const db = dbWithMessage();

  it("accepts verbatim quotes, including across line breaks and whitespace", () => {
    expect(checkEvidence(db, { kind: "message", message_id: "m1", quote: "revised quote by  Friday" })).toEqual({ ok: true });
  });

  it("rejects quotes the message doesn't contain", () => {
    const r = checkEvidence(db, { kind: "message", message_id: "m1", quote: "client approved the quote" });
    expect(r).toEqual({ ok: false, reason: "quote not found in message" });
  });

  it("checks PDF page bounds and page text", () => {
    expect(checkEvidence(db, { kind: "attachment_page", attachment_id: "m1:1", page: 2, quote: "2 floors" })).toEqual({ ok: true });
    expect(checkEvidence(db, { kind: "attachment_page", attachment_id: "m1:1", page: 3 }).ok).toBe(false);
    expect(checkEvidence(db, { kind: "attachment_page", attachment_id: "m1:1", page: 1, quote: "3 floors" }).ok).toBe(false);
  });

  it("drops items left with no valid evidence and keeps the valid pointers", () => {
    const good: Evidence = { kind: "message", message_id: "m1", quote: "three floors" };
    const bad: Evidence = { kind: "message", message_id: "nope", quote: "anything" };
    const { kept, dropped } = keepSupported(db, [
      { text: "A", evidence: [good, bad] },
      { text: "B", evidence: [bad] },
    ]);
    expect(kept).toEqual([{ text: "A", evidence: [good] }]);
    expect(dropped.map((d) => d.item.text)).toEqual(["B"]);
    expect(dropped[0].reasons).toEqual(["unknown message nope"]);
  });

  it("links evidence to the exact line or page", () => {
    const clean = "Hi team,\n\nThe lobby covers three floors.";
    expect(quoteLine(clean, "covers three")).toBe(3);
    expect(evidenceHref({ kind: "message", message_id: "m1", quote: "covers three" }, clean)).toBe("/messages/m1#L3");
    expect(evidenceHref({ kind: "attachment_page", attachment_id: "m1:1", page: 2 })).toBe("/api/attachments/m1%3A1#page=2");
  });
});

describe("Reason output contract", () => {
  it("parses a valid output and rejects an item with no evidence", () => {
    const base = {
      client_guess: { client_id: "harbor-pine", name: "Harbor & Pine", confidence: 0.95 },
      project_match: { project_id: "harbor-lobby", confidence: 0.9 },
      signals: [
        { type: "ask", text: "Revised quote", due_at: "2026-10-23", evidence: [{ kind: "message", message_id: "m1", quote: "revised quote" }] },
      ],
    };
    const ok = ReasonOutput.parse(base);
    expect(ok.insights).toEqual([]);
    expect(ok.project_match.new_project_name).toBeNull();
    expect(() => ReasonOutput.parse({ ...base, signals: [{ ...base.signals[0], evidence: [] }] })).toThrow();
  });
});

describe("tokens and disconnect", () => {
  it("encrypts tokens at rest", () => {
    const sealed = encrypt("1//refresh-token");
    expect(sealed).not.toContain("refresh-token");
    expect(decrypt(sealed)).toBe("1//refresh-token");
  });

  it("disconnect wipes tokens and stored mail but keeps clients and projects", () => {
    const db = dbWithMessage();
    applySeed(db, readSeed());
    saveAccount(db, "a@x.com", { refresh_token: "rt" });
    expect(decrypt(listAccounts(db)[0].refresh_token)).toBe("rt");

    expect(disconnectAccount(db, "a@x.com")).toEqual({ messages: 1 });
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count("gmail_accounts"), count("messages"), count("attachments"), count("threads")]).toEqual([0, 0, 0, 0]);
    expect(count("projects")).toBe(5);
  });
});

describe("seed", () => {
  it("loads 3 clients, 5 projects, model profiles and default prefs; reset restores it", () => {
    const db = openDb(":memory:");
    const seed = readSeed();
    const warnings = applySeed(db, seed);
    expect(warnings.length).toBeGreaterThan(0); // placeholder contacts are flagged
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count("clients"), count("projects"), count("model_profiles"), count("user_model_prefs")]).toEqual([3, 5, 3, 2]);

    db.prepare(`INSERT INTO projects (id, client_id, name, status) VALUES ('ai-new', 'lumen-clinic', 'Proposed', 'proposed')`).run();
    db.prepare(`UPDATE projects SET summary = 'changed', health = 'blocked' WHERE id = 'harbor-lobby'`).run();
    resetToSeed(db, seed);
    expect(count("projects")).toBe(5);
    expect(db.prepare(`SELECT summary, health FROM projects WHERE id = 'harbor-lobby'`).get()).toEqual({
      summary: seed.projects[0].summary,
      health: "on_track",
    });
  });
});
