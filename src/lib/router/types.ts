/**
 * Reason x Review asymmetric pair routing: types shared by the router, the scoreboard,
 * the dry-run, and the board's route trace. Pure (no DB), so client components can import it.
 */

/** Model profile ids (seed/seed.json model_profiles), plus catalog-only models with no adapter yet. */
export type ModelId = "claude-haiku" | "claude-sonnet" | "claude-opus" | "gemini-flash";

export type RoutingPolicyMode =
  | "pareto_auto" // highest trust-to-cost/latency utility
  | "complexity_escalation" // escalate to a 100%-trap-safe reviewer on risky payloads, fast route otherwise
  | "strict_trust" // SLA: always the fastest 100%-trap-safe pair
  | "low_latency" // SLA: fastest reviewed pair under 2.5s; escalates only on quoted-date ambiguity
  | "pinned"; // a manually locked pair

export const POLICY_MODES: RoutingPolicyMode[] = ["pareto_auto", "complexity_escalation", "strict_trust", "low_latency", "pinned"];

export const POLICY_LABEL: Record<RoutingPolicyMode, string> = {
  pareto_auto: "Pareto auto",
  complexity_escalation: "Complexity escalation",
  strict_trust: "Strict trust SLA",
  low_latency: "Low latency SLA",
  pinned: "Pinned pair",
};

export const POLICY_HINT: Record<RoutingPolicyMode, string> = {
  pareto_auto: "Best trust per unit of cost and latency across all available pairs.",
  complexity_escalation: "Fast route for plain text; escalates to a 100% trap-safe reviewer when the payload looks risky.",
  strict_trust: "Every email goes through the fastest pair that caught all planted traps.",
  low_latency: "Fastest reviewed pair under 2.5s; escalates only when a relative date sits inside quoted text.",
  pinned: "Always the pinned pair, regardless of payload.",
};

/** The four planted traps (seed/labels.json), in PRD order. */
export type TrapId = "TRAP-01" | "TRAP-02" | "TRAP-03" | "TRAP-04";
export const TRAP_IDS: TrapId[] = ["TRAP-01", "TRAP-02", "TRAP-03", "TRAP-04"];

export interface TrapDef {
  id: TrapId;
  /** Matches trap.id in seed/labels.json. */
  labelId: string;
  projectId: string;
  title: string;
  short: string;
}

export const TRAPS: Record<TrapId, TrapDef> = {
  "TRAP-01": { id: "TRAP-01", labelId: "pdf-contradicts-email", projectId: "harbor-lobby", title: "Harbor & Pine: PDF (Levels 1-2) vs email body (3 floors)", short: "PDF TRAP" },
  "TRAP-02": { id: "TRAP-02", labelId: "stale-next-friday", projectId: "vector-driver-pilot", title: "Vector Freight: stale \"next Friday\" inside a forwarded email", short: "STALE DATE" },
  "TRAP-03": { id: "TRAP-03", labelId: "unaccepted-quote", projectId: "lumen-website", title: "Lumen Clinic: proposed quote marked as client-approved", short: "FALSE DECISION" },
  "TRAP-04": { id: "TRAP-04", labelId: "invoice-redirect", projectId: "lumen-booking", title: "Lumen Clinic: untrusted invoice redirect (BEC)", short: "BEC TRAP" },
};

/** AVOIDED = Reason never made the unsupported claim (the only safe outcome a single-pass pair can have). */
export type TrapOutcome = "BLOCKED" | "REVISED" | "AVOIDED" | "LEAKED";

export interface TrapResult {
  outcome: TrapOutcome;
  latencyMs: number;
  note: string;
}

export type VerdictBadge = "PARETO OPTIMAL" | "OVERKILL (SLOW)" | "UNSAFE FOR PROD" | `MISSED ${string}`;

export interface ModelPairBenchmark {
  id: string;
  label: string;
  reasonModel: ModelId;
  reviewModel: ModelId | null; // null = single-pass, unverified baseline
  rawReasonAccuracy: number; // project-filing accuracy before Review
  verifiedAccuracy: number; // after Review
  rescueLift: number; // verifiedAccuracy - rawReasonAccuracy
  signalRecall: number;
  trapsCaughtCount: number; // out of 4
  trapCatchRate: number;
  trapMatrix: Record<TrapId, TrapResult>;
  avgLatencyMs: number;
  costPer1kEmailsUsd: number;
  verdictBadge: VerdictBadge;
  /** "illustrative" = seed numbers, not measured; "measured" = from an eval_runs row. */
  source: "illustrative" | "measured";
  measuredAt: string | null;
  /** False when a model in the pair has no provider adapter yet; the router never selects it. */
  available: boolean;
}

export interface RoutingContext {
  projectId: string;
  projectName?: string;
  hasPdfAttachment: boolean;
  hasImageAttachment: boolean;
  containsFinancialOrScopeKeywords: boolean;
  isUnknownSenderDomain: boolean;
  /** "next Friday", "tomorrow"... inside forwarded or quoted text (trap 2). */
  hasQuotedRelativeDate: boolean;
  policyMode: RoutingPolicyMode;
  pinnedPairId?: string;
}

export interface RoutingDecision {
  selectedPair: ModelPairBenchmark;
  policyApplied: RoutingPolicyMode;
  wasEscalated: boolean;
  escalationTriggers: string[];
  routingReason: string;
  estimatedCostUsd: number; // per email
  estimatedLatencyMs: number;
}
