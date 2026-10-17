import type { Board, BoardCard, CardKind, ClientGroup, ColumnId, Health, Lane } from "@/lib/board";
import { COLUMNS } from "@/lib/board";
import { ago, dueText, hue, initials, modelShort } from "../format";
import { Icon, type IconName } from "./Icon";

const KIND_LABEL: Record<CardKind, string> = {
  email: "Email",
  ask: "Ask",
  our_commitment: "We owe",
  their_commitment: "They owe",
  deadline: "Deadline",
  decision: "Decision",
  risk: "Risk",
  draft_reply: "Draft reply",
  internal_task: "Task",
  new_project: "New project?",
};

const HEALTH_LABEL: Record<Health, string> = { on_track: "On track", at_risk: "At risk", blocked: "Blocked" };

const EMPTY_HINT: Partial<Record<ColumnId, string>> = {
  triage: "",
  on_us: "Nothing owed",
  on_client: "Nothing pending",
  approval: "No drafts waiting",
  done: "",
};

export function HealthPill({ health }: { health: Health }) {
  return <span className={`health ${health}`}>{HEALTH_LABEL[health]}</span>;
}

function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ ["--h" as string]: hue(name), width: size, height: size }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** messages.status -> what the pipeline is doing with it right now. */
function emailStage(status: string, triage: boolean): string {
  switch (status) {
    case "ingested":
      return "Reading";
    case "extracted":
      return "Matching project";
    case "resolved":
      return triage ? "Waiting for a person" : "Extracting signals";
    case "reasoned":
      return "In model review";
    default:
      return status;
  }
}

function Card({ card, triage = false }: { card: BoardCard; triage?: boolean }) {
  const failed = card.status?.startsWith("failed");
  const stage = card.kind === "email" && card.status && !failed ? emailStage(card.status, triage) : null;
  const waiting = stage === "Waiting for a person";
  const doneish = card.status === "done" || card.status === "executed" || card.status === "rejected";
  return (
    <a className={`card kind-${card.kind}${doneish ? " is-done" : ""}`} href={card.href}>
      <div className="card-top">
        <span className={`chip kind-${card.kind}`}>{KIND_LABEL[card.kind]}</span>
        {card.dueAt && card.dueState && (
          <span className={`due ${card.dueState}`}>
            <Icon name="clock" size={12} />
            {dueText(card.dueAt, card.dueState === "overdue")}
          </span>
        )}
        {card.kind === "email" && <span className="card-age">{ago(card.at)}</span>}
      </div>
      <div className="card-title">{card.title}</div>
      {card.detail && <div className="card-detail">{card.detail}</div>}
      <div className="card-meta">
        {card.evidenceLabel && (
          <span className="meta-item" title="Open the evidence">
            <Icon name={card.evidenceLabel.startsWith("PDF") ? "file" : "mail"} size={12} />
            {card.evidenceLabel}
          </span>
        )}
        {card.review && (
          <span
            className={`meta-item review ${card.review.verdict}`}
            title={`${card.review.verdict === "revise" ? "Revised" : "Checked"} by ${card.review.model ?? "review model"}; drafted by ${card.producedBy ?? "?"}`}
          >
            <Icon name="shield" size={12} />
            {card.review.verdict === "revise" ? "Revised" : "Reviewed"} · {modelShort(card.review.model)}
          </span>
        )}
        {stage && (
          <span className={`meta-item ${waiting ? "waiting" : "processing"}`}>
            {!waiting && <span className="pulse" />}
            {stage}
          </span>
        )}
        {failed && <span className="meta-item failed">{card.status}</span>}
        {doneish && card.status !== "done" && <span className="meta-item">{card.status === "executed" ? "Draft created" : card.status}</span>}
      </div>
    </a>
  );
}

