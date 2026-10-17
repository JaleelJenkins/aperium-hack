"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { dryRunOneAction, finishDryRunAction, setDefaultPolicyAction, startDryRunAction } from "../actions";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { pct, secs, signedPct, usd } from "../format";
import { modelFamily } from "@/lib/router/leaderboard";
import { selectOptimalModelPair } from "@/lib/router/pairRouter";
import type { ModelPairBenchmark, RoutingContext, RoutingPolicyMode } from "@/lib/router/types";
import { ACTIVE_POLICY_MODES, normalizeActivePolicy, POLICY_HINT, POLICY_LABEL } from "@/lib/router/types";

const POLICY_ICON: Record<RoutingPolicyMode, "zap" | "shield" | "alert" | "clock" | "board"> = {
  pareto_auto: "zap",
  complexity_escalation: "zap",
  low_latency: "clock",
  strict_trust: "shield",
  pinned: "board",
};

const SIGNALS = [
  { key: "pdf", label: "PDF attached" },
  { key: "keywords", label: "Billing / scope change words" },
  { key: "unknown", label: "Unknown sender domain" },
  { key: "quoted", label: "Relative date in forwarded text" },
] as const;
type SimKey = (typeof SIGNALS)[number]["key"];

const plainCtx = (over: Partial<RoutingContext>): RoutingContext => ({
  projectId: "kpi",
  hasPdfAttachment: false,
  hasImageAttachment: false,
  containsFinancialOrScopeKeywords: false,
  isUnknownSenderDomain: false,
  hasQuotedRelativeDate: false,
  policyMode: "complexity_escalation",
  ...over,
});

/**
 * Active routing policy (3 options with definitions) + interactive email simulator + live KPI tiles.
 */
