import Link from "next/link";
import type { Board, BoardCard, CardKind, ClientGroup, ColumnId, Health, Lane } from "@/lib/board";
import { COLUMNS } from "@/lib/board";
import { ago, dueText, hue, initials, modelShort } from "../format";
import { POLICY_LABEL } from "@/lib/router/types";
import { Icon, type IconName } from "./Icon";
import { PolicyPill } from "./PolicyPill";
import { RouteTraceBadge } from "./RouteTraceBadge";

export const KIND_LABEL: Record<CardKind, string> = {
  email: "Email",
  ask: "Ask",
  our_commitment: "We owe",
  their_commitment: "They owe",
  deadline: "Deadline",
  decision: "Decision",
  risk: "Risk",
  draft_reply: "Draft staged",
  internal_task: "Task",
  new_project: "New project?",
};

const HEALTH_LABEL: Record<Health, string> = { on_track: "On track", at_risk: "At risk", blocked: "Blocked" };

const EMPTY_HINT: Partial<Record<ColumnId, string>> = {
  on_us: "Nothing owed",
  on_client: "Nothing pending",
  approval: "No drafts waiting",
};

/** Builds board URLs that keep the current filter while opening/closing the drawer. */
export type HrefFor = (open: string | null) => string;

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
    case "reasoning":
      return "Extracting signals";
    case "reasoned":
    case "reviewing":
      return "In model review";
    default:
      return status;
  }
}

/**
 * Chain of custody: "⚡ Haiku → 🛡 Sonnet · 0.96" (who drafted the claim, who verified it).
 * Cards are narrow, so they show model families; the tooltip and drawer carry full versions.
 */
export function Custody({ producer, review }: { producer: string | null; review: BoardCard["review"] }) {
  if (!review) return null;
  const family = (id: string | null) => modelShort(id).split(" ")[0];
  return (
    <span
      className={`custody ${review.verdict}`}
      title={`Drafted by ${modelShort(producer) || "?"} → ${review.verdict === "revise" ? "revised" : "verified"} by ${modelShort(review.model) || "review model"}`}
    >
      <Icon name="zap" size={11} className="producer" />
      <span className="producer">{family(producer)}</span>
      <span aria-hidden="true">→</span>
      <Icon name="shield" size={11} />
      {family(review.model)}
      {review.score != null && <span className="score">· {review.score.toFixed(2)}</span>}
    </span>
  );
}

function Card({ card, triage, hrefFor, selected }: { card: BoardCard; triage: boolean; hrefFor: HrefFor; selected: boolean }) {
  const failed = card.status?.startsWith("failed");
  const stage = card.kind === "email" && card.status && !failed ? emailStage(card.status, triage) : null;
  const waiting = stage === "Waiting for a person";
  const doneish = card.status === "done" || card.status === "executed" || card.status === "rejected";
  return (
    <Link
      className={`card kind-${card.kind}${doneish ? " is-done" : ""}${selected ? " selected" : ""}`}
      href={hrefFor(card.ref)}
      scroll={false}
    >
      <div className="card-top">
        {card.key && <span className="ticket">{card.key}</span>}
        <span className={`chip kind-${card.kind}`}>{KIND_LABEL[card.kind]}</span>
        {card.dueAt && card.dueState && (
          <span className={`due ${card.dueState}`}>
            <Icon name="clock" size={11} />
            {dueText(card.dueAt, card.dueState === "overdue")}
          </span>
        )}
        {card.kind === "email" && <span className="card-age">{ago(card.at)}</span>}
      </div>
      <div className="card-title">{card.title}</div>
      {card.detail && <div className="card-detail">{card.detail}</div>}
      <div className="trust-bar">
        {card.evidenceLabel && (
          <span className="evidence-chip" title="Open the evidence">
            <Icon name={card.evidenceKind === "pdf" ? "file" : card.evidenceKind === "image" ? "image" : "mail"} size={11} />
            {card.evidenceLabel}
          </span>
        )}
        <Custody producer={card.producedBy} review={card.review} />
        {card.route && <RouteTraceBadge route={card.route} />}
        {stage && (
          <span className={`meta-item ${waiting ? "waiting" : "processing"}`}>
            {!waiting && <span className="pulse" />}
            {stage}
          </span>
        )}
        {failed && <span className="meta-item failed">{card.status}</span>}
        {card.status === "proposed" && (card.kind === "draft_reply" || card.kind === "internal_task" || card.kind === "new_project") && (
          <span className="meta-item waiting">{card.kind === "new_project" ? "Choose a project" : "Awaiting your approval"}</span>
        )}
        {(card.status === "approved" || card.status === "edited") && (
          <span className="meta-item processing">
            <span className="pulse" />
            Approved · {card.kind === "draft_reply" ? "creating draft" : "adding task"}
          </span>
        )}
        {doneish && card.status !== "done" && (
          <span className="meta-item">{card.status === "executed" ? "Gmail draft created" : card.status}</span>
        )}
      </div>
    </Link>
  );
}

