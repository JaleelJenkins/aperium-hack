import { getBoard, type BoardFilter } from "@/lib/board";
import { getDb } from "@/lib/db";
import { BoardView } from "./components/Board";
import { ConnectionBanners, ConnectionControls, InboxStatus } from "./components/Connection";
import { Icon } from "./components/Icon";
import { AutoRefresh } from "./components/LiveControls";

export const dynamic = "force-dynamic";

/** Portfolio board (PRD F6.1): every client project as a swimlane, sorted by what needs attention. */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; error?: string; connected?: string; disconnected?: string }>;
}) {
  const { view, ...flash } = await searchParams;
  const filter: BoardFilter = view === "attention" ? "attention" : "all";
  const board = getBoard(getDb(), { filter });
  const t = board.totals;

  return (
    <div className="board-page">
      <AutoRefresh />
      <ConnectionBanners {...flash} />

      <div className="page-head">
        <div>
          <div className="eyebrow">Portfolio</div>
          <h1>Client board</h1>
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
        <Stat label="Needs approval" value={t.approvals} tone={t.approvals ? "accent" : undefined} icon="spark" />
        <Stat label="Blocked by review" value={t.blockedByReview} tone="shield" icon="shield" />
        <Stat label="Projects at risk" value={`${t.atRisk}/${t.projects}`} tone={t.atRisk ? "warn" : undefined} icon="alert" />
      </div>

      <div className="toolbar">
        <nav className="segmented" aria-label="Filter projects">
          <a href="/" className={filter === "all" ? "on" : ""}>
            All projects
          </a>
          <a href="/?view=attention" className={filter === "attention" ? "on" : ""}>
            Needs attention
          </a>
        </nav>
        <span className="muted toolbar-hint">Sorted by risk · click any card to open its evidence</span>
      </div>

      <BoardView board={board} />
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
  icon?: "clock" | "spark" | "shield" | "alert";
}) {
  return (
    <div className={`stat-card${tone ? ` ${tone}` : ""}`}>
      <div className="stat-label">
        {icon && <Icon name={icon} size={13} />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