export function RouterConsole({
  leaderboard,
  defaultPolicy,
  pinnedPairId,
  emailCount,
  illustrative,
}: {
  leaderboard: ModelPairBenchmark[];
  defaultPolicy: RoutingPolicyMode;
  pinnedPairId: string;
  emailCount: number;
  illustrative?: boolean;
}) {
  const router = useRouter();
  const [toast, show] = useToast();
  const [policy, setPolicy] = useState<RoutingPolicyMode>(
    defaultPolicy === "pinned" ? "pinned" : normalizeActivePolicy(defaultPolicy),
  );
  useEffect(
    () => setPolicy(defaultPolicy === "pinned" ? "pinned" : normalizeActivePolicy(defaultPolicy)),
    [defaultPolicy],
  );
  const [pending, startTransition] = useTransition();
  const [sim, setSim] = useState<Record<SimKey, boolean>>({ pdf: true, keywords: true, unknown: false, quoted: false });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const decision = useMemo(
    () =>
      selectOptimalModelPair(
        {
          projectId: "simulator",
          hasPdfAttachment: sim.pdf,
          hasImageAttachment: false,
          containsFinancialOrScopeKeywords: sim.keywords,
          isUnknownSenderDomain: sim.unknown,
          hasQuotedRelativeDate: sim.quoted,
          policyMode: policy,
          pinnedPairId,
        },
        leaderboard,
      ),
    [sim, policy, pinnedPairId, leaderboard],
  );

  // Compute policy-reactive KPI metrics so switching policies updates Speed & cost, Boost, and Safety checks immediately.
  const kpi = useMemo(() => {
    const base = selectOptimalModelPair(plainCtx({ policyMode: policy, pinnedPairId }), leaderboard).selectedPair;
    const risky = selectOptimalModelPair(
      plainCtx({ policyMode: policy, pinnedPairId, hasPdfAttachment: true, containsFinancialOrScopeKeywords: true }),
      leaderboard,
    ).selectedPair;
    const frontier = leaderboard.reduce((a, b) => (b.costPer1kEmailsUsd > a.costPer1kEmailsUsd ? b : a), leaderboard[0]);

    // Balanced (complexity_escalation) blends fast route (60% everyday mail) + upgraded route (40% complex mail).
    const isBlended = base.id !== risky.id;
    const avgLatencyMs = isBlended ? Math.round(base.avgLatencyMs * 0.6 + risky.avgLatencyMs * 0.4) : base.avgLatencyMs;
    const costPer1kUsd = isBlended ? base.costPer1kEmailsUsd * 0.6 + risky.costPer1kEmailsUsd * 0.4 : base.costPer1kEmailsUsd;
    const cheaper = frontier.costPer1kEmailsUsd > 0 ? 1 - costPer1kUsd / frontier.costPer1kEmailsUsd : 0;

    // Effective safety & review boost under this policy when risky emails arrive:
    const effectiveRiskyPair = risky;
    return {
      base,
      risky,
      isBlended,
      avgLatencyMs,
      costPerEmailUsd: costPer1kUsd / 1000,
      cheaper,
      frontier,
      rescueLift: effectiveRiskyPair.rescueLift,
      rawAcc: effectiveRiskyPair.rawReasonAccuracy,
      verifiedAcc: effectiveRiskyPair.verifiedAccuracy,
      trapsCaught: effectiveRiskyPair.trapsCaughtCount,
      trapRate: effectiveRiskyPair.trapCatchRate,
    };
  }, [policy, pinnedPairId, leaderboard]);

  function changePolicy(mode: RoutingPolicyMode) {
    setPolicy(mode); // optimistic: the simulator and KPI tiles update instantly
    startTransition(async () => {
      const r = await setDefaultPolicyAction(mode);
      show(r.message, r.ok ? "ok" : "bad");
      router.refresh();
    });
  }

  async function runEval() {
    try {
      const { runId, messageIds } = await startDryRunAction();
      setProgress({ done: 0, total: messageIds.length });
      for (let i = 0; i < messageIds.length; i++) {
        await dryRunOneAction(runId, messageIds[i]);
        setProgress({ done: i + 1, total: messageIds.length });
      }
      const s = await finishDryRunAction(runId);
      show(`Simulated ${s.emails} emails: ${s.escalated} upgraded to stronger review, ${s.emails - s.escalated} stayed on the fast route.`);
      router.refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setTimeout(() => setProgress(null), 1200);
    }
  }

  const p = decision.selectedPair;
  return (
    <>
      <section className="console">
        <div className="console-top">
          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="d-section-label">Active routing policy (choose 1 of 3 global defaults)</div>
            <div className="policy-cards" role="radiogroup" aria-label="Default routing policy">
              {ACTIVE_POLICY_MODES.map((m) => {
                const isOn = policy === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={isOn}
                    className={`policy-card${isOn ? " on" : ""}`}
                    onClick={() => changePolicy(m)}
                    disabled={pending}
                  >
                    <div className="policy-card-head">
                      <Icon name={POLICY_ICON[m]} size={13} />
                      <span>{POLICY_LABEL[m]}</span>
                      {isOn && <span className="policy-active-dot" aria-hidden="true" />}
                    </div>
                    <div className="policy-card-desc">{POLICY_HINT[m]}</div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="run-eval">
            <button type="button" className="btn primary" onClick={runEval} disabled={progress !== null || emailCount === 0}>
              <Icon name="zap" size={13} />
              {progress ? `Testing ${progress.done}/${progress.total}…` : `Test router (${emailCount} emails)`}
            </button>
            <div className="muted run-sub">Simulates routing across your inbox (no API cost)</div>
            {progress && (
              <div className="progress" aria-label="Simulation progress">
                <span style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
              </div>
            )}
          </div>
        </div>

        <div className="simulator">
          <span className="sim-label mono">Test email signals</span>
          {SIGNALS.map((s) => (
            <label key={s.key} className={`sim-check${sim[s.key] ? " on" : ""}`}>
              <input type="checkbox" checked={sim[s.key]} onChange={(e) => setSim({ ...sim, [s.key]: e.target.checked })} />
              {s.label}
            </label>
          ))}
          <span className="spacer" />
          <span className="sim-result">
            <span className="route-pair mono">
              <Icon name="zap" size={12} />
              {p.label.replace(" → ", "  →  ")}
            </span>
            {decision.wasEscalated && <span className="escalated-pill">Upgraded</span>}
            <span className="mono muted">
              {secs(decision.estimatedLatencyMs)} · {usd(decision.estimatedCostUsd)}/email
            </span>
          </span>
        </div>
        <div className="sim-reason">{decision.routingReason}</div>
        {toast}
      </section>

      {illustrative && (
        <div className="illustrative-note">
          <span className="tag-illustrative mono">Sample benchmark</span>
          Rows marked sample use baseline numbers until a live evaluation run completes. Routing policies and the email simulator above run live.
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <div className="stat-label">
            <Icon name="board" size={12} />
            Active routing policy
          </div>
          <div className="kpi-value small">
            {policy === "pinned" ? `Pinned: ${kpi.base.label}` : POLICY_LABEL[policy]}
          </div>
          <div className="kpi-sub mono">
            {modelFamily(kpi.base.reasonModel)} → {modelFamily(kpi.base.reviewModel)}
            {kpi.isBlended && (
              <>
                {" "}· ↑ {modelFamily(kpi.risky.reasonModel)} → {modelFamily(kpi.risky.reviewModel)} on complex mail
              </>
            )}
          </div>
        </div>
        <div className="kpi">
          <div className="stat-label">
            <Icon name="shield" size={12} />
            Review accuracy boost
          </div>
          <div className="kpi-value violet">{kpi.risky.reviewModel ? signedPct(kpi.rescueLift) : "0%"}</div>
          <div className="kpi-sub">
            {kpi.risky.reviewModel
              ? `${pct(kpi.rawAcc)} draft → ${pct(kpi.verifiedAcc)} after ${modelFamily(kpi.risky.reviewModel)} review`
              : "Single-pass model with no second reviewer"}
          </div>
        </div>
        <div className="kpi">
          <div className="stat-label">
            <Icon name="alert" size={12} />
            Safety checks passed
          </div>
          <div className="kpi-value green">
            {kpi.trapsCaught} / 4 <span className="kpi-unit">({pct(kpi.trapRate, 0)})</span>
          </div>
          <div className="kpi-sub">
            {kpi.trapsCaught === 4
              ? "Catches PDF mismatches, outdated dates, unapproved quotes, and suspicious invoices"
              : `Fast route (${modelFamily(kpi.risky.reasonModel)} → ${modelFamily(kpi.risky.reviewModel)}) trades 1 safety check for lower latency`}
          </div>
        </div>
        <div className="kpi">
          <div className="stat-label">
            <Icon name="clock" size={12} />
            Speed &amp; cost per email
          </div>
          <div className="kpi-value small mono">
            {secs(kpi.avgLatencyMs)} · {usd(kpi.costPerEmailUsd)}/email{kpi.isBlended ? " avg" : ""}
          </div>
          <div className="kpi-sub">
            {kpi.isBlended
              ? `${secs(kpi.base.avgLatencyMs)} on everyday mail (${secs(kpi.risky.avgLatencyMs)} when upgraded) · ${pct(kpi.cheaper, 0)} cheaper than ${modelFamily(kpi.frontier.reasonModel)} → ${modelFamily(kpi.frontier.reviewModel)}`
              : kpi.cheaper > 0
                ? `${pct(kpi.cheaper, 0)} lower cost than the heaviest ${modelFamily(kpi.frontier.reasonModel)} → ${modelFamily(kpi.frontier.reviewModel)} pair`
                : `Heaviest frontier pair (${modelFamily(kpi.frontier.reasonModel)} → ${modelFamily(kpi.frontier.reviewModel)})`}
          </div>
        </div>
      </div>
    </>
  );
}
