import { describe, expect, it } from "vitest";
import { approveAction } from "../src/lib/approvals";
import { gmailDraftUrl, inspect } from "../src/lib/inspect";
import type { Llm, LlmResult, ToolCall } from "../src/lib/pipeline/llm";
import { runExecutor } from "../src/lib/pipeline/execute";
import { heuristicMatcher } from "../src/lib/pipeline/resolve";
import { runReason } from "../src/lib/pipeline/review";
import { runPipeline } from "../src/lib/pipeline/run";
import { applyReprocess, planReprocess } from "../src/lib/reprocess";
import { FakeGmail } from "./helpers";
import { ANCHOR, fakeExtractor, INBOX, seededDb } from "./seed-fixture";

const ev = (id: string, q: string) => [{ kind: "message", message_id: id, quote: q }];

/** Proposes two drafts (and a task) for every email, to exercise the caps. */
function chattyLlm(db: import("../src/lib/db").DB): Llm & { reasonCalls: number } {
  const llm = {
    reasonCalls: 0,
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      const [stage, id] = (req.hint ?? "").split(":");
      let input: unknown = { items: [] };
      if (stage === "reason") {
        llm.reasonCalls++;
        const m = db.prepare(`SELECT sender_email, clean_text FROM messages WHERE gmail_message_id = ?`).get(id) as { sender_email: string; clean_text: string };
        const q = m.clean_text.split("\n").find((l) => l.trim().length > 12)!.trim().slice(0, 40);
        const draft = (n: number) => ({ tmp_id: `a${n}`, type: "draft_reply", payload: { to: [m.sender_email], subject: `Re ${n}`, body: `Reply ${n}` }, evidence: ev(id, q) });
        input = { signals: [{ tmp_id: "s1", type: "ask", text: `Ask from ${id}`, evidence: ev(id, q) }], actions: [draft(1), draft(2)] };
      } else if (stage === "review") {
        const listed = JSON.parse((req.content[1] as { text: string }).text.match(/<items_to_review>\n([\s\S]*)\n<\/items_to_review>/)![1]) as { tmp_id: string }[];
        input = { items: listed.map((i) => ({ tmp_id: i.tmp_id, verdict: "pass", score: 0.9, reason: "ok" })) };
      }
      return { input: input as T, usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0 };
    },
  };
  return llm;
}

const pair = { id: "haiku-sonnet", reason: "claude-haiku", review: "claude-sonnet" };

describe("dedupe guards", () => {
  it("one draft per email, one live draft per thread; a second processor can't double-run Reason", async () => {
    const { db, dataDir } = await seededDb();
    const llm = chattyLlm(db);
    await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: null }, { dataDir });
    // Two "processes" race over the same queue.
    await Promise.all([runReason(db, { llm, pair }, { now: ANCHOR }), runReason(db, { llm, pair }, { now: ANCHOR })]);
    expect(llm.reasonCalls).toBe(15);
    await runPipeline(db, { extractor: null, matcher: heuristicMatcher(), reasonReview: { llm, pair } }, { now: ANCHOR });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM signals`).get()).toEqual({ n: 15 });
    // 15 emails on 13 threads: replies supersede the older thread's unapproved draft.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE type = 'draft_reply' AND status = 'proposed'`).get()).toEqual({ n: 13 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE status = 'superseded'`).get()).toEqual({ n: 2 });
  });
});

describe("pipeline:reset", () => {
  it("keeps one copy of each of the 15 seed emails, clears output, and requeues them", async () => {
    const { db, dataDir } = await seededDb();
    await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm: chattyLlm(db), pair } }, { dataDir, now: ANCHOR });
    // Extra mail: a duplicate copy of a seed email and a non-seed email.
    const t = db.prepare(`SELECT thread_id, rfc_message_id FROM messages LIMIT 1`).get() as { thread_id: string; rfc_message_id: string };
    const ins = db.prepare(
      `INSERT INTO messages (gmail_message_id, thread_id, account, rfc_message_id, subject, received_at, body_source, raw_text, clean_text, status)
       VALUES (?, ?, ?, ?, ?, '2026-10-17T12:00:00Z', 'text/plain', 'x', 'x', 'reviewed')`,
    );
    ins.run("dup1", t.thread_id, INBOX, t.rfc_message_id, "dup");
    ins.run("other1", t.thread_id, INBOX, "<random@x.com>", "Other");

    const plan = planReprocess(db);
    expect(plan.keep).toHaveLength(15);
    expect(plan.remove.map((m) => [m.id, m.why]).sort()).toEqual([["dup1", "duplicate copy"], ["other1", "not a seed email"]]);
    expect(plan.outputs.signals).toBeGreaterThan(0);

    applyReprocess(db, plan, { dataDir });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 15 });
    for (const tname of ["signals", "insights", "actions", "model_reviews", "pipeline_runs"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${tname}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`).all()).toEqual([{ status: "resolved", n: 15 }]);

    // Processing again runs Reason once per email.
    const llm = chattyLlm(db);
    await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm, pair } }, { dataDir, now: ANCHOR });
    expect(llm.reasonCalls).toBe(15);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM signals`).get()).toEqual({ n: 15 });
  });
});

describe("audit trail shows the Gmail draft", () => {
  it("after approval: decision, then drafts.create with a link to the draft", async () => {
    const { db, dataDir } = await seededDb();
    await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm: chattyLlm(db), pair } }, { dataDir, now: ANCHOR });
    const id = (db.prepare(`SELECT id FROM actions WHERE type = 'draft_reply' AND status = 'proposed' LIMIT 1`).get() as { id: string }).id;
    expect(inspect(db, { type: "action", id })!.approval).toMatchObject({ status: "proposed", executedAt: null, gmailDraftUrl: null });
    approveAction(db, id);
    await runExecutor(db, () => new FakeGmail());
    const a = inspect(db, { type: "action", id })!.approval!;
    expect(a.status).toBe("executed");
    expect(a.gmailDraftId).toBe("draft-1");
    expect(a.executedAt).toBeTruthy();
    expect(a.account).toBe(INBOX);
    expect(a.gmailDraftUrl).toBe(`https://mail.google.com/mail/u/${encodeURIComponent(INBOX)}/#drafts?compose=msg-draft-1`);
    expect(gmailDraftUrl(null, null)).toBe("https://mail.google.com/mail/u/0/#drafts");
  });
});
