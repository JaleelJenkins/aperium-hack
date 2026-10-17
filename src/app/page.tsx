import Link from "next/link";
import { getBoard, type BoardFilter } from "@/lib/board";
import { getDb } from "@/lib/db";
import { caughtClaims, caughtCount, inspect, parseInspectRef } from "@/lib/inspect";
import { BoardView, type HrefFor } from "./components/Board";
import { ConnectionBanners, ConnectionControls, InboxStatus } from "./components/Connection";
import { CaughtDrawer, InspectorDrawer } from "./components/Drawer";
import { Icon } from "./components/Icon";
import { AutoRefresh } from "./components/LiveControls";
import { TuneDrawer } from "./components/TuneDrawer";

export const dynamic = "force-dynamic";

/**
 * Portfolio board (PRD F6.1) with the evidence drawer (F6.4) and the Caught-by-review
 * vault (F6.5). The drawer is driven by ?open=<ref> so opening it is one click, keeps the
 * board's scroll position, and survives the 5-second auto refresh.
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; open?: string; error?: string; connected?: string; disconnected?: string }>;
}) {
  const { view, open, ...flash } = await searchParams;
  const filter: BoardFilter = view === "attention" ? "attention" : "all";
  const db = getDb();
  const board = getBoard(db, { filter });
  const t = board.totals;
  const caught = caughtCount(db);

  const hrefFor: HrefFor = (ref) => {
    const p = new URLSearchParams();
    if (filter !== "all") p.set("view", filter);
    if (ref) p.set("open", ref);
    const q = p.toString();
    return q ? `/?${q}` : "/";
  };
  const filterHref = (f: BoardFilter) => {
    const p = new URLSearchParams();
    if (f !== "all") p.set("view", f);
    if (open) p.set("open", open);
    const q = p.toString();
    return q ? `/?${q}` : "/";
  };

  const ref = parseInspectRef(open);
  const inspection = ref && ref.type !== "caught" ? inspect(db, ref) : null;

  return (
    <div className="board-page">
      <AutoRefresh />
      <ConnectionBanners {...flash} />

      <div className="page-head">
        <div>
          <div className="eyebrow">Portfolio</div>
          <h1>Portfolio Overview</h1>
          <div className="muted">
            <InboxStatus />
          </div>
        </div>
        <div className="spacer" />
        <ConnectionControls />
      </div>

      <div className="stats">
        <Stat label="Open items" value={t.open} />
        <Stat label="Overdue" value={t.overdue} tone={t.overdue ? "bad" : undefined} icon="clock" />
        <Stat label="Drafts staged" value={t.approvals} tone={t.approvals ? "accent" : undefined} icon="mail" />
        <Stat label="Caught by review" value={caught} tone="shield" icon="shield" />
        <Stat label="Projects at risk" value={`${t.atRisk}/${t.projects}`} tone={t.atRisk ? "warn" : undefined} icon="alert" />
      </div>

      {caught > 0 && (
        <div className="quarantine trap-quarantine-banner">
          <span className="quarantine-icon">
            <Icon name="shield" size={15} />
          </span>
          <div>
            <strong>
              {caught} unsupported claim{caught === 1 ? "" : "s"} caught by review
            </strong>
            <div className="q-sub">Blocked before reaching this board. Each one logs the evidence it contradicted.</div>
          </div>
          <Link className="btn" href={hrefFor("caught")} scroll={false}>
            View claims
          </Link>
        </div>
      )}

      <div className="toolbar">
        <nav className="segmented" aria-label="Filter projects">
          <Link href={filterHref("all")} className={filter === "all" ? "on" : ""} scroll={false}>
            All projects
          </Link>
          <Link href={filterHref("attention")} className={filter === "attention" ? "on" : ""} scroll={false}>
            Needs attention
          </Link>
        </nav>
        <span className="muted toolbar-hint">Sorted by risk · click any card to inspect its evidence</span>
      </div>

      <BoardView board={board} hrefFor={hrefFor} selected={open ?? null} />

      {inspection && <InspectorDrawer item={inspection} hrefFor={hrefFor} />}
      {ref?.type === "caught" && <CaughtDrawer claims={caughtClaims(db)} hrefFor={hrefFor} />}
      {open?.startsWith("tune:") && <TuneDrawer db={db} projectId={open.slice("tune:".length)} closeHref={hrefFor(null)} />}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number | string;
  tone?: "bad" | "warn" | "accent" | "shield";
  icon?: "clock" | "mail" | "shield" | "alert";
}) {
  return (
    <div className={`stat-card${tone ? ` ${tone}` : ""}`}>
      <div className="stat-label">
        {icon && <Icon name={icon} size={12} />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
