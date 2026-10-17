import { describe, expect, it } from "vitest";
import { acquirePipelineLock, ensureSeeded, pipelineBusy, processWaiting, releasePipelineLock, runCycle } from "../src/lib/cycle";
import { openDb } from "../src/lib/db";
import type { Llm } from "../src/lib/pipeline/llm";
import { heuristicMatcher } from "../src/lib/pipeline/resolve";
import { fakeExtractor, seededDb } from "./seed-fixture";

const emptyLlm: Llm = {
  async call(req) {
    const stage = (req.hint ?? "").split(":")[0];
    const input = stage === "review" ? { items: [] } : { signals: [], insights: [], actions: [], closes_signal_ids: [] };
    return { input: input as never, usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0 };
  },
};

describe("full cycle (Sync now / worker)", () => {
  it("one call takes every waiting email from ingested to reviewed", async () => {
    const { db } = await seededDb();
    expect(db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`).all()).toEqual([{ status: "ingested", n: 15 }]);
    const r = await processWaiting(db, "test", {
      extractor: { ...fakeExtractor },
      matcher: heuristicMatcher(),
      reasonReview: { llm: emptyLlm, pair: { id: "haiku-sonnet", reason: "claude-haiku", review: "claude-sonnet" } },
    });
    expect(r.ran).toBe(true);
    expect(db.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status`).all()).toEqual([{ status: "reviewed", n: 15 }]);
    expect(pipelineBusy(db)).toBe(false);
  });

  it("the lease stops a second process from running the pipeline at the same time", () => {
    const db = openDb(":memory:");
    const t = acquirePipelineLock(db, "worker")!;
    expect(t).toBeTruthy();
    expect(acquirePipelineLock(db, "web")).toBeNull();
    expect(pipelineBusy(db)).toBe(true);
    // An expired lease (crashed process) can be taken over.
    expect(acquirePipelineLock(db, "web", Date.now() + 16 * 60_000)).toBeTruthy();
    releasePipelineLock(db, t); // stale token: doesn't release the new holder
    expect(pipelineBusy(db, Date.now() + 16 * 60_000)).toBe(true);
  });

  it("busy pipeline: processWaiting returns without touching mail", async () => {
    const db = openDb(":memory:");
    acquirePipelineLock(db, "worker");
    const r = await processWaiting(db, "web", { extractor: null, matcher: heuristicMatcher(), reasonReview: null });
    expect(r).toEqual({ ran: false, reason: "busy" });
  });

  it("an empty database is seeded first, so mail can be filed to projects", async () => {
    const db = openDb(":memory:");
    expect(ensureSeeded(db)).not.toBeNull();
    expect(ensureSeeded(db)).toBeNull();
    const db2 = openDb(":memory:");
    const r = await runCycle(db2, "test", { extractor: null, matcher: heuristicMatcher(), reasonReview: null });
    expect(r.seeded).not.toBeNull();
    expect((db2.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n).toBe(5);
    expect(r.outcome.ran).toBe(true);
  });
});
