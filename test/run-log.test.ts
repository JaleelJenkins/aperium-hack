import { describe, expect, it } from "vitest";
import { acquirePipelineLock, processWaiting } from "../src/lib/cycle";
import type { Llm, LlmResult, ToolCall } from "../src/lib/pipeline/llm";
import { heuristicMatcher } from "../src/lib/pipeline/resolve";
import { latestBatch } from "../src/lib/run-log";
import { fakeExtractor, seededDb } from "./seed-fixture";

function llmFor(db: import("../src/lib/db").DB): Llm {
  return {
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      const [stage, id] = (req.hint ?? "").split(":");
      let input: unknown = { items: [{ tmp_id: "s1", verdict: "pass", score: 0.9, reason: "ok" }] };
      if (stage === "reason") {
        const t = (db.prepare(`SELECT clean_text FROM messages WHERE gmail_message_id = ?`).get(id) as { clean_text: string }).clean_text;
        const q = t.split("\n").find((l) => l.trim().length > 12)!.trim().slice(0, 40);
        input = { signals: [{ tmp_id: "s1", type: "ask", text: `Ask in ${id}`, evidence: [{ kind: "message", message_id: id, quote: q }] }] };
      }
      return { input: input as T, usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0.001 };
    },
  };
}

describe("live run log (Sync now panel)", () => {
  it("records one line per email as it finishes, then totals and run time", async () => {
    const { db } = await seededDb();
    const r = await processWaiting(db, "web", {
      extractor: fakeExtractor,
      matcher: heuristicMatcher(),
      reasonReview: { llm: llmFor(db), pair: { id: "haiku-sonnet", reason: "claude-haiku", review: "claude-sonnet" } },
    });
    expect(r.ran).toBe(true);
    const b = latestBatch(db)!;
    expect(b).toMatchObject({ source: "web", total: 15, done: 15, error: null });
    expect(b.finishedAt).toBeTruthy();
    expect(b.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(b.lines).toHaveLength(15);
    expect(b.lines.every((l) => l.kind === "email" && / → .+ · 1 signal/.test(l.line))).toBe(true);
    expect(b.lines.some((l) => l.line.startsWith("Lobby redesign: marked-up floor plan → Lobby redesign"))).toBe(true);
    expect(b.lines[0].detail).toMatchObject({ signals: 1, costUsd: 0.002 });
    expect(b.summary).toMatchObject({ filed: 15, reviewed: 15, signals: 15, failed: 0 });

    // Nothing waiting: no new empty run is recorded.
    await processWaiting(db, "web", { extractor: fakeExtractor, matcher: heuristicMatcher(), reasonReview: null });
    expect(latestBatch(db)!.id).toBe(b.id);
  });

  it("a run that can't get the lease records nothing", async () => {
    const { db } = await seededDb();
    acquirePipelineLock(db, "worker");
    const r = await processWaiting(db, "web", { extractor: null, matcher: heuristicMatcher(), reasonReview: null });
    expect(r.ran).toBe(false);
    expect(latestBatch(db)).toBeNull();
  });
});
