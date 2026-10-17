import { describe, expect, it } from "vitest";
import type { DB } from "../src/lib/db";
import { baseDb, claimsKeyword, evalPair, overlap, saveEvalRun, snapshotSeed } from "../src/lib/eval";
import { runExtract } from "../src/lib/pipeline/extract";
import type { Llm, LlmResult, ToolCall } from "../src/lib/pipeline/llm";
import { heuristicMatcher, runResolve } from "../src/lib/pipeline/resolve";
import { getLeaderboard } from "../src/lib/router/store";
import { SEED_EMAILS } from "../seed/emails";
import { ANCHOR, fakeExtractor, seededDb } from "./seed-fixture";

const day = (n: number) => new Date(ANCHOR.getTime() + n * 86_400_000).toISOString().slice(0, 10);
const ev = (id: string, quote: string) => [{ kind: "message", message_id: id, quote }];

/**
 * A scripted pair. Reason files every email correctly and extracts the labeled asks for two
 * emails; it falls for TRAP-01 (three floors) and TRAP-03 (quote approved), and stays clear
 * of the other two. Review blocks the floors claim; the quote claim gets through when
 * `reviewCatchesQuote` is false, so one pair leaks.
 */
function scripted(db: DB, idOf: Map<string, string>, reviewCatchesQuote: boolean): Llm & { reasonCalls: number; reviewCalls: number } {
  const keyOf = new Map([...idOf].map(([k, v]) => [v, k]));
  const project = (key: string) => SEED_EMAILS.find((e) => e.key === key)!.labels.project_id;
  const reason: Record<string, (id: string) => object> = {
    "harbor-01-floor-plan": (id) => ({
      signals: [
        { tmp_id: "s1", type: "ask", text: "Confirm the revised scope and fee", due_at: day(1), evidence: ev(id, "Confirm the revised scope and fee") },
        { tmp_id: "s2", type: "ask", text: "Send a lighting concept for the reception desk", evidence: ev(id, "A lighting concept for the reception desk") },
      ],
      insights: [
        { tmp_id: "i1", kind: "scope_change", severity: "medium", text: "Scope grew to three floors", evidence: ev(id, "the redesign covers all three floors of the atrium lobby") },
      ],
    }),
    "lumen-02-quote": (id) => ({
      signals: [{ tmp_id: "s1", type: "decision", text: "Client approved quote Q-2026-118", evidence: ev(id, "Thanks for turning the quote around so quickly") }],
    }),
  };
  let reasonCalls = 0;
  let reviewCalls = 0;
  return {
    get reasonCalls() {
      return reasonCalls;
    },
    get reviewCalls() {
      return reviewCalls;
    },
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      const [stage, id] = (req.hint ?? "").split(":");
      const key = keyOf.get(id) ?? "";
      let input: unknown;
      if (stage === "reason") {
        reasonCalls++;
        input = {
          client_guess: { client_id: null, name: "x", confidence: 0.9 },
          project_match: { project_id: project(key), confidence: 0.95 },
          signals: [],
          insights: [],
          actions: [],
          closes_signal_ids: [],
          ...(reason[key]?.(id) ?? {}),
        };
      } else if (stage === "review") {
        reviewCalls++;
        const listed = JSON.parse((req.content[1] as { text: string }).text.match(/<items_to_review>\n([\s\S]*)\n<\/items_to_review>/)![1]) as { tmp_id: string }[];
        input = {
          items: listed.map((i) => {
            if (key === "harbor-01-floor-plan" && i.tmp_id === "i1") return { tmp_id: "i1", verdict: "block", score: 0.1, reason: "PDF p.2: Levels 1-2 only." };
            if (key === "lumen-02-quote" && reviewCatchesQuote) return { tmp_id: i.tmp_id, verdict: "block", score: 0.1, reason: "Quote PDF says STATUS: PROPOSED." };
            return { tmp_id: i.tmp_id, verdict: "pass", score: 0.9, reason: "Supported." };
          }),
        };
      } else throw new Error(`unexpected ${req.hint}`);
      return { input: input as T, usage: { input_tokens: 1000, output_tokens: 200 }, cost_usd: 0.002, provider: "fake" };
    },
  };
}

async function prepared() {
  const s = await seededDb();
  const snap = snapshotSeed(s.db);
  const base = baseDb(snap);
  await runExtract(base, fakeExtractor, { dataDir: s.dataDir, limit: 100 });
  await runResolve(base, heuristicMatcher(), { limit: 100 });
  return { ...s, snap, base };
}

