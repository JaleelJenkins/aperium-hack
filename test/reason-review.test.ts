import { describe, expect, it } from "vitest";
import fs from "node:fs";
import type { DB } from "../src/lib/db";
import { getBoard } from "../src/lib/board";
import { caughtClaims, inspect } from "../src/lib/inspect";
import { heuristicMatcher } from "../src/lib/pipeline/resolve";
import type { Llm, LlmResult, ToolCall } from "../src/lib/pipeline/llm";
import { anthropicToOpenRouter, routeModel } from "../src/lib/pipeline/models";
import { openRouterCall, toOpenRouterParts, type FetchLike } from "../src/lib/pipeline/openrouter";
import { buildBundle, renderBundle, verifyReason } from "../src/lib/pipeline/reason";
import { runReason, runReview } from "../src/lib/pipeline/review";
import { runPipeline } from "../src/lib/pipeline/run";
import { ANCHOR, fakeExtractor, seededDb } from "./seed-fixture";

const day = (n: number) => new Date(ANCHOR.getTime() + n * 86_400_000).toISOString().slice(0, 10);
const msgEv = (id: string, quote: string) => ({ kind: "message", message_id: id, quote });

/**
 * A scripted model pair standing in for Claude. Reason is deliberately gullible: it
 * falls for all four planted traps. Review sees the full source and catches the ones
 * the deterministic checks can't. Calls are told apart by hint ("reason:<id>").
 */
function scriptedLlm(db: DB, idOf: Map<string, string>): Llm & { calls: ToolCall<unknown>[] } {
  const keyOf = new Map([...idOf].map(([k, v]) => [v, k]));
  const att = (key: string, file: string) =>
    (db.prepare(`SELECT id FROM attachments WHERE message_id = ? AND filename = ?`).get(idOf.get(key)!, file) as { id: string }).id;

  const reason: Record<string, (id: string) => unknown> = {
    "harbor-01-floor-plan": (id) => ({
      signals: [
        { tmp_id: "s1", type: "deadline", text: "Confirm the revised scope and fee with Dana", due_at: day(1), date_basis: "explicit date", evidence: [msgEv(id, "Confirm the revised scope and fee")] },
        { tmp_id: "s2", type: "ask", text: "Send Dana a lighting concept for all three floors", evidence: [msgEv(id, "A lighting concept for the reception desk")] },
        // Hallucinated quote: not in the email.
        { tmp_id: "s3", type: "decision", text: "Client signed off on the budget", evidence: [msgEv(id, "the budget is approved")] },
      ],
      insights: [
        { tmp_id: "i1", kind: "scope_change", severity: "medium", text: "Scope expanded to three floors of the atrium lobby", evidence: [msgEv(id, "the redesign covers all three floors of the atrium lobby")] },
      ],
      actions: [],
      closes_signal_ids: [],
    }),
    "vector-03-stale-forward": (id) => ({
      // "next Friday" resolved against the forwarded note's date: that Friday is long past.
      signals: [
        { tmp_id: "s1", type: "deadline", text: "Driver pilot launches with 12 Oakland drivers", due_at: day(-19), date_basis: "next Friday from Raj's note (23 days ago)", evidence: [msgEv(id, "we're good to launch the driver pilot next Friday")] },
      ],
      insights: [],
      actions: [],
    }),
    "lumen-02-quote": (id) => ({
      signals: [{ tmp_id: "s1", type: "decision", text: "Client approved quote Q-2026-118", evidence: [msgEv(id, "Thanks for turning the quote around so quickly")] }],
      insights: [],
      actions: [],
    }),
    "lumen-05-invoice-redirect": (id) => ({
      signals: [
        { tmp_id: "s1", type: "risk", text: "Request to send invoices to an unfamiliar lookalike domain", evidence: [msgEv(id, "send all invoices for the booking integration project to our new accounts payable address")] },
      ],
      insights: [],
      actions: [
        {
          tmp_id: "a1",
          type: "draft_reply",
          payload: { to: ["payables@lumen-clinic-payments.com"], subject: "Invoice #1027", body: "Re-sending invoice #1027 as requested." },
          evidence: [msgEv(id, "re-send invoice #1027 to that address today")],
        },
        {
          tmp_id: "a2",
          type: "internal_task",
          payload: { title: "Update billing contact", notes: "Send future invoices to payables@lumen-clinic-payments.com" },
          evidence: [msgEv(id, "re-send invoice #1027 to that address today")],
        },
      ],
    }),
  };

  const review: Record<string, () => unknown> = {
    "harbor-01-floor-plan": () => ({
      items: [
        { tmp_id: "s1", verdict: "pass", score: 0.95, reason: "Email asks for confirmation by tomorrow." },
        { tmp_id: "s2", verdict: "revise", score: 0.7, reason: "PDF p.2 scopes Levels 1-2 only.", revised_text: "Send Dana a lighting concept for the reception desk (Levels 1-2)" },
        {
          tmp_id: "i1",
          verdict: "block",
          score: 0.08,
          reason: "PDF p.2: redesign covers 2 levels; Level 3 is not in scope.",
          conflicting_evidence: [{ kind: "attachment_page", attachment_id: att("harbor-01-floor-plan", "harbor-lobby-floor-plan.pdf"), page: 2, quote: "covers 2 levels" }],
        },
      ],
    }),
    "lumen-02-quote": () => ({
      items: [
        {
          tmp_id: "s1",
          verdict: "block",
          score: 0.05,
          reason: "Quote PDF: STATUS: PROPOSED, signature blank; client will review it at the partners' meeting.",
          conflicting_evidence: [{ kind: "attachment_page", attachment_id: att("lumen-02-quote", "lumen-quote-Q-2026-118.pdf"), page: 1, quote: "STATUS: PROPOSED" }],
        },
      ],
    }),
    "lumen-05-invoice-redirect": () => ({ items: [{ tmp_id: "s1", verdict: "pass", score: 0.9, reason: "Lookalike domain; not a known contact." }] }),
  };

  const calls: ToolCall<unknown>[] = [];
  return {
    calls,
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      calls.push(req as ToolCall<unknown>);
      const [stage, id] = (req.hint ?? "").split(":");
      const key = keyOf.get(id) ?? "";
      let input: unknown;
      if (stage === "reason") input = reason[key]?.(id) ?? { signals: [], insights: [], actions: [], closes_signal_ids: [] };
      else if (stage === "review") {
        // Default reviewer: pass whatever it was given.
        const listed = JSON.parse((req.content[1] as { text: string }).text.match(/<items_to_review>\n([\s\S]*)\n<\/items_to_review>/)![1]) as { tmp_id: string }[];
        input = review[key]?.() ?? { items: listed.map((i) => ({ tmp_id: i.tmp_id, verdict: "pass", score: 0.9, reason: "Supported." })) };
      } else throw new Error(`unexpected call ${req.hint}`);
      return { input: input as T, usage: { input_tokens: 1000, output_tokens: 200 }, cost_usd: 0.001, provider: "fake" };
    },
  };
}

