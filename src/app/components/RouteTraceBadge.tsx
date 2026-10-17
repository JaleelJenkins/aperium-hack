import type { RouteTrace } from "@/lib/board";
import { TRIGGER } from "@/lib/router/pairRouter";
import { POLICY_LABEL } from "@/lib/router/types";
import { secs, usd } from "../format";
import { Icon } from "./Icon";

const TRIGGER_SHORT: Record<string, string> = {
  [TRIGGER.pdf]: "PDF attached",
  [TRIGGER.keywords]: "Billing/scope",
  [TRIGGER.unknownSender]: "Unknown sender",
  [TRIGGER.quotedDate]: "Quoted date",
  "Strict trust SLA": "Strict SLA",
};

/**
 * Compact route trace for card footers: "⇄ Haiku → Sonnet · 3.8s", an "↑ Escalated" pill,
 * and a hover/focus popover with the full routing decision. Pure CSS popover, so it
 * works inside the card's link without client JS.
 */
export function RouteTraceBadge({ route }: { route: RouteTrace }) {
  const firstTrigger = route.triggers[0];
  return (
    <>
      <span className="route-trace" tabIndex={0} aria-label={`Route: ${route.pairLabel}`}>
        <Icon name="refresh" size={11} />
        {route.pairShort} · {secs(route.estLatencyMs)}
        <span className="route-pop" role="tooltip">
          <span className="pop-title">{route.recorded ? "Routed at ingest" : "Route trace · live policy"}</span>
          <span className="pop-grid">
            <span className="k">Policy</span>
            <span className="v">{POLICY_LABEL[route.policy] ?? route.policy}</span>
            <span className="k">Pair</span>
            <span className="v">{route.pairLabel}</span>
            <span className="k">Escalated</span>
            <span className="v">{route.escalated ? route.triggers.join("; ") || "yes" : "no"}</span>
            <span className="k">Est. cost</span>
            <span className="v">
              {usd(route.estCostUsd)} / email{route.illustrative ? " (illustrative)" : ""}
            </span>
            <span className="k">Est. latency</span>
            <span className="v">{secs(route.estLatencyMs)}</span>
            <span className="k">Why</span>
            <span className="v">{route.reason}</span>
          </span>
        </span>
      </span>
      {route.escalated && firstTrigger && (
        <span className="escalated-pill" title={route.triggers.join("; ")}>
          ↑ {TRIGGER_SHORT[firstTrigger] ?? firstTrigger}
        </span>
      )}
    </>
  );
}
