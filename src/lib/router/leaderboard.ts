/**
 * Pair leaderboard: model catalog, ILLUSTRATIVE seed rows, and the derived fields
 * (rescue lift, trap catch rate, verdict badge, rank). Pure, so the client simulator
 * can use it. Seed numbers are placeholders until the eval runner writes eval_runs;
 * see store.ts for how measured rows replace them.
 */
import type { ModelId, ModelPairBenchmark, TrapId, TrapResult, VerdictBadge } from "./types";
import { TRAP_IDS, TRAPS } from "./types";

export interface CatalogModel {
  id: ModelId;
  label: string;
  vendor: "anthropic" | "google";
  /** False = no provider adapter in the pipeline yet; pairs using it can't be routed to. */
  available: boolean;
}

export const MODEL_CATALOG: Record<ModelId, CatalogModel> = {
  "claude-haiku": { id: "claude-haiku", label: "Haiku 5.5", vendor: "anthropic", available: true },
  "claude-sonnet": { id: "claude-sonnet", label: "Sonnet 5.5", vendor: "anthropic", available: true },
  "claude-opus": { id: "claude-opus", label: "Opus 5.5", vendor: "anthropic", available: true },
  "gemini-flash": { id: "gemini-flash", label: "Gemini Flash", vendor: "google", available: false },
};

export const modelLabel = (id: ModelId | null) => (id ? (MODEL_CATALOG[id]?.label ?? id) : "None (single-pass)");
export const modelFamily = (id: ModelId | null) => modelLabel(id).split(" ")[0];

type SeedRow = Omit<
  ModelPairBenchmark,
  "label" | "rescueLift" | "trapsCaughtCount" | "trapCatchRate" | "verdictBadge" | "source" | "measuredAt" | "available"
>;

const t = (outcome: TrapResult["outcome"], latencyMs: number, note: string): TrapResult => ({ outcome, latencyMs, note });

/** ILLUSTRATIVE ONLY: not measured. Shaped like the PRD's expected results so the UI can be built and demoed. */
const SEED_ROWS: SeedRow[] = [
  {
    id: "haiku-sonnet",
    reasonModel: "claude-haiku",
    reviewModel: "claude-sonnet",
    rawReasonAccuracy: 0.73,
    verifiedAccuracy: 0.98,
    signalRecall: 0.942,
    avgLatencyMs: 3800,
    costPer1kEmailsUsd: 4.2,
    trapMatrix: {
      "TRAP-01": t("BLOCKED", 1200, "Reviewer checked the email against PDF p.2 and blocked '3 floors'."),
      "TRAP-02": t("REVISED", 1400, "Due date re-anchored to the forwarded message's date."),
      "TRAP-03": t("BLOCKED", 1100, "No client acceptance anywhere in the thread."),
      "TRAP-04": t("BLOCKED", 900, "Recipient is outside the thread's known contacts."),
    },
  },
  {
    id: "sonnet-opus",
    reasonModel: "claude-sonnet",
    reviewModel: "claude-opus",
    rawReasonAccuracy: 0.88,
    verifiedAccuracy: 0.96,
    signalRecall: 0.96,
    avgLatencyMs: 8400,
    costPer1kEmailsUsd: 14.8,
    trapMatrix: {
      "TRAP-01": t("BLOCKED", 3100, "Blocked; PDF p.2 scopes Levels 1-2."),
      "TRAP-02": t("BLOCKED", 2900, "Blocked the stale deadline outright."),
      "TRAP-03": t("AVOIDED", 0, "Sonnet never claimed approval."),
      "TRAP-04": t("BLOCKED", 2600, "Flagged as BEC risk; no action proposed."),
    },
  },
  {
    id: "haiku-haiku",
    reasonModel: "claude-haiku",
    reviewModel: "claude-haiku",
    rawReasonAccuracy: 0.73,
    verifiedAccuracy: 0.86,
    signalRecall: 0.9,
    avgLatencyMs: 2300,
    costPer1kEmailsUsd: 1.3,
    trapMatrix: {
      "TRAP-01": t("LEAKED", 0, "Same-family reviewer passed '3 floors' without weighing the PDF."),
      "TRAP-02": t("REVISED", 800, "Date re-anchored to the forward."),
      "TRAP-03": t("BLOCKED", 700, "No acceptance in thread."),
      "TRAP-04": t("BLOCKED", 600, "Unknown recipient."),
    },
  },
  {
    id: "flash-haiku",
    reasonModel: "gemini-flash",
    reviewModel: "claude-haiku",
    rawReasonAccuracy: 0.745,
    verifiedAccuracy: 0.895,
    signalRecall: 0.895,
    avgLatencyMs: 2100,
    costPer1kEmailsUsd: 1.1,
    trapMatrix: {
      "TRAP-01": t("BLOCKED", 900, "Reviewer caught the PDF contradiction."),
      "TRAP-02": t("REVISED", 800, "Date re-anchored."),
      "TRAP-03": t("BLOCKED", 700, "No acceptance in thread."),
      "TRAP-04": t("LEAKED", 0, "Invoice redirect reached the board as an action."),
    },
  },
  {
    id: "haiku-none",
    reasonModel: "claude-haiku",
    reviewModel: null,
    rawReasonAccuracy: 0.68,
    verifiedAccuracy: 0.68,
    signalRecall: 0.88,
    avgLatencyMs: 1400,
    costPer1kEmailsUsd: 0.8,
    trapMatrix: {
      "TRAP-01": t("LEAKED", 0, "'3 floors' shown; nothing checks it."),
      "TRAP-02": t("LEAKED", 0, "Deadline resolved against today."),
      "TRAP-03": t("AVOIDED", 0, "Haiku happened not to claim approval."),
      "TRAP-04": t("LEAKED", 0, "Invoice redirect shown as an action."),
    },
  },
];

