import { describe, expect, it } from "vitest";
import type { DB } from "../src/lib/db";
import { approveAction, decideNewProject, editAndApproveAction, rejectAction } from "../src/lib/approvals";
import { getBoard } from "../src/lib/board";
import { caughtClaims, inspect } from "../src/lib/inspect";
import type { Llm, LlmResult, ToolCall } from "../src/lib/pipeline/llm";
import { buildReplyMime, retryAction, runExecutor } from "../src/lib/pipeline/execute";
import { heuristicMatcher } from "../src/lib/pipeline/resolve";
import { runPipeline } from "../src/lib/pipeline/run";
import { createRule, hardRuleViolation, listRules, renderRules, rulesForProject, setRuleEnabled } from "../src/lib/rules";
import { FakeGmail } from "./helpers";
import { ANCHOR, fakeExtractor, INBOX, seededDb } from "./seed-fixture";

const msgEv = (id: string, quote: string) => ({ kind: "message", message_id: id, quote });

/**
 * Reason proposes, for the Harbor floor-plan email: a reply to Dana promising a date,
 * a task, and a signal mentioning "rush fee". The reviewer cites team rule R1 when present.
 */
function fakeLlm(idOf: Map<string, string>, opts: { citeRule?: string } = {}): Llm & { calls: ToolCall<unknown>[] } {
  const harbor = idOf.get("harbor-01-floor-plan")!;
  const calls: ToolCall<unknown>[] = [];
  return {
    calls,
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      calls.push(req as ToolCall<unknown>);
      const [stage, id] = (req.hint ?? "").split(":");
      let input: unknown = { signals: [], insights: [], actions: [], closes_signal_ids: [] };
      if (stage === "reason" && id === harbor) {
        input = {
          signals: [{ tmp_id: "s1", type: "risk", text: "Client may push for a rush fee waiver", evidence: [msgEv(harbor, "Confirm the revised scope and fee")] }],
          actions: [
            {
              tmp_id: "a1",
              type: "draft_reply",
              payload: { to: ["dana@harborpine.com"], subject: "Re: Lobby redesign: marked-up floor plan", body: "Hi Dana, we'll have the lighting concept to you by Friday." },
              evidence: [msgEv(harbor, "A lighting concept for the reception desk")],
            },
            {
              tmp_id: "a2",
              type: "internal_task",
              payload: { title: "Price the revised scope", notes: "Levels 1-2 only" },
              evidence: [msgEv(harbor, "Confirm the revised scope and fee")],
            },
          ],
        };
      } else if (stage === "review") {
        const listed = JSON.parse((req.content[1] as { text: string }).text.match(/<items_to_review>\n([\s\S]*)\n<\/items_to_review>/)![1]) as { tmp_id: string }[];
        input = {
          items: listed.map((i) =>
            i.tmp_id === "a1" && opts.citeRule
              ? { tmp_id: "a1", verdict: "block", score: 0.2, reason: "Promises a delivery date the PM hasn't confirmed.", rule_ids: [opts.citeRule] }
              : { tmp_id: i.tmp_id, verdict: "pass", score: 0.9, reason: "Supported." },
          ),
        };
      }
      return { input: input as T, usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0, provider: "fake" };
    },
  };
}

async function piped(opts: { citeRule?: string; before?: (db: DB) => void } = {}) {
  const s = await seededDb();
  s.db.prepare(`UPDATE messages SET rfc_message_id = '<seed.' || gmail_message_id || '@northbeam.seed>' WHERE rfc_message_id IS NULL`).run();
  opts.before?.(s.db);
  const llm = fakeLlm(s.idOf, opts);
  await runPipeline(s.db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm, pair: { id: "haiku-sonnet", reason: "claude-haiku", review: "claude-sonnet" } } }, { dataDir: s.dataDir, now: ANCHOR });
  const action = (type: string) => s.db.prepare(`SELECT * FROM actions WHERE type = ?`).get(type) as Record<string, string> | undefined;
  return { ...s, llm, action };
}

