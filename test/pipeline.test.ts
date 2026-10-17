import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/lib/db";
import { checkEvidence } from "../src/lib/evidence";
import { syncAccount } from "../src/lib/ingest/sync";
import { claudeExtractor, runExtract, type Extractor } from "../src/lib/pipeline/extract";
import type { Llm, ToolCall } from "../src/lib/pipeline/llm";
import { claudeMatcher, clientFor, heuristicMatcher, runResolve, type Matcher } from "../src/lib/pipeline/resolve";
import { runPipeline } from "../src/lib/pipeline/run";
import { applySeed, readSeed } from "../src/lib/seed";
import { buildSeedMessages, SEED_ASSETS_DIR } from "../src/lib/seed-inbox";
import { FakeGmail, message, toGmailMessage } from "./helpers";

const INBOX = "test.aperium.ai@gmail.com";
const ANCHOR = new Date("2026-10-17T12:00:00-07:00");

/** Stand-in for Claude: what a correct extraction of each seed attachment contains. */
const PAGES: Record<string, string[]> = {
  "harbor-lobby-floor-plan.pdf": [
    "LEVEL 1 (GROUND) - MARKED-UP PLAN\nELEVATORS RECEPTION DESK SEATING\nShift desk 1.2 m east",
    "LEVEL 2 (MEZZANINE) - MARKED-UP PLAN\nSCOPE OF WORK\nLobby redesign covers 2 levels: Level 1 (Ground) and Level 2 (Mezzanine).\nLevel 3 (tenant floor) is NOT IN SCOPE.",
  ],
  "lumen-quote-Q-2026-118.pdf": ["Northbeam Studio\nQuote Q-2026-118\nSTATUS: PROPOSED\nTotal (excl. tax) $12,400.00\nClient acceptance\nSignature"],
};
const fakeExtractor: Extractor = {
  model: "fake-extract",
  async pdf(_d, filename) {
    return { pages: PAGES[filename] ?? [`${filename} page 1`], summary: `Summary of ${filename}` };
  },
  async image(_d, _m, filename) {
    return { description: `Screenshot ${filename}`, text: "" };
  },
};

