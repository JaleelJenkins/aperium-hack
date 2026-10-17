/**
 * Asymmetric pair router: picks a Reason -> Review pair per email from the leaderboard,
 * the project's policy and payload risk signals. Pure functions only; used on the server
 * (dry-run, board route traces) and in the browser (scoreboard simulator).
 */
import { modelLabel } from "./leaderboard";
import type { ModelPairBenchmark, RoutingContext, RoutingDecision, RoutingPolicyMode } from "./types";

export const LOW_LATENCY_BUDGET_MS = 2500;

export const TRIGGER = {
  pdf: "Multimodal PDF contradiction risk",
  keywords: "Billing/scope mutation keyword",
  unknownSender: "Untrusted external sender domain",
  quotedDate: "Relative date inside quoted/forwarded text",
} as const;

/** Payload risk signals that justify an escalated (100% trap-safe) reviewer. */
export function riskTriggers(ctx: RoutingContext): string[] {
  const out: string[] = [];
  if (ctx.hasPdfAttachment) out.push(TRIGGER.pdf);
  if (ctx.containsFinancialOrScopeKeywords) out.push(TRIGGER.keywords);
  if (ctx.isUnknownSenderDomain) out.push(TRIGGER.unknownSender);
  if (ctx.hasQuotedRelativeDate) out.push(TRIGGER.quotedDate);
  return out;
}

const decision = (
  pair: ModelPairBenchmark,
  policy: RoutingPolicyMode,
  wasEscalated: boolean,
  triggers: string[],
  routingReason: string,
): RoutingDecision => ({
  selectedPair: pair,
  policyApplied: policy,
  wasEscalated,
  escalationTriggers: triggers,
  routingReason,
  estimatedCostUsd: pair.costPer1kEmailsUsd / 1000,
  estimatedLatencyMs: pair.avgLatencyMs,
});

const byLatency = (a: ModelPairBenchmark, b: ModelPairBenchmark) => a.avgLatencyMs - b.avgLatencyMs;

/** Fastest pair that caught every trap; if none did, the most trap-safe (then fastest). */
function fastestTrapSafe(pairs: ModelPairBenchmark[]): ModelPairBenchmark {
  const safe = pairs.filter((p) => p.reviewModel && p.trapCatchRate === 1).sort(byLatency);
  if (safe.length) return safe[0];
  return [...pairs].sort((a, b) => b.trapCatchRate - a.trapCatchRate || byLatency(a, b))[0];
}

/** Fastest pair that still has a reviewer (never the unverified single-pass baseline). */
function fastestReviewed(pairs: ModelPairBenchmark[]): ModelPairBenchmark {
  return pairs.filter((p) => p.reviewModel).sort(byLatency)[0] ?? [...pairs].sort(byLatency)[0];
}

/** Utility = trust + recall - normalized latency/cost penalties. Higher is better. */
export function paretoScore(p: ModelPairBenchmark, pairs: ModelPairBenchmark[], weights = { trust: 1, speed: 0.3 }): number {
  const maxLatency = Math.max(...pairs.map((x) => x.avgLatencyMs));
  const maxCost = Math.max(...pairs.map((x) => x.costPer1kEmailsUsd));
  return (
    p.trapCatchRate * weights.trust +
    p.signalRecall * 0.25 -
    (p.avgLatencyMs / maxLatency) * weights.speed -
    (p.costPer1kEmailsUsd / maxCost) * 0.1
  );
}