function LaneHeader({ lane, triage, hrefFor }: { lane: Lane; triage: boolean; hrefFor: HrefFor }) {
  const s = lane.stats;
  return (
    <summary className="lane-head">
      <Icon name="chevron" size={14} className="lane-caret" />
      {triage ? <Icon name="inbox" size={15} /> : null}
      <span className="lane-name">{lane.name}</span>
      {!triage && <HealthPill health={lane.health} />}
      {lane.routing && (
        <PolicyPill href={hrefFor(`tune:${lane.id}`)} label={POLICY_LABEL[lane.routing.policy]} inherited={lane.routing.inherited} />
      )}
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
                {s.blockedByReview} caught by review
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

function LaneRow({ lane, triage = false, hrefFor, selected }: { lane: Lane; triage?: boolean; hrefFor: HrefFor; selected: string | null }) {
  return (
    <details className={`lane${triage ? " triage" : ""}`} open id={`lane-${lane.id}`}>
      <LaneHeader lane={lane} triage={triage} hrefFor={hrefFor} />
      {!triage && lane.summary && <p className="lane-summary">{lane.summary}</p>}
      <div className="lane-grid">
        {COLUMNS.map((col) => {
          const cards = lane.columns[col.id];
          return (
            <div className="cell" key={col.id} data-col={col.id}>
              {cards.map((c) => (
                <Card key={c.id} card={c} triage={triage} hrefFor={hrefFor} selected={selected === c.ref} />
              ))}
              {col.id === "done" && lane.doneTotal > cards.length && <div className="more">+{lane.doneTotal - cards.length} more</div>}
              {cards.length === 0 && !triage && EMPTY_HINT[col.id] && <div className="empty">{EMPTY_HINT[col.id]}</div>}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function ClientSection({ group, hrefFor, selected }: { group: ClientGroup; hrefFor: HrefFor; selected: string | null }) {
  return (
    <section className="client" id={`client-${group.id}`}>
      <header className="client-head">
        <Avatar name={group.name} size={30} />
        <div>
          <div className="client-name">{group.name}</div>
          <div className="muted client-sub">
            {group.domains.join(", ")} · {group.lanes.length} project{group.lanes.length === 1 ? "" : "s"}
          </div>
        </div>
        <HealthPill health={group.health} />
      </header>
      {group.lanes.map((lane) => (
        <LaneRow key={lane.id} lane={lane} hrefFor={hrefFor} selected={selected} />
      ))}
    </section>
  );
}

const COLUMN_ICON: Record<ColumnId, IconName> = {
  triage: "inbox",
  on_us: "alert",
  on_client: "clock",
  approval: "mail",
  done: "check",
};

export function BoardView({ board, hrefFor, selected }: { board: Board; hrefFor: HrefFor; selected: string | null }) {
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
        {board.triage && <LaneRow lane={board.triage} triage hrefFor={hrefFor} selected={selected} />}
        {board.clients.map((g) => (
          <ClientSection key={g.id} group={g} hrefFor={hrefFor} selected={selected} />
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