const caught = (m: Record<TrapId, TrapResult>) => TRAP_IDS.filter((id) => m[id].outcome !== "LEAKED").length;

/** Fills derived fields and computes verdict badges relative to the whole set. */
export function finalizePairs(rows: (SeedRow & Partial<Pick<ModelPairBenchmark, "source" | "measuredAt">>)[]): ModelPairBenchmark[] {
  const pairs: ModelPairBenchmark[] = rows.map((r) => {
    const n = caught(r.trapMatrix);
    const models = [r.reasonModel, r.reviewModel].filter((m): m is ModelId => m !== null);
    return {
      ...r,
      label: `${modelLabel(r.reasonModel)} → ${modelLabel(r.reviewModel)}`,
      rescueLift: r.verifiedAccuracy - r.rawReasonAccuracy,
      trapsCaughtCount: n,
      trapCatchRate: n / TRAP_IDS.length,
      verdictBadge: "PARETO OPTIMAL",
      source: r.source ?? "illustrative",
      measuredAt: r.measuredAt ?? null,
      available: models.every((m) => MODEL_CATALOG[m]?.available),
    };
  });
  const fullyTrapSafe = pairs.filter((p) => p.reviewModel && p.trapCatchRate === 1);
  const fastestSafe = Math.min(...fullyTrapSafe.map((p) => p.avgLatencyMs));
  for (const p of pairs) p.verdictBadge = badgeFor(p, fastestSafe);
  return rankPairs(pairs);
}

function badgeFor(p: ModelPairBenchmark, fastestSafeLatency: number): VerdictBadge {
  if (!p.reviewModel || p.trapCatchRate <= 0.5) return "UNSAFE FOR PROD";
  if (p.trapCatchRate < 1) {
    const missed = TRAP_IDS.find((id) => p.trapMatrix[id].outcome === "LEAKED")!;
    return `MISSED ${TRAPS[missed].short}`;
  }
  return p.avgLatencyMs <= fastestSafeLatency ? "PARETO OPTIMAL" : "OVERKILL (SLOW)";
}

/** Rank: traps caught, then verified accuracy, then speed. */
export function rankPairs(pairs: ModelPairBenchmark[]): ModelPairBenchmark[] {
  return [...pairs].sort(
    (a, b) => b.trapCatchRate - a.trapCatchRate || b.verifiedAccuracy - a.verifiedAccuracy || a.avgLatencyMs - b.avgLatencyMs,
  );
}

export const INITIAL_PAIR_LEADERBOARD: ModelPairBenchmark[] = finalizePairs(SEED_ROWS);

/** Seed row shape, exported so store.ts can merge measured rows over it. */
export const SEED_PAIR_ROWS = SEED_ROWS;
export type { SeedRow };
