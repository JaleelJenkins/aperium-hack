import Link from "next/link";
import { getDb } from "@/lib/db";
import { caughtClaims } from "@/lib/inspect";
import { modelFamily } from "@/lib/router/leaderboard";
import { selectOptimalModelPair } from "@/lib/router/pairRouter";
import { getLeaderboard, getRouterSettings, latestRun, runDecisions } from "@/lib/router/store";
import type { ModelPairBenchmark, RoutingContext, TrapId, TrapOutcome } from "@/lib/router/types";
import { POLICY_LABEL, TRAP_IDS, TRAPS } from "@/lib/router/types";
import { ClaimDiff, Shell } from "../components/Drawer";
import { Icon } from "../components/Icon";
import { ago, pct, secs, signedPct, usd } from "../format";
import { PromoteButton } from "./PromoteButton";
import { RouterConsole } from "./RouterConsole";

export const dynamic = "force-dynamic";

const OUTCOME: Record<TrapOutcome, { label: string; cls: string; icon: "shield" | "spark" | "check" | "alert" }> = {
  BLOCKED: { label: "BLOCKED", cls: "blocked", icon: "shield" },
  REVISED: { label: "AUTO-REVISED", cls: "revised", icon: "spark" },
  AVOIDED: { label: "NOT CLAIMED", cls: "avoided", icon: "check" },
  LEAKED: { label: "LEAKED TO UI", cls: "leaked", icon: "alert" },
};

function badgeClass(b: string) {
  if (b === "PARETO OPTIMAL") return "pass";
  if (b === "OVERKILL (SLOW)") return "draft";
  if (b === "UNSAFE FOR PROD") return "block";
  return "risk";
}

function verdictLabel(b: string): string {
  if (b === "PARETO OPTIMAL") return "BEST BALANCE";
  if (b === "OVERKILL (SLOW)") return "HIGH COST / SLOW";
  if (b === "UNSAFE FOR PROD") return "NOT RECOMMENDED";
  if (b === "MISSED BEC TRAP") return "MISSED INVOICE CHECK";
  if (b === "MISSED PDF TRAP") return "MISSED PDF CHECK";
  return b;
}

const plainCtx = (over: Partial<RoutingContext>): RoutingContext => ({
  projectId: "kpi",
  hasPdfAttachment: false,
  hasImageAttachment: false,
  containsFinancialOrScopeKeywords: false,
  isUnknownSenderDomain: false,
  hasQuotedRelativeDate: false,
  policyMode: "pareto_auto",
  ...over,
});

