"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { dryRunOneAction, finishDryRunAction, setDefaultPolicyAction, startDryRunAction } from "../actions";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { secs, usd } from "../format";
import { selectOptimalModelPair } from "@/lib/router/pairRouter";
import type { ModelPairBenchmark, RoutingPolicyMode } from "@/lib/router/types";
import { POLICY_HINT, POLICY_LABEL, POLICY_MODES } from "@/lib/router/types";

const POLICY_ICON: Record<RoutingPolicyMode, "zap" | "shield" | "alert" | "clock" | "board"> = {
  pareto_auto: "zap",
  complexity_escalation: "shield",
  strict_trust: "alert",
  low_latency: "clock",
  pinned: "board",
};

const SIGNALS = [
  { key: "pdf", label: "PDF attached" },
  { key: "keywords", label: "Financial / scope keywords" },
  { key: "unknown", label: "Unknown sender domain" },
  { key: "quoted", label: "Relative date in quoted text" },
] as const;
type SimKey = (typeof SIGNALS)[number]["key"];

/**
 * Active routing policy + dry-run payload simulator + "Run seed eval".
 * The simulator runs the same selectOptimalModelPair the server uses, in the browser.
 */
export function RouterConsole({
  leaderboard,
  defaultPolicy,
  pinnedPairId,
  emailCount,
}: {
  leaderboard: ModelPairBenchmark[];
  defaultPolicy: RoutingPolicyMode;
  pinnedPairId: string;
  emailCount: number;
}) {
  const router = useRouter();
  const [toast, show] = useToast();
  const [policy, setPolicy] = useState(defaultPolicy);
  useEffect(() => setPolicy(defaultPolicy), [defaultPolicy]); // follow server after a promote
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

  function changePolicy(mode: RoutingPolicyMode) {
    setPolicy(mode); // optimistic: the simulator updates instantly
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
      show(`Routed ${s.emails} emails: ${s.escalated} escalated, ${s.emails - s.escalated} on the fast route.`);
      router.refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setTimeout(() => setProgress(null), 1200);
    }
  }

  const p = decision.selectedPair;
  return (
    <section className="console">
      <div className="console-top">
        <div>
          <div className="d-section-label">Active routing policy (global default)</div>
          <nav className="segmented policy-seg" aria-label="Default routing policy">
            {POLICY_MODES.map((m) => (
              <button key={m} type="button" className={policy === m ? "on" : ""} onClick={() => changePolicy(m)} disabled={pending}>
                <Icon name={POLICY_ICON[m]} size={12} />
                {POLICY_LABEL[m]}
              </button>
            ))}
          </nav>
          <div className="muted console-hint">{POLICY_HINT[policy]}</div>
        </div>
        <div className="spacer" />
        <div className="run-eval">
          <button type="button" className="btn primary" onClick={runEval} disabled={progress !== null || emailCount === 0}>
            <Icon name="zap" size={13} />
            {progress ? `Routing ${progress.done}/${progress.total}…` : `Run seed eval (${emailCount} emails)`}
          </button>
          <div className="muted run-sub">Routing dry-run: real router, no model calls</div>
          {progress && (
            <div className="progress" aria-label="Dry-run progress">
              <span style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
            </div>
          )}
        </div>
      </div>

      <div className="simulator">
        <span className="sim-label mono">Dry-run payload</span>
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
          {decision.wasEscalated && <span className="escalated-pill">Escalated</span>}
          <span className="mono muted">
            {secs(decision.estimatedLatencyMs)} · {usd(decision.estimatedCostUsd)}/email
          </span>
        </span>
      </div>
      <div className="sim-reason">{decision.routingReason}</div>
      {toast}
    </section>
  );
}