describe("review rules (the approval review step)", () => {
  it("validates, numbers and scopes rules", async () => {
    const { db } = await seededDb();
    const g = createRule(db, { scope: "global", kind: "instruction", text: "Never promise a delivery date the PM hasn't confirmed.", appliesTo: "draft_reply" });
    const c = createRule(db, { scope: "client", clientId: "vector-freight", kind: "block_phrase", text: "guaranteed" });
    const p = createRule(db, { scope: "project", projectId: "harbor-lobby", kind: "block_domain", text: "ap@Lumen-Clinic-Payments.com" });
    expect([g.code, c.code, p.code]).toEqual(["R1", "R2", "R3"]);
    expect(p.text).toBe("lumen-clinic-payments.com");
    expect(p.clientId).toBe("harbor-pine");
    expect(() => createRule(db, { scope: "global", kind: "instruction", text: "short" })).toThrow(/full sentence/);
    expect(() => createRule(db, { scope: "project", kind: "instruction", text: "A rule with no project picked" })).toThrow(/Pick the project/);

    expect(rulesForProject(db, "harbor-lobby").map((r) => r.code)).toEqual(["R1", "R3"]);
    expect(rulesForProject(db, "vector-driver-pilot").map((r) => r.code)).toEqual(["R1", "R2"]);
    setRuleEnabled(db, g.id, false);
    expect(rulesForProject(db, "harbor-lobby").map((r) => r.code)).toEqual(["R3"]);
    expect(listRules(db)).toHaveLength(3);

    const text = renderRules(rulesForProject(db, "vector-driver-pilot"));
    expect(text).toContain('R2 (all items; enforced in code): never include "guaranteed"');
    expect(hardRuleViolation(rulesForProject(db, "harbor-lobby"), "action", "draft_reply", "hi", ["x@billing.lumen-clinic-payments.com"])?.rule.code).toBe("R3");
    expect(hardRuleViolation(rulesForProject(db, "harbor-lobby"), "signal", undefined, "lumen-clinic-payments.com")).toBeNull();
  });

  it("Reason and Review both get the rules; a cited rule blocks, is logged and counted", async () => {
    let ruleId = "";
    const { db, llm, action } = await piped({
      citeRule: "R1",
      before: (db) => {
        ruleId = createRule(db, { scope: "project", projectId: "harbor-lobby", kind: "instruction", text: "Never promise a delivery date the PM hasn't confirmed.", appliesTo: "draft_reply" }).id;
      },
    });
    const reasonCall = llm.calls.find((c) => c.hint?.startsWith("reason:") && JSON.stringify(c.content).includes("Lobby redesign"))!;
    expect(JSON.stringify(reasonCall.content)).toContain("R1 (draft replies; on violation: block): Never promise a delivery date");
    expect(reasonCall.system).toContain("<team_rules>");
    const reviewCall = llm.calls.find((c) => c.hint?.startsWith("review:"))!;
    expect(reviewCall.system).toContain("rule_ids");

    expect(action("draft_reply")).toBeUndefined();
    const caught = caughtClaims(db).find((c) => c.rule)!;
    expect(caught.rule).toEqual({ code: "R1", text: "Never promise a delivery date the PM hasn't confirmed." });
    expect(caught.notes).toMatch(/^R1: /);
    expect(caught.blockedBy).toBe("review");
    expect((db.prepare(`SELECT hits FROM review_rules WHERE id = ?`).get(ruleId) as { hits: number }).hits).toBe(1);
    // Rules scoped to Harbor never reach other clients' prompts.
    const vectorCall = llm.calls.find((c) => c.hint?.startsWith("reason:") && JSON.stringify(c.content).includes("vectorfreight"))!;
    expect(JSON.stringify(vectorCall.content)).not.toContain("team_rules");
  });

  it("code rules run after the model passes an item", async () => {
    const { db, action } = await piped({
      before: (db) => {
        createRule(db, { scope: "global", kind: "block_phrase", text: "rush fee", appliesTo: "signal" });
        createRule(db, { scope: "client", clientId: "harbor-pine", kind: "block_domain", text: "harborpine.com" });
      },
    });
    expect(action("draft_reply")).toBeUndefined();
    expect(action("internal_task")).toBeTruthy();
    const byRule = caughtClaims(db).filter((c) => c.rule);
    expect(byRule.map((c) => [c.rule!.code, c.blockedBy]).sort()).toEqual([
      ["R1", "policy"],
      ["R2", "policy"],
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM signals WHERE text LIKE '%rush fee%'`).get()).toEqual({ n: 0 });
  });
});

describe("approval queue", () => {
  it("approve -> Gmail draft in the thread (never send)", async () => {
    const { db, action } = await piped();
    const draft = action("draft_reply")!;
    expect(draft.status).toBe("proposed");
    const info = inspect(db, { type: "action", id: draft.id })!;
    expect(info.approval).toMatchObject({ type: "draft_reply", status: "proposed", projectName: "Lobby redesign" });

    approveAction(db, draft.id);
    const gmail = new FakeGmail();
    const r = await runExecutor(db, (acct) => (acct === INBOX ? gmail : null));
    expect(r).toMatchObject({ drafts: 1, tasks: 0, failed: [] });
    expect(gmail.drafts).toHaveLength(1);
    const raw = gmail.drafts[0].raw;
    expect(gmail.drafts[0].threadId).toBe(draft.thread_id);
    expect(raw).toContain("To: dana@harborpine.com");
    expect(raw).toMatch(/In-Reply-To: <seed\.[^>]+>/);
    expect(Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString()).toContain("lighting concept");
    const after = db.prepare(`SELECT status, gmail_draft_id, decided_by FROM actions WHERE id = ?`).get(draft.id);
    expect(after).toEqual({ status: "executed", gmail_draft_id: "draft-1", decided_by: "user" });
    expect(() => approveAction(db, draft.id)).toThrow(/Already decided/);
  });

  it("approved task becomes an open 'We owe' item", async () => {
    const { db, action } = await piped();
    const task = action("internal_task")!;
    approveAction(db, task.id);
    await runExecutor(db, () => null);
    expect(db.prepare(`SELECT status FROM actions WHERE id = ?`).get(task.id)).toEqual({ status: "executed" });
    const s = db.prepare(`SELECT type, status, text FROM signals WHERE text LIKE 'Price the revised scope%'`).get();
    expect(s).toEqual({ type: "our_commitment", status: "open", text: "Price the revised scope: Levels 1-2 only" });
    const lane = getBoard(db, { now: ANCHOR.getTime() }).clients.find((c) => c.id === "harbor-pine")!.lanes.find((l) => l.id === "harbor-lobby")!;
    expect(lane.columns.on_us.map((c) => c.title)).toContain("Price the revised scope: Levels 1-2 only");
  });

  it("edit keeps the model's version, and refuses unknown recipients and blocked phrases", async () => {
    const { db, action } = await piped();
    const draft = action("draft_reply")!;
    expect(() => editAndApproveAction(db, draft.id, { to: ["someone@elsewhere.com"] })).toThrow(/isn't a known contact/);
    createRule(db, { scope: "project", projectId: "harbor-lobby", kind: "block_phrase", text: "by Friday" });
    expect(() => editAndApproveAction(db, draft.id, { body: "We'll send it by Friday." })).toThrow(/Blocked by rule R1/);
    editAndApproveAction(db, draft.id, { body: "Hi Dana, I'll confirm a date for the lighting concept tomorrow." });
    const row = db.prepare(`SELECT status, payload_json, original_payload_json FROM actions WHERE id = ?`).get(draft.id) as Record<string, string>;
    expect(row.status).toBe("edited");
    expect(JSON.parse(row.payload_json).body).toMatch(/confirm a date/);
    expect(JSON.parse(row.original_payload_json).body).toMatch(/by Friday/);
    expect(inspect(db, { type: "action", id: draft.id })!.approval!.original!.body).toMatch(/by Friday/);
  });

  it("saving an edit with no changes is a plain approval", async () => {
    const { db, action } = await piped();
    const task = action("internal_task")!;
    editAndApproveAction(db, task.id, {});
    expect(db.prepare(`SELECT status, original_payload_json FROM actions WHERE id = ?`).get(task.id)).toEqual({ status: "approved", original_payload_json: null });
  });

  it("reject needs a reason and can save it as a rule that future emails are reviewed against", async () => {
    const { db, action } = await piped();
    const draft = action("draft_reply")!;
    expect(() => rejectAction(db, draft.id, "no")).toThrow(/Say why/);
    const rule = rejectAction(db, draft.id, "Don't commit to dates in replies; the PM confirms dates on a call.", "user", { scope: "client" })!;
    expect(rule).toMatchObject({ code: "R1", scope: "client", clientId: "harbor-pine", appliesTo: "draft_reply", kind: "instruction", source: "rejection", sourceRef: draft.id });
    expect(db.prepare(`SELECT status, decision_reason FROM actions WHERE id = ?`).get(draft.id)).toEqual({
      status: "rejected",
      decision_reason: "Don't commit to dates in replies; the PM confirms dates on a call.",
    });
    expect(renderRules(rulesForProject(db, "harbor-lobby"))).toContain("the PM confirms dates on a call");
  });

  it("executor failure is kept on the card and can be retried", async () => {
    const { db, action } = await piped();
    const draft = action("draft_reply")!;
    approveAction(db, draft.id);
    const gmail = new FakeGmail();
    gmail.failDrafts = true;
    const r = await runExecutor(db, () => gmail);
    expect(r.failed[0].error).toMatch(/gmail.compose/);
    const card = getBoard(db, { now: ANCHOR.getTime() }).clients.flatMap((c) => c.lanes).flatMap((l) => l.columns.approval).find((c) => c.id === draft.id)!;
    expect(card.status).toMatch(/^failed: insufficient permission/);
    gmail.failDrafts = false;
    retryAction(db, draft.id);
    expect((await runExecutor(db, () => gmail)).drafts).toBe(1);
  });

  it("buildReplyMime encodes non-ASCII subjects", () => {
    const raw = buildReplyMime({ from: "a@x.com", to: ["b@y.com"], subject: "Re: Café plan", body: "ok", inReplyTo: null, references: null });
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).not.toContain("In-Reply-To");
  });
});

describe("New project? cards", () => {
  async function withCard() {
    const s = await seededDb();
    const db = s.db;
    // An unfamiliar thread from a known client: Resolve raises a card.
    db.prepare(`INSERT INTO threads (gmail_thread_id, account, subject) VALUES ('tnew', ?, 'Patient newsletter')`).run(INBOX);
    db.prepare(
      `INSERT INTO messages (gmail_message_id, thread_id, account, sender_email, subject, received_at, body_source, raw_text, clean_text, status)
       VALUES ('mnew', 'tnew', ?, 'amara.okafor.md@gmail.com', 'Patient newsletter', '2026-10-17T10:00:00Z', 'text/plain', 'Could you design a monthly patient newsletter?', 'Could you design a monthly patient newsletter?', 'extracted')`,
    ).run(INBOX);
    db.prepare(
      `INSERT INTO actions (id, thread_id, message_id, type, payload_json, status, evidence_json, produced_by_model)
       VALUES ('np1', 'tnew', 'mnew', 'new_project', ?, 'proposed', ?, 'rule')`,
    ).run(JSON.stringify({ suggested_name: "Patient newsletter", client_id: "lumen-clinic", closest_project_id: "lumen-website", reason: "x" }), JSON.stringify([msgEv("mnew", "monthly patient newsletter")]));
    return db;
  }

  it("lists the client's projects, files the thread, or creates a project", async () => {
    const db = await withCard();
    const info = inspect(db, { type: "action", id: "np1" })!.approval!;
    expect(info.newProject).toMatchObject({ suggestedName: "Patient newsletter", clientName: "Lumen Clinic", closestProjectId: "lumen-website" });
    expect(info.newProject!.projects.map((p) => p.id).sort()).toEqual(["lumen-booking", "lumen-website"]);
    expect(() => approveAction(db, "np1")).toThrow(/Choose where to file/);

    const { projectId } = decideNewProject(db, "np1", { kind: "create", name: "Patient newsletter" });
    expect(projectId).toBe("lumen-patient-newsletter");
    expect(db.prepare(`SELECT project_id, assigned_by FROM threads WHERE gmail_thread_id = 'tnew'`).get()).toEqual({ project_id: projectId, assigned_by: "human" });
    expect(db.prepare(`SELECT status FROM actions WHERE id = 'np1'`).get()).toEqual({ status: "executed" });
  });

  it("dismissing (reject) takes the mail out of triage for good", async () => {
    const db = await withCard();
    rejectAction(db, "np1", "Not a project, just a question");
    expect(db.prepare(`SELECT status FROM messages WHERE gmail_message_id = 'mnew'`).get()).toEqual({ status: "dismissed" });
    expect(getBoard(db).triage?.columns.triage.some((c) => c.id === "mnew") ?? false).toBe(false);
  });
});