function LaneHeader({ lane, triage }: { lane: Lane; triage?: boolean }) {
  const s = lane.stats;
  return (
    <summary className="lane-head">
      <Icon name="chevron" size={14} className="lane-caret" />
      {triage ? <Icon name="inbox" size={15} /> : null}
      <span className="lane-name">{lane.name}</span>
      {!triage && <HealthPill health={lane.health} />}
      <span className="lane-stats">
        {triage ? (
          <span>{s.open} unfiled</span>
        ) : (
          <>
            <span>{s.open} open</span>
            {s.overdue > 0 && <span className="stat bad">{s.overdue} overdue</span>}
            {s.dueSoon > 0 && <span className="stat warn">{s.dueSoon} due soon</span>}
            {s.approvals > 0 && <span className="stat accent">{s.approvals} to approve</span>}
            {s.blockedByReview > 0 && (
              <span className="stat shield" title="Claims the review model or a policy guard stopped before they reached this board">
                <Icon name="shield" size={12} />
                {s.blockedByReview} blocked by review
              </span>
            )}
          </>
        )}
      </span>
      <span className="spacer" />
      {lane.lastContactAt && <span className="muted lane-contact">Last contact {ago(lane.lastContactAt)}</span>}
    </summary>
  );
}

function LaneRow({ lane, triage }: { lane: Lane; triage?: boolean }) {
  return (
    <details className={`lane${triage ? " triage" : ""}`} open id={`lane-${lane.id}`}>
      <LaneHeader lane={lane} triage={triage} />
      {!triage && lane.summary && <p className="lane-summary">{lane.summary}</p>}
      <div className="lane-grid">
        {COLUMNS.map((col) => {
          const cards = lane.columns[col.id];
          return (
            <div className="cell" key={col.id} data-col={col.id}>
              {cards.map((c) => (
                <Card key={c.id} card={c} triage={triage} />
              ))}
              {col.id === "done" && lane.doneTotal > cards.length && (
                <div className="more">+{lane.doneTotal - cards.length} more</div>
              )}
              {cards.length === 0 && !triage && EMPTY_HINT[col.id] && <div className="empty">{EMPTY_HINT[col.id]}</div>}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function ClientSection({ group }: { group: ClientGroup }) {
  return (
    <section className="client" id={`client-${group.id}`}>
      <header className="client-head">
        <Avatar name={group.name} size={28} />
        <div>
          <div className="client-name">{group.name}</div>
          <div className="muted client-sub">
            {group.domains.join(", ")} · {group.lanes.length} project{group.lanes.length === 1 ? "" : "s"}
          </div>
        </div>
        <HealthPill health={group.health} />
      </header>
      {group.lanes.map((lane) => (
        <LaneRow key={lane.id} lane={lane} />
      ))}
    </section>
  );
}

const COLUMN_ICON: Record<ColumnId, IconName> = {
  triage: "inbox",
  on_us: "alert",
  on_client: "clock",
  approval: "spark",
  done: "check",
};

export function BoardView({ board }: { board: Board }) {
  const lanes = [...(board.triage ? [board.triage] : []), ...board.clients.flatMap((c) => c.lanes)];
  const count = (id: ColumnId) => lanes.reduce((n, l) => n + (id === "done" ? l.doneTotal : l.columns[id].length), 0);
  return (
    <div className="board" role="region" aria-label="Project board">
      <div className="board-inner">
        <div className="col-heads lane-grid">
          {COLUMNS.map((col) => (
            <div className={`col-head col-${col.id}`} key={col.id} title={col.hint}>
              <Icon name={COLUMN_ICON[col.id]} size={13} />
              <span>{col.title}</span>
              <span className="count">{count(col.id)}</span>
            </div>
          ))}
        </div>
        {board.triage && <LaneRow lane={board.triage} triage />}
        {board.clients.map((g) => (
          <ClientSection key={g.id} group={g} />
        ))}
        {board.clients.length === 0 && !board.triage && (
          <div className="board-empty">
            <p>No projects match this view.</p>
          </div>
        )}
      </div>
    </div>
  );
}