export function selectOptimalModelPair(ctx: RoutingContext, leaderboard: ModelPairBenchmark[]): RoutingDecision {
  // Never route to a pair whose models have no provider adapter.
  const pairs = leaderboard.filter((p) => p.available);
  if (!pairs.length) throw new Error("No available model pairs to route to.");
  const triggers = riskTriggers(ctx);
  const escalatedTo = (p: ModelPairBenchmark, why: string[]) =>
    `Auto-escalated to ${p.label} due to: ${why.join("; ")}`;

  switch (ctx.policyMode) {
    case "pinned": {
      const pinned = pairs.find((p) => p.id === ctx.pinnedPairId);
      if (pinned) return decision(pinned, "pinned", false, triggers, `Pinned to ${pinned.label}.`);
      // Pinned pair missing or unavailable: fall back to Pareto rather than fail the email.
      const fallback = selectOptimalModelPair({ ...ctx, policyMode: "pareto_auto" }, leaderboard);
      return { ...fallback, routingReason: `Pinned pair "${ctx.pinnedPairId ?? "?"}" unavailable; ${fallback.routingReason}` };
    }

    case "strict_trust": {
      const p = fastestTrapSafe(pairs);
      const why = triggers.length ? triggers : ["Strict trust SLA"];
      return decision(p, "strict_trust", true, why, `Strict trust SLA: ${p.label} is the fastest pair that caught ${p.trapsCaughtCount}/4 traps.`);
    }

    case "complexity_escalation": {
      if (triggers.length) {
        const p = fastestTrapSafe(pairs);
        return decision(p, "complexity_escalation", true, triggers, escalatedTo(p, triggers));
      }
      const p = fastestReviewed(pairs);
      return decision(p, "complexity_escalation", false, [], `Low-risk plain text payload → fast route (${p.label}).`);
    }

    case "low_latency": {
      if (ctx.hasQuotedRelativeDate) {
        const p = fastestTrapSafe(pairs);
        return decision(p, "low_latency", true, [TRIGGER.quotedDate], escalatedTo(p, [TRIGGER.quotedDate]));
      }
      const inBudget = pairs
        .filter((p) => p.reviewModel && p.avgLatencyMs <= LOW_LATENCY_BUDGET_MS)
        .sort((a, b) => b.trapCatchRate - a.trapCatchRate || byLatency(a, b));
      const p = inBudget[0] ?? fastestReviewed(pairs);
      return decision(
        p,
        "low_latency",
        false,
        [],
        inBudget.length
          ? `Low latency SLA: ${p.label} is the most trap-safe reviewed pair under ${LOW_LATENCY_BUDGET_MS / 1000}s.`
          : `Low latency SLA: no reviewed pair under ${LOW_LATENCY_BUDGET_MS / 1000}s; fastest reviewed pair ${p.label}.`,
      );
    }

    case "pareto_auto":
    default: {
      const scored = pairs.map((p) => ({ p, s: paretoScore(p, pairs) })).sort((a, b) => b.s - a.s);
      const { p, s } = scored[0];
      return decision(p, "pareto_auto", false, triggers, `Pareto auto: ${p.label} has the best trust/cost/latency utility (${s.toFixed(2)}).`);
    }
  }
}

// ---------------------------------------------------------------- payload inspection

export interface RoutableEmail {
  senderEmail: string | null;
  /** Raw text including quoted/forwarded history (clean_text strips it). */
  text: string;
  attachments: { mimeType: string }[];
}

export interface RoutableProject {
  id: string;
  name?: string;
  clientDomains: string[];
  knownContacts: string[];
  /** Our own addresses: outbound mail is never "unknown sender". */
  ourAddresses?: string[];
  policyMode: RoutingPolicyMode;
  pinnedPairId?: string;
}

const RISK_KEYWORDS = /\b(invoice|wire|routing|bank|floors?|scope|sow|contract|urgent)\b/i;
const QUOTE_MARKER = /(-{2,}\s*Forwarded message\s*-{2,}|^On .+wrote:\s*$|^>)/im;
const RELATIVE_DATE = /\b(next (mon|tues|wednes|thurs|fri|satur|sun)day|next week|tomorrow|end of (the )?week|this (fri|thurs)day)\b/i;

/** Builds a RoutingContext from an incoming email and its project. */
export function inspectEmailPayloadForRouting(email: RoutableEmail, project: RoutableProject): RoutingContext {
  const sender = (email.senderEmail ?? "").toLowerCase();
  const domain = sender.split("@")[1] ?? "";
  const known =
    project.knownContacts.map((c) => c.toLowerCase()).includes(sender) ||
    (project.ourAddresses ?? []).map((c) => c.toLowerCase()).includes(sender) ||
    project.clientDomains.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`));

  const marker = email.text.search(QUOTE_MARKER);
  const quoted = marker >= 0 ? email.text.slice(marker) : "";

  return {
    projectId: project.id,
    projectName: project.name,
    hasPdfAttachment: email.attachments.some((a) => a.mimeType.toLowerCase() === "application/pdf"),
    hasImageAttachment: email.attachments.some((a) => a.mimeType.toLowerCase().startsWith("image/")),
    containsFinancialOrScopeKeywords: RISK_KEYWORDS.test(email.text),
    isUnknownSenderDomain: sender !== "" && !known,
    hasQuotedRelativeDate: quoted !== "" && RELATIVE_DATE.test(quoted),
    policyMode: project.policyMode,
    pinnedPairId: project.pinnedPairId,
  };
}

export const pairShort = (p: ModelPairBenchmark) => `${modelLabel(p.reasonModel).split(" ")[0]} → ${p.reviewModel ? modelLabel(p.reviewModel).split(" ")[0] : "none"}`;