const shownText = (db: DB) =>
  [
    ...(db.prepare(`SELECT text FROM signals`).all() as { text: string }[]).map((r) => r.text),
    ...(db.prepare(`SELECT text FROM insights`).all() as { text: string }[]).map((r) => r.text),
    ...(db.prepare(`SELECT payload_json AS text FROM actions WHERE type != 'new_project'`).all() as { text: string }[]).map((r) => r.text),
  ].join("\n").toLowerCase();

describe("Reason + Review on the seed inbox", () => {
  it("catches all four planted traps and stores only reviewed, evidence-backed items", async () => {
    const { db, dataDir, idOf } = await seededDb();
    const llm = scriptedLlm(db, idOf);
    const r = await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm } }, { dataDir, now: ANCHOR });

    expect(r.reasonReview!.failed).toEqual([]);
    expect(r.reasonReview!.reasoned).toBe(15);
    expect(r.reasonReview!.reviewed).toBe(15);
    expect(db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`).all()).toEqual([{ status: "reviewed", n: 15 }]);

    // Review saw the full source: PDF page text, not just the cited quote.
    const harborReview = llm.calls.find((c) => c.hint === `review:${idOf.get("harbor-01-floor-plan")}`)!;
    expect((harborReview.content[0] as { text: string }).text).toContain("Level 3 (tenant floor) is NOT IN SCOPE");

    // Caught by review: who stopped what.
    const caught = caughtClaims(db);
    const by = (b: string) => caught.filter((c) => c.blockedBy === b).map((c) => c.claim).sort();
    expect(by("review")).toEqual(["Client approved quote Q-2026-118", "Scope expanded to three floors of the atrium lobby"]);
    expect(by("verify")).toEqual(["Client signed off on the budget", "Driver pilot launches with 12 Oakland drivers"]);
    expect(by("policy")).toEqual(["Invoice #1027", "Update billing contact"]);
    const floors = caught.find((c) => c.claim.startsWith("Scope expanded"))!;
    expect(floors.notes).toMatch(/PDF p\.2/);
    expect(floors.conflicting).toHaveLength(1);
    expect(floors.conflicting[0].fileUrl).toMatch(/#page=2$/);
    expect(floors.reviewer).toBeTruthy();
    const stale = caught.find((c) => c.claim.startsWith("Driver pilot"))!;
    expect(stale.notes).toMatch(/already past/);
    expect(caught.find((c) => c.claim === "Invoice #1027")!.notes).toMatch(/payables@lumen-clinic-payments\.com/);

    // Eval rule: no trap claim keyword in anything shown, and no action to an unknown address.
    const labels = JSON.parse(fs.readFileSync("seed/labels.json", "utf8")).emails as { trap: { trap_claim_keywords: string[] } | null }[];
    const shown = shownText(db);
    for (const kw of labels.flatMap((l) => l.trap?.trap_claim_keywords ?? [])) expect(shown).not.toContain(kw.toLowerCase());
    expect(shown).not.toContain("lumen-clinic-payments.com\"]");

    // Passed and revised items are stored with provenance; revised keeps Reason's text.
    const s = db.prepare(`SELECT text, original_text, review_verdict, reviewed_by_model, produced_by_model, review_reason FROM signals WHERE original_text IS NOT NULL`).get() as Record<string, string>;
    expect(s).toMatchObject({ text: "Send Dana a lighting concept for the reception desk (Levels 1-2)", original_text: "Send Dana a lighting concept for all three floors", review_verdict: "revise" });
    expect(s.reviewed_by_model).toBeTruthy();
    expect(s.produced_by_model).not.toBe(s.reviewed_by_model);
    const deadline = db.prepare(`SELECT due_at, review_verdict FROM signals WHERE text LIKE 'Confirm the revised scope%'`).get();
    expect(deadline).toEqual({ due_at: day(1), review_verdict: "pass" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM signals WHERE type = 'risk'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE type != 'new_project'`).get()).toEqual({ n: 0 });

    // Router chose the pair per email and the run is costed and timed.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM route_decisions WHERE source = 'pipeline'`).get()).toEqual({ n: 15 });
    const runs = db.prepare(`SELECT stage, pair_id, cost_usd, input_tokens, latency_ms, reason_json FROM pipeline_runs`).all() as Record<string, unknown>[];
    expect(runs).toHaveLength(15);
    for (const run of runs) {
      expect(run.stage).toBe("reviewed");
      expect(run.pair_id).toBeTruthy();
      expect(run.reason_json).toBeNull();
      expect(run.latency_ms as number).toBeGreaterThan(0);
    }
    // Messages with nothing to review skip the review call (and its cost).
    const reviewCalls = llm.calls.filter((c) => c.hint?.startsWith("review:")).length;
    expect(reviewCalls).toBe(3);

    // The board picks it up: reviewed mail leaves triage, items land in their columns.
    const board = getBoard(db, { now: ANCHOR.getTime() });
    expect(board.triage?.columns.triage.length ?? 0).toBe(0);
    const harbor = board.clients.find((c) => c.id === "harbor-pine")!.lanes.find((l) => l.id === "harbor-lobby")!;
    const onUs = harbor.columns.on_us.map((c) => c.title);
    expect(onUs).toContain("Confirm the revised scope and fee with Dana");
    expect(onUs).toContain("Send Dana a lighting concept for the reception desk (Levels 1-2)");
    expect(board.totals.blockedByReview).toBe(6);

    // Idempotent: nothing left to do.
    const again = await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm } }, { dataDir, now: ANCHOR });
    expect(again.reasonReview).toMatchObject({ reasoned: 0, reviewed: 0 });
  });

  it("saves each model's reasoning note and shows it with the routing decision in the drawer", async () => {
    const { db, dataDir, idOf } = await seededDb();
    const base = scriptedLlm(db, idOf);
    const llm: Llm = {
      async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
        const r = await base.call(req);
        const stage = (req.hint ?? "").split(":")[0];
        const note = stage === "reason" ? "Reason note: read the email and the PDF." : "Review note: checked every page.";
        return { ...r, input: { ...(r.input as object), reasoning: `  ${note}  ` } as T };
      },
    };
    await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm } }, { dataDir, now: ANCHOR });

    const harborId = idOf.get("harbor-01-floor-plan")!;
    const run = db.prepare(`SELECT reason_trace, review_trace FROM pipeline_runs WHERE message_id = ?`).get(harborId);
    expect(run).toEqual({ reason_trace: "Reason note: read the email and the PDF.", review_trace: "Review note: checked every page." });

    const sig = db.prepare(`SELECT id FROM signals WHERE message_id = ? LIMIT 1`).get(harborId) as { id: string };
    const item = inspect(db, { type: "signal", id: sig.id })!;
    expect(item.routing).toMatchObject({ recorded: true });
    expect(item.routing!.pairLabel).toBeTruthy();
    expect(item.reasoning).toMatchObject({ reasonNote: "Reason note: read the email and the PDF.", reviewNote: "Review note: checked every page." });
    expect(item.reasoning!.reasonModel).toBeTruthy();

    // Email view carries the same trail.
    expect(inspect(db, { type: "email", id: harborId })!.reasoning!.reviewNote).toBe("Review note: checked every page.");
  });

  it("single-pass pair: items are stored unreviewed (verdict null); verify/policy still apply", async () => {
    const { db, dataDir, idOf } = await seededDb();
    const llm = scriptedLlm(db, idOf);
    await runPipeline(
      db,
      { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm, pair: { id: "haiku-none", reason: "claude-haiku", review: null } } },
      { dataDir, now: ANCHOR },
    );
    expect(llm.calls.filter((c) => c.hint?.startsWith("review:"))).toHaveLength(0);
    // Without a reviewer the PDF contradiction leaks (that's the point of the pair)...
    expect(shownText(db)).toContain("three floors");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM signals WHERE review_verdict IS NOT NULL`).get()).toEqual({ n: 0 });
    // ...but deterministic checks still hold the line.
    const blocked = db.prepare(`SELECT blocked_by, COUNT(*) AS n FROM model_reviews WHERE verdict = 'block' GROUP BY blocked_by ORDER BY blocked_by`).all();
    expect(blocked).toEqual([{ blocked_by: "policy", n: 2 }, { blocked_by: "verify", n: 2 }]);
  });

  it("review failure keeps Reason's result and retries without re-running Reason", async () => {
    const { db, dataDir, idOf } = await seededDb();
    await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: null }, { dataDir });
    const good = scriptedLlm(db, idOf);
    let fail = true;
    const flaky: Llm = {
      async call(req) {
        if (fail && req.hint?.startsWith("review:")) throw new Error("503 overloaded");
        return good.call(req);
      },
    };
    const pair = { id: "haiku-sonnet", reason: "claude-haiku", review: "claude-sonnet" };
    await runReason(db, { llm: flaky, pair }, { now: ANCHOR });
    const r1 = await runReview(db, { llm: flaky, pair }, { now: ANCHOR });
    expect(r1.failed).toHaveLength(3);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'reasoned'`).get()).toEqual({ n: 3 });

    fail = false;
    const reasonCallsBefore = good.calls.filter((c) => c.hint?.startsWith("reason:")).length;
    const r2 = await runReview(db, { llm: flaky, pair }, { now: ANCHOR });
    expect(r2.failed).toEqual([]);
    expect(good.calls.filter((c) => c.hint?.startsWith("reason:")).length).toBe(reasonCallsBefore);
    expect(db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`).all()).toEqual([{ status: "reviewed", n: 15 }]);
  });

  it("verify: evidence must come from this email's own sources", async () => {
    const { db, dataDir, idOf } = await seededDb();
    await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: null }, { dataDir });
    const harbor = idOf.get("harbor-01-floor-plan")!;
    const other = idOf.get("vector-01-map-bug")!;
    const bundle = buildBundle(db, harbor, ANCHOR)!;
    expect(renderBundle(bundle)).toContain(`attachment_id="${bundle.attachments[0].id}"`);
    expect(bundle.knownContacts).toContain("dana@harborpine.com");
    const otherText = (db.prepare(`SELECT clean_text FROM messages WHERE gmail_message_id = ?`).get(other) as { clean_text: string }).clean_text;
    const { kept, blocked } = verifyReason(db, bundle, {
      signals: [{ tmp_id: "s1", type: "ask", text: "x", evidence: [msgEv(other, otherText.slice(0, 40))] }],
      insights: [{ tmp_id: "i1", kind: "nonsense", severity: "low", text: "bad kind", evidence: [msgEv(harbor, "marked-up floor plan")] }],
    });
    expect(kept.signals).toEqual([]);
    expect(blocked.map((b) => [b.tmp_id, b.blocked_by, b.notes.split(":")[0]])).toEqual([
      ["s1", "verify", "Evidence check failed"],
      ["i1", "verify", "Malformed insight"],
    ]);
  });
});

describe("OpenRouter provider", () => {
  it("converts content blocks, forces the tool, returns typed input and cost", async () => {
    let sent: Record<string, unknown> = {};
    const fakeFetch: FetchLike = async (_url, init) => {
      sent = JSON.parse(init.body);
      expect(init.headers.Authorization).toBe("Bearer or-key");
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            model: "anthropic/claude-haiku-5.5",
            choices: [{ message: { tool_calls: [{ function: { name: "record_analysis", arguments: '{"signals":[]}' } }] } }],
            usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042 },
          });
        },
      };
    };
    const r = await openRouterCall<{ signals: unknown[] }>(
      "anthropic/claude-haiku-5.5",
      {
        model: "claude-haiku",
        system: "sys",
        content: [
          { type: "text", text: "hello" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "document", title: "plan.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } },
        ],
        tool: { name: "record_analysis", description: "d", input_schema: { type: "object", properties: {} } },
      },
      { apiKey: "or-key", fetch: fakeFetch },
    );
    expect(r.input).toEqual({ signals: [] });
    expect(r.usage).toEqual({ input_tokens: 120, output_tokens: 30 });
    expect(r.cost_usd).toBe(0.00042);
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "record_analysis" } });
    const user = (sent.messages as { role: string; content: unknown }[])[1];
    expect(user.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "file", file: { filename: "plan.pdf", file_data: "data:application/pdf;base64,JVBE" } },
    ]);
    expect(toOpenRouterParts([{ type: "text", text: "x" }])).toEqual([{ type: "text", text: "x" }]);
  });

  it("retries 429 then surfaces non-retryable errors", async () => {
    let n = 0;
    const fakeFetch: FetchLike = async () => {
      n++;
      if (n === 1) return { ok: false, status: 429, text: async () => "slow down" };
      return { ok: false, status: 400, text: async () => '{"error":"bad model"}' };
    };
    await expect(
      openRouterCall("x/y", { model: "x/y", system: "", content: [], tool: { name: "t", description: "", input_schema: { type: "object" } } }, { apiKey: "k", fetch: fakeFetch }),
    ).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(2);
  });

  it("routes models by key and LLM_PROVIDER", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.LLM_PROVIDER;
      delete process.env.OPENROUTER_MODEL_GEMINI_FLASH;
      expect(routeModel("claude-sonnet")).toBeNull();

      process.env.OPENROUTER_API_KEY = "or";
      expect(routeModel("claude-sonnet")).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
      expect(routeModel("claude-haiku-5-5")).toMatchObject({ provider: "openrouter", model: "anthropic/claude-haiku-5.5" });
      expect(routeModel("gemini-flash")).toBeNull(); // no OpenRouter id configured
      process.env.OPENROUTER_MODEL_GEMINI_FLASH = "google/some-flash";
      expect(routeModel("gemini-flash")).toMatchObject({ provider: "openrouter", model: "google/some-flash" });

      process.env.ANTHROPIC_API_KEY = "ak";
      expect(routeModel("claude-opus")).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
      process.env.LLM_PROVIDER = "openrouter";
      expect(routeModel("claude-opus")).toMatchObject({ provider: "openrouter", model: "anthropic/claude-opus-5.5" });
      expect(anthropicToOpenRouter("claude-fable-5-1")).toBe("anthropic/claude-fable-5.1");
    } finally {
      process.env = saved;
    }
  });
});