/** Model Trust Scoreboard (PRD F6.6 + F7): pair router, leaderboard, trap matrix. */
export default async function ScoreboardPage({ searchParams }: { searchParams: Promise<{ trap?: string; pair?: string }> }) {
  const { trap, pair } = await searchParams;
  const db = getDb();
  const settings = getRouterSettings(db);
  const board = getLeaderboard(db);
  const emailCount = (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
  const run = latestRun(db);
  const decisions = run ? runDecisions(db, run.id) : [];
  const illustrative = board.some((p) => p.source === "illustrative");
  const byId = new Map(board.map((p) => [p.id, p]));

  // KPI tiles, all derived from the leaderboard and the active policy.
  const base = selectOptimalModelPair(plainCtx({ policyMode: settings.defaultPolicy, pinnedPairId: settings.pinnedPairId }), board);
  const risky = selectOptimalModelPair(
    plainCtx({ policyMode: settings.defaultPolicy, pinnedPairId: settings.pinnedPairId, hasPdfAttachment: true }),
    board,
  );
  const reviewed = board.filter((p) => p.reviewModel);
  const bestLift = reviewed.reduce((a, b) => (b.rescueLift > a.rescueLift ? b : a), reviewed[0]);
  const bestTrap = board.reduce((a, b) => (b.trapCatchRate > a.trapCatchRate || (b.trapCatchRate === a.trapCatchRate && b.avgLatencyMs < a.avgLatencyMs) ? b : a));
  const frontier = board.reduce((a, b) => (b.costPer1kEmailsUsd > a.costPer1kEmailsUsd ? b : a));
  const optimal = board.find((p) => p.verdictBadge === "PARETO OPTIMAL") ?? board[0];
  const cheaper = 1 - optimal.costPer1kEmailsUsd / frontier.costPer1kEmailsUsd;

  const trapId = TRAP_IDS.includes(trap as TrapId) ? (trap as TrapId) : null;
  const trapPair = pair ? byId.get(pair) : undefined;

  return (
    <div className="board-page scoreboard">
      <div className="page-head">
        <div>
          <div className="eyebrow">Model router</div>
          <h1>Model Trust Scoreboard</h1>
          <div className="muted">
            Compare how Draft × Review model pairs balance accuracy, speed, and cost—and choose how incoming emails are routed.
          </div>
        </div>
      </div>

      <RouterConsole leaderboard={board} defaultPolicy={settings.defaultPolicy} pinnedPairId={settings.pinnedPairId} emailCount={emailCount} />

      {illustrative && (
        <div className="illustrative-note">
          <span className="tag-illustrative mono">Sample benchmark</span>
          Rows marked sample use baseline numbers until a live evaluation run completes. Routing policies and the email simulator below run live.
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <div className="stat-label">
            <Icon name="board" size={12} />
            Active routing policy
          </div>
          <div className="kpi-value small">{POLICY_LABEL[settings.defaultPolicy]}</div>
          <div className="kpi-sub mono">
            {modelFamily(base.selectedPair.reasonModel)} → {modelFamily(base.selectedPair.reviewModel)}
            {risky.selectedPair.id !== base.selectedPair.id && (
              <>
                {" "}· ↑ {modelFamily(risky.selectedPair.reasonModel)} → {modelFamily(risky.selectedPair.reviewModel)} on complex mail
              </>
            )}
          </div>
        </div>
        <div className="kpi">
          <div className="stat-label">
            <Icon name="shield" size={12} />
            Review accuracy boost
          </div>
          <div className="kpi-value violet">{signedPct(bestLift.rescueLift)}</div>
          <div className="kpi-sub">Extra accuracy gained by adding a second review model ({modelFamily(bestLift.reasonModel)} → {modelFamily(bestLift.reviewModel)})</div>
        </div>
        <div className="kpi">
          <div className="stat-label">
            <Icon name="alert" size={12} />
            Safety checks passed
          </div>
          <div className="kpi-value green">
            {bestTrap.trapsCaughtCount} / 4 <span className="kpi-unit">({pct(bestTrap.trapCatchRate, 0)})</span>
          </div>
          <div className="kpi-sub">Catches PDF mismatches, outdated dates, unapproved quotes, and suspicious invoices</div>
        </div>
        <div className="kpi">
          <div className="stat-label">
            <Icon name="clock" size={12} />
            Speed &amp; cost per email
          </div>
          <div className="kpi-value small mono">
            {secs(optimal.avgLatencyMs)} · {usd(optimal.costPer1kEmailsUsd / 1000)}/email
          </div>
          <div className="kpi-sub">
            {pct(cheaper, 0)} lower cost than the heaviest {modelFamily(frontier.reasonModel)} → {modelFamily(frontier.reviewModel)} pair
          </div>
        </div>
      </div>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>Model Pair Comparison</h2>
          <span className="muted">Ranked by safety checks passed, accuracy after review, and response speed</span>
        </div>
        <div className="table-scroll">
          <table className="leaderboard">
            <thead>
              <tr>
                <th>#</th>
                <th>Draft → Review models</th>
                <th className="num">Draft accuracy</th>
                <th className="num">Post review</th>
                <th>Review boost</th>
                <th className="num">Items found</th>
                <th>Safety checks</th>
                <th className="num">Avg speed</th>
                <th className="num">Cost / 1k emails</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {board.map((p, i) => (
                <PairRow
                  key={p.id}
                  p={p}
                  rank={i + 1}
                  active={settings.defaultPolicy === "pinned" && settings.pinnedPairId === p.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>Safety Checks by Scenario</h2>
          <span className="muted">How each model pair handles 4 tricky email scenarios · click any cell to inspect</span>
        </div>
        <div className="table-scroll">
          <div className="matrix">
            <div className="m-corner mono">Model pair</div>
            {TRAP_IDS.map((id) => (
              <div className="m-head" key={id}>
                <span className="mono">{id}</span>
                <span>{TRAPS[id].title}</span>
              </div>
            ))}
            {board.map((p) => (
              <MatrixRow key={p.id} p={p} />
            ))}
          </div>
        </div>
      </section>

      {run && (
        <section className="panel table-panel">
          <div className="panel-head">
            <h2>Latest Routing Simulation</h2>
            <span className="muted mono">
              {run.emails} emails · {run.escalated} upgraded · {ago(run.finishedAt ?? run.startedAt)}
            </span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Project</th>
                  <th>Policy</th>
                  <th>Routed to</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => {
                  const pp = byId.get(d.pair_id);
                  const triggers = JSON.parse(d.triggers_json) as string[];
                  return (
                    <tr key={d.message_id}>
                      <td>
                        <Link href={`/messages/${encodeURIComponent(d.message_id)}`} className="subject">
                          {d.subject || "(no subject)"}
                        </Link>
                        <div className="muted mono" style={{ fontSize: 11 }}>
                          {d.sender_email}
                        </div>
                      </td>
                      <td>{d.project_name ?? <span className="muted">unfiled</span>}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {POLICY_LABEL[d.policy] ?? d.policy}
                      </td>
                      <td>
                        <span className="route-pair mono">{pp ? `${modelFamily(pp.reasonModel)} → ${modelFamily(pp.reviewModel)}` : d.pair_id}</span>
                        {d.escalated ? <span className="escalated-pill">Upgraded</span> : null}
                      </td>
                      <td style={{ fontSize: 12.5 }}>{triggers.length ? triggers.join(" · ") : <span className="muted">{d.reason}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {trapId && trapPair && <TrapDrawer trapId={trapId} pair={trapPair} />}
    </div>
  );
}

function PairRow({ p, rank, active }: { p: ModelPairBenchmark; rank: number; active: boolean }) {
  return (
    <tr className={active ? "row-active" : undefined}>
      <td className="mono">#{rank}</td>
      <td>
        <div className="pair-cell">
          <span className="route-pair mono">
            <Icon name="zap" size={12} />
            {p.label}
          </span>
          <div className="pair-tags">
            <span className={`verdict ${badgeClass(p.verdictBadge)}`}>{verdictLabel(p.verdictBadge)}</span>
            {p.source === "illustrative" ? (
              <span className="tag-illustrative mono">Sample</span>
            ) : (
              <span className="tag-measured mono">Measured {p.measuredAt ? ago(p.measuredAt) : ""}</span>
            )}
          </div>
        </div>
      </td>
      <td className="num mono">{pct(p.rawReasonAccuracy)}</td>
      <td className="num mono">{pct(p.verifiedAccuracy)}</td>
      <td>
        {p.reviewModel ? (
          <span className="lift-pill mono">
            <Icon name="shield" size={11} />
            {signedPct(p.rescueLift)} boost
          </span>
        ) : (
          <span className="muted mono">no review</span>
        )}
      </td>
      <td className="num mono">{pct(p.signalRecall)}</td>
      <td className="mono">
        <span className={p.trapsCaughtCount === 4 ? "ok-text" : p.trapsCaughtCount <= 2 ? "bad-text" : "warn-text"}>
          {p.trapsCaughtCount}/4
        </span>{" "}
        <span className="muted">({pct(p.trapCatchRate, 0)})</span>
      </td>
      <td className="num mono">{secs(p.avgLatencyMs)}</td>
      <td className="num mono">{usd(p.costPer1kEmailsUsd)}</td>
      <td>
        <PromoteButton pairId={p.id} label={p.label} active={active} available={p.available} />
      </td>
    </tr>
  );
}

function MatrixRow({ p }: { p: ModelPairBenchmark }) {
  return (
    <>
      <div className="m-pair">
        <span className="mono">
          {modelFamily(p.reasonModel)} → {modelFamily(p.reviewModel)}
        </span>
        {!p.available && <span className="muted mono" style={{ fontSize: 10 }}>no adapter</span>}
      </div>
      {TRAP_IDS.map((id) => {
        const r = p.trapMatrix[id];
        const o = OUTCOME[r.outcome];
        return (
          <Link key={id} className={`m-cell ${o.cls}`} href={`/scoreboard?trap=${id}&pair=${p.id}`} scroll={false} title={r.note}>
            <Icon name={o.icon} size={12} />
            <span>{o.label}</span>
            {r.outcome !== "LEAKED" && r.latencyMs > 0 && <span className="m-lat">· {secs(r.latencyMs)}</span>}
          </Link>
        );
      })}
    </>
  );
}

function TrapDrawer({ trapId, pair }: { trapId: TrapId; pair: ModelPairBenchmark }) {
  const trap = TRAPS[trapId];
  const r = pair.trapMatrix[trapId];
  const o = OUTCOME[r.outcome];
  const claims = caughtClaims(getDb()).filter((c) => c.project?.id === trap.projectId);
  return (
    <Shell
      vault={r.outcome === "LEAKED"}
      closeHref="/scoreboard"
      title={
        <>
          <Icon name="shield" size={14} />
          {trapId} · {pair.label}
        </>
      }
    >
      <div>
        <div className="drawer-title">{trap.title}</div>
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          <span className={`m-cell inline ${o.cls}`}>
            <Icon name={o.icon} size={12} />
            {o.label}
          </span>
          {pair.source === "illustrative" && <span className="tag-illustrative mono">Illustrative result</span>}
        </div>
      </div>
      <div>
        <div className="d-section-label">
          <Icon name="shield" size={12} />
          Review outcome for this pair
        </div>
        <div className="audit">
          <div className="audit-step review">
            <span className="ico">
              <Icon name="shield" size={12} />
            </span>
            <div className="audit-who">
              {pair.reviewModel ? `Review · ${modelFamily(pair.reviewModel)}` : "No reviewer (single pass)"}
              {r.latencyMs > 0 && <span>{secs(r.latencyMs)}</span>}
            </div>
            <div className="audit-what">{r.note}</div>
          </div>
        </div>
      </div>
      <div>
        <div className="d-section-label">
          <Icon name="file" size={12} />
          The planted trap on this board
        </div>
        {claims.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {claims.map((c) => (
              <ClaimDiff key={c.id} c={c} />
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No blocked claim recorded for this project yet. Seed the trap email (seed/labels.json, <span className="mono">{trap.labelId}</span>) and
            run the pipeline.
          </p>
        )}
      </div>
    </Shell>
  );
}