/** Ingest the full seed inbox exactly as Gmail would deliver it. */
async function seededDb(): Promise<{ db: DB; dataDir: string; idOf: Map<string, string> }> {
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

const projectOf = (db: DB, messageId: string) =>
  (db.prepare(`SELECT t.project_id FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id WHERE m.gmail_message_id = ?`).get(messageId) as {
    project_id: string | null;
  }).project_id;

describe("Extract + Resolve on the seed inbox", () => {
  it("files all 15 seed emails to their labeled project, with evidence-ready attachments", async () => {
    const { db, dataDir, idOf } = await seededDb();
    const r = await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher() }, { dataDir });

    expect(r.extract!.messages).toBe(15);
    expect(r.extract!.attachments).toBe(10);
    expect(r.extract!.failed).toEqual([]);
    expect(r.resolve.failed).toEqual([]);
    expect(r.resolve.cards).toEqual([]);

    const labels = JSON.parse(fs.readFileSync("seed/labels.json", "utf8")).emails as { key: string; project_id: string }[];
    const wrong = labels.filter((l) => projectOf(db, idOf.get(l.key)!) !== l.project_id).map((l) => l.key);
    expect(wrong).toEqual([]);

    // 2 replies inherit their thread's project; 13 threads are matched.
    expect(r.resolve.assigned).toHaveLength(13);
    expect(r.resolve.inherited).toBe(2);
    const statuses = db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`).all();
    expect(statuses).toEqual([{ status: "resolved", n: 15 }]);

    // Extracted PDF pages back the evidence checker: trap 1's contradiction is citable on p.2.
    const plan = db.prepare(`SELECT id FROM attachments WHERE filename = 'harbor-lobby-floor-plan.pdf'`).get() as { id: string };
    expect(checkEvidence(db, { kind: "attachment_page", attachment_id: plan.id, page: 2, quote: "covers 2 levels" })).toEqual({ ok: true });
    expect(checkEvidence(db, { kind: "attachment_page", attachment_id: plan.id, page: 1, quote: "covers 2 levels" }).ok).toBe(false);

    // Free-mail sender resolved by contact; last contact recorded.
    expect(clientFor(db, "amara.okafor.md@gmail.com")?.id).toBe("lumen-clinic");
    expect(clientFor(db, "someone@harborpine.com")?.id).toBe("harbor-pine");
    const last = db.prepare(`SELECT last_contact_at FROM projects WHERE id = 'harbor-lobby'`).get() as { last_contact_at: string };
    expect(Date.parse(last.last_contact_at)).toBe(ANCHOR.getTime() - 2 * 3_600_000);

    // Running again is a no-op.
    const again = await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher() }, { dataDir });
    expect(again.extract!.messages).toBe(0);
    expect(again.resolve.assigned).toHaveLength(0);
  });

  it("without an API key, still files threads; messages wait in ingested for extraction", async () => {
    const { db } = await seededDb();
    const r = await runPipeline(db, { extractor: null, matcher: heuristicMatcher() });
    expect(r.extract).toBeNull();
    expect(r.resolve.assigned).toHaveLength(13);
    const statuses = db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`).all();
    expect(statuses).toEqual([{ status: "ingested", n: 15 }]);

    // Key added later: extraction runs, and already-filed threads advance to resolved.
    await runExtract(db, fakeExtractor);
    const r2 = await runResolve(db, heuristicMatcher());
    expect(r2.inherited).toBe(15);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'resolved'`).get()).toEqual({ n: 15 });
  });
});

describe("Resolve edge cases", () => {
  async function oneEmail(from: string, subject: string, body: string) {
    const db = openDb(":memory:");
    applySeed(db, readSeed());
    db.prepare(`INSERT INTO gmail_accounts (email, refresh_token) VALUES (?, 'rt')`).run(INBOX);
    const g = new FakeGmail();
    await syncAccount(db, g, INBOX, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "edge-")) });
    g.deliver(message("x1", { from, subject, threadId: "tx" }));
    const msg = g.messages.get("x1")!;
    msg.payload!.body = { size: body.length, data: Buffer.from(body).toString("base64url") };
    await syncAccount(db, g, INBOX, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "edge-")) });
    return { db, g };
  }
  const fixed = (r: { project_id: string | null; confidence: number }): Matcher => ({
    model: "fake-match",
    async match() {
      return { ...r, reason: "fixed", new_project_name: r.project_id ? null : "Patient newsletter" };
    },
  });

  it("unknown sender: New project? card, thread left unassigned", async () => {
    const { db } = await oneEmail("Stranger <hi@unknown.example>", "Partnership", "Would you like to partner?");
    const r = await runResolve(db, heuristicMatcher());
    expect(r.cards).toHaveLength(1);
    const a = db.prepare(`SELECT type, project_id, status, payload_json, evidence_json FROM actions`).get() as Record<string, string>;
    expect(a).toMatchObject({ type: "new_project", project_id: null, status: "proposed" });
    expect(JSON.parse(a.payload_json).suggested_name).toBe("Partnership");
    expect(checkEvidence(db, JSON.parse(a.evidence_json)[0]).ok).toBe(true);
    expect(projectOf(db, "x1")).toBeNull();
  });

  it("known client, low confidence: card names the closest project; no duplicate card on rerun", async () => {
    const { db } = await oneEmail("Kelly <kelly.tran@lumenclinic.com>", "Newsletter", "Can you set up a monthly patient newsletter?");
    await runResolve(db, fixed({ project_id: "lumen-website", confidence: 0.55 }));
    await runResolve(db, fixed({ project_id: "lumen-website", confidence: 0.55 }));
    const rows = db.prepare(`SELECT payload_json FROM actions WHERE type = 'new_project'`).all() as { payload_json: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({ client_id: "lumen-clinic", closest_project_name: "Website refresh", confidence: 0.55 });
    expect((db.prepare(`SELECT client_id FROM threads WHERE gmail_thread_id = 'tx'`).get() as { client_id: string }).client_id).toBe("lumen-clinic");
  });

  it("confident match records who assigned it and why", async () => {
    const { db } = await oneEmail("Kelly <kelly.tran@lumenclinic.com>", "Booking", "The booking calendar is down.");
    await runResolve(db, fixed({ project_id: "lumen-booking", confidence: 0.93 }));
    expect(db.prepare(`SELECT project_id, assignment_confidence, assigned_by, assignment_reason FROM threads WHERE gmail_thread_id = 'tx'`).get()).toEqual({
      project_id: "lumen-booking",
      assignment_confidence: 0.93,
      assigned_by: "fake-match",
      assignment_reason: "fixed",
    });
  });
});

describe("Claude adapters (request shape)", () => {
  function recordingLlm(reply: unknown): { llm: Llm; calls: ToolCall<unknown>[] } {
    const calls: ToolCall<unknown>[] = [];
    return {
      calls,
      llm: {
        async call<T>(req: ToolCall<T>) {
          calls.push(req as ToolCall<unknown>);
          return { input: reply as T, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
  }

  it("sends PDFs as a document block with a forced tool, and orders pages", async () => {
    const { llm, calls } = recordingLlm({ pages: [{ page: 2, text: "B" }, { page: 1, text: "A" }], summary: "s" });
    const out = await claudeExtractor(llm, "claude-sonnet-5-5").pdf(Buffer.from("%PDF"), "plan.pdf");
    expect(out.pages).toEqual(["A", "B"]);
    expect(calls[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    expect(calls[0].tool.name).toBe("record_pdf");
  });

  it("matcher restricts project_id to the client's candidates and drops unknown ids", async () => {
    const { llm, calls } = recordingLlm({ project_id: "someone-elses-project", confidence: 0.99, reason: "x" });
    const r = await claudeMatcher(llm, "claude-haiku-5-5").match(
      { clientName: "Lumen", sender: "a@b.c", subject: "s", text: "t", attachments: [] },
      [{ id: "lumen-website", name: "Website refresh", summary: "" }],
    );
    expect((calls[0].tool.input_schema.properties as Record<string, { enum: string[] }>).project_id.enum).toEqual(["lumen-website", "new"]);
    expect(r.project_id).toBeNull();
  });
});
