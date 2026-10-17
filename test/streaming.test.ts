import { describe, expect, it } from "vitest";
import type { Llm, LlmResult, ToolCall } from "../src/lib/pipeline/llm";
import { heuristicMatcher } from "../src/lib/pipeline/resolve";
import { runPipeline } from "../src/lib/pipeline/run";
import { ANCHOR, fakeExtractor, seededDb } from "./seed-fixture";

/** One signal per email so every email gets a review call; tracks call order and parallelism. */
function trackingLlm(db: import("../src/lib/db").DB, delayMs = 5) {
  const log: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const llm: Llm = {
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push(req.hint ?? "");
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      const [stage, id] = (req.hint ?? "").split(":");
      let input: unknown;
      if (stage === "reason") {
        const t = (db.prepare(`SELECT clean_text FROM messages WHERE gmail_message_id = ?`).get(id) as { clean_text: string }).clean_text;
        const q = t.split("\n").find((l) => l.trim().length > 12)!.trim().slice(0, 40);
        input = { signals: [{ tmp_id: "s1", type: "ask", text: `Ask in ${id}`, evidence: [{ kind: "message", message_id: id, quote: q }] }] };
      } else input = { items: [{ tmp_id: "s1", verdict: "pass", score: 0.9, reason: "ok" }] };
      return { input: input as T, usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0 };
    },
  };
  return { llm, log, max: () => maxInFlight };
}

const pair = { id: "haiku-sonnet", reason: "claude-haiku", review: "claude-sonnet" };

describe("streaming pipeline", () => {
  it("each email goes all the way through before the slot takes the next one", async () => {
    const { db, dataDir } = await seededDb();
    const t = trackingLlm(db);
    await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm: t.llm, pair } }, { dataDir, now: ANCHOR, concurrency: 1 });
    // reason:A, review:A, reason:B, review:B, ... never all reasons first.
    for (let i = 0; i < t.log.length; i += 2) {
      expect(t.log[i].startsWith("reason:")).toBe(true);
      expect(t.log[i + 1]).toBe(t.log[i].replace("reason:", "review:"));
    }
    expect(t.log).toHaveLength(30);
    expect(db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`).all()).toEqual([{ status: "reviewed", n: 15 }]);
  });

  it("runs several emails at once, bounded by the concurrency setting, with the same results", async () => {
    const { db, dataDir } = await seededDb();
    const t = trackingLlm(db, 20);
    const r = await runPipeline(db, { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: { llm: t.llm, pair } }, { dataDir, now: ANCHOR, concurrency: 4 });
    expect(t.max()).toBeGreaterThan(1);
    expect(t.max()).toBeLessThanOrEqual(4);
    expect(r.resolve.assigned).toHaveLength(13);
    expect(r.resolve.inherited).toBe(2);
    expect(r.reasonReview).toMatchObject({ reasoned: 15, reviewed: 15, failed: [] });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM signals`).get()).toEqual({ n: 15 });
  });
});