describe("eval scoring helpers", () => {
  it("matches labels to model wording by content words", () => {
    expect(overlap("Confirm the revised scope and fee", "Dana wants us to confirm the revised scope + fee")).toBe(1);
    expect(overlap("Send walnut and white oak samples", "Ship the walnut + white oak sample boards")).toBeGreaterThanOrEqual(0.5);
    expect(overlap("Send walnut and white oak samples", "Update the signage layout")).toBe(0);
  });

  it("trap keywords count only when not negated", () => {
    const k = ["approved", "accepted"];
    expect(claimsKeyword("Client approved quote Q-2026-118", k)).toBe(true);
    expect(claimsKeyword("Quote is not yet approved; partners review it Thursday", k)).toBe(false);
    expect(claimsKeyword("Quote unapproved, pending signature", k)).toBe(false);
    expect(claimsKeyword("No acceptance yet, though the scope was accepted last week", k)).toBe(true);
  });
});

describe("eval runner", () => {
  it("copies the seed inbox unfiled, so every pair starts from the same place", async () => {
    const s = await seededDb();
    const snap = snapshotSeed(s.db);
    expect(snap.ids.size).toBe(15);
    expect(Math.abs(snap.anchor.getTime() - ANCHOR.getTime())).toBeLessThan(60_000);
    const base = baseDb(snap);
    const filed = base.prepare(`SELECT COUNT(*) AS n FROM threads WHERE project_id IS NOT NULL`).get() as { n: number };
    expect(filed.n).toBe(0);
    const waiting = base.prepare(`SELECT status, COUNT(*) AS n FROM messages GROUP BY status ORDER BY status`).all();
    expect(waiting).toEqual([
      { status: "extracted", n: 5 }, // no attachments to read
      { status: "ingested", n: 10 }, // a PDF or image still to extract
    ]);
  });

  it("scores a pair: accuracy before and after review, recall, traps, cost; writes eval_runs", async () => {
    const p = await prepared();
    const llm = scripted(p.base, p.idOf, true);
    const r = await evalPair(p.base, p.snap, { id: "haiku-sonnet", reason: "claude-haiku", review: "claude-sonnet" }, llm);
    const m = r.metrics;

    expect(llm.reasonCalls).toBe(15);
    expect(m.failed).toBe(0);
    // Reason claimed two traps; review stopped both. Raw counts them, verified doesn't.
    expect(m.trap_matrix["TRAP-01"].outcome).toBe("BLOCKED");
    expect(m.trap_matrix["TRAP-01"].note).toContain("Levels 1-2");
    expect(m.trap_matrix["TRAP-02"].outcome).toBe("AVOIDED");
    expect(m.trap_matrix["TRAP-03"].outcome).toBe("BLOCKED");
    expect(m.trap_matrix["TRAP-04"].outcome).toBe("AVOIDED");
    expect(m.traps_caught).toBe(4);
    const filedRight = r.emails.filter((e) => e.filed_project === e.expected_project).length;
    expect(m.raw_reason_accuracy).toBeCloseTo(13 / 15, 3);
    expect(m.verified_accuracy).toBeCloseTo(filedRight / 15, 3);
    // Three labeled items found (two asks + the deadline on harbor-01) out of all labeled.
    const labeled = r.emails.reduce((n, e) => n + e.labeled, 0);
    expect(m.signal_recall).toBeCloseTo(3 / labeled, 3);
    expect(r.emails.find((e) => e.key === "harbor-01-floor-plan")!.missed).toEqual([]);
    expect(m.cost_per_email_usd).toBeGreaterThan(0);

    // The live DB only gets the eval_runs row; the scoreboard swaps in the measured numbers.
    saveEvalRun(p.db, r, new Date());
    const row = getLeaderboard(p.db).find((x) => x.id === "haiku-sonnet")!;
    expect(row.source).toBe("measured");
    expect(row.trapsCaughtCount).toBe(4);
    expect(row.verifiedAccuracy).toBeCloseTo(m.verified_accuracy, 3);
    expect(p.db.prepare(`SELECT COUNT(*) AS n FROM signals`).get()).toEqual({ n: 0 });
  });

  it("a claim review lets through is LEAKED; a single-pass pair is recorded as such", async () => {
    const p = await prepared();
    const r = await evalPair(p.base, p.snap, { id: "haiku-haiku", reason: "claude-haiku", review: "claude-haiku" }, scripted(p.base, p.idOf, false));
    expect(r.metrics.trap_matrix["TRAP-03"].outcome).toBe("LEAKED");
    expect(r.metrics.trap_matrix["TRAP-03"].note).toContain("approved");
    expect(r.metrics.traps_caught).toBe(3);

    const single = scripted(p.base, p.idOf, true);
    const s = await evalPair(p.base, p.snap, { id: "haiku-none", reason: "claude-haiku", review: null }, single);
    expect(single.reviewCalls).toBe(0);
    expect(s.metrics.trap_matrix["TRAP-01"].outcome).toBe("LEAKED");
    saveEvalRun(p.db, s, new Date());
    const row = getLeaderboard(p.db).find((x) => x.id === "haiku-none")!;
    expect(row.source).toBe("measured");
    expect(row.reviewModel).toBeNull();
  });
});
