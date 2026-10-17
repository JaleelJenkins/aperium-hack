import Link from "next/link";
import type { CaughtClaim, Inspection, ModelNotes, SourceView } from "@/lib/inspect";
import type { RouteTrace } from "@/lib/board";
import { POLICY_LABEL } from "@/lib/router/types";
import { ago, dueText, modelShort, secs, usd } from "../format";
import { ApprovalPanel } from "./ApprovalPanel";
import { KIND_LABEL, type HrefFor } from "./Board";
import { DrawerKeys } from "./DrawerKeys";
import { Icon } from "./Icon";

export function Shell({
  title,
  vault,
  closeHref,
  children,
  foot,
}: {
  title: React.ReactNode;
  vault?: boolean;
  closeHref: string;
  children: React.ReactNode;
  foot?: React.ReactNode;
}) {
  return (
    <>
      <DrawerKeys closeHref={closeHref} />
      <Link className="drawer-scrim" href={closeHref} scroll={false} aria-label="Close panel" />
      <aside className="drawer" aria-label="Evidence inspector">
        <div className={`drawer-head${vault ? " vault" : ""}`}>
          {title}
          <Link className="drawer-close" href={closeHref} scroll={false} aria-label="Close (Esc)">
            <Icon name="x" size={16} />
          </Link>
        </div>
        <div className="drawer-body">{children}</div>
        {foot && <div className="drawer-foot">{foot}</div>}
      </aside>
    </>
  );
}

export function Source({ src }: { src: SourceView }) {
  return (
    <div className="source-card">
      <div className="source-meta">
        {src.sender ? (
          <span>
            {src.sender}
            {src.sentAt && <span className="muted"> · {ago(src.sentAt)}</span>}
          </span>
        ) : (
          <span>Attachment</span>
        )}
        {src.link.label && (
          <a className="evidence-chip" href={src.link.href} target={src.fileUrl ? "_blank" : undefined}>
            <Icon name={src.link.kind === "pdf" ? "file" : src.link.kind === "image" ? "image" : "mail"} size={11} />
            {src.link.label}
          </a>
        )}
      </div>
      {src.lines.length > 0 && (
        <div className="source-lines">
          {src.lines.map((l) => (
            <div className={`sl${l.hit ? " hit" : ""}`} key={l.n}>
              <span className="n">{l.n}</span>
              <span className="t">{l.text || " "}</span>
            </div>
          ))}
        </div>
      )}
      {src.fileUrl && src.link.kind === "pdf" && (
        // Fit the cited page to the drawer width and hide the viewer chrome (Chrome/Edge PDF viewer params).
        <iframe
          className="source-pdf"
          src={`${src.fileUrl}${src.fileUrl.includes("#") ? "&" : "#"}view=FitH&toolbar=0&navpanes=0`}
          title={src.link.label ?? "PDF"}
        />
      )}
      {src.fileUrl && src.link.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src.fileUrl} alt={src.link.label ?? "image evidence"} style={{ width: "100%", display: "block" }} />
      )}
      {src.fileUrl && src.quote && (
        <div className="source-meta" style={{ borderTop: "1px solid var(--line)", borderBottom: 0 }}>
          <span>
            Quoted: <mark style={{ background: "var(--hl)" }}>{src.quote}</mark>
          </span>
        </div>
      )}
    </div>
  );
}

/** What a person changed before approving, against the model's version. */
function EditedNote({ a }: { a: NonNullable<Inspection["approval"]> }) {
  const o = a.original!;
  const p = a.payload;
  const changed = (["to", "subject", "body", "title", "notes"] as const).filter((k) => JSON.stringify(o[k] ?? "") !== JSON.stringify(p[k] ?? ""));
  if (!changed.length) return null;
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 6, display: "grid", gap: 4 }}>
      <span>Edited by a person before approval. The model proposed:</span>
      {changed.map((k) => (
        <span key={k}>
          <span className="mono">{k}</span>: <span className="claim-struck">{Array.isArray(o[k]) ? (o[k] as string[]).join(", ") : (o[k] as string) || "(empty)"}</span>
        </span>
      ))}
    </div>
  );
}

const VERDICT_LABEL: Record<string, string> = { pass: "Verified", revise: "Revised", block: "Blocked" };

/** Which Reason → Review pair the router picked for this email, and why. */
export function RoutingDecision({ route }: { route: RouteTrace }) {
  return (
    <div>
      <div className="d-section-label">
        <Icon name="refresh" size={12} />
        Routing decision
      </div>
      <div className="route-decision">
        <span className="k">Pair</span>
        <span className="v">{route.pairLabel}</span>
        <span className="k">Policy</span>
        <span className="v">{POLICY_LABEL[route.policy] ?? route.policy}</span>
        <span className="k">Escalated</span>
        <span className="v">{route.escalated ? route.triggers.join("; ") || "yes" : "no"}</span>
        <span className="k">Why</span>
        <span className="v">{route.reason}</span>
        <span className="k">Estimate</span>
        <span className="v">
          {usd(route.estCostUsd)} / email · {secs(route.estLatencyMs)}
          {route.illustrative ? " (illustrative)" : ""}
        </span>
        <span className="k">Source</span>
        <span className="v">{route.recorded ? "Recorded when the email was processed" : "Live, under current routing policy"}</span>
      </div>
    </div>
  );
}

/** Each model's own note for this email, in scrollable boxes. */
export function ModelReasoning({ notes }: { notes: ModelNotes }) {
  const box = (label: string, model: string | null, text: string | null) => (
    <div className="reasoning-box">
      <div className="reasoning-who">
        {label} · {model ? modelShort(model) : "none"}
      </div>
      <div className="reasoning-text" tabIndex={0}>
        {text ?? <span className="muted">No reasoning recorded for this run.</span>}
      </div>
    </div>
  );
  return (
    <div>
      <div className="d-section-label">
        <Icon name="zap" size={12} />
        Model reasoning
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {box("Reason", notes.reasonModel, notes.reasonNote)}
        {notes.reviewModel && box("Review", notes.reviewModel, notes.reviewNote)}
      </div>
    </div>
  );
}

export function InspectorDrawer({ item, hrefFor }: { item: Inspection; hrefFor: HrefFor }) {
  const closeHref = hrefFor(null);
  const a = item.audit;
  return (
    <Shell
      closeHref={closeHref}
      title={
        <>
          <Icon name="eye" size={14} />
          Evidence inspector
        </>
      }
      foot={
        item.approval ? (
          <ApprovalPanel key={item.approval.actionId} a={item.approval} />
        ) : (
          item.messageHref && (
            <a className="btn" href={item.messageHref}>
              <Icon name="external" size={13} />
              Open full message
            </a>
          )
        )
      }
    >
      <div>
        <div className="row" style={{ gap: 8 }}>
          {item.key && <span className="ticket">{item.key}</span>}
          <span className={`chip kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
          {item.dueAt && <span className="due">{dueText(item.dueAt, Date.parse(item.dueAt) < Date.now())}</span>}
        </div>
        <div className="drawer-title">{item.title}</div>
        <div className="drawer-sub">
          {item.project ? `${item.project.clientName} / ${item.project.name}` : "Not filed to a project yet"} · status{" "}
          <span className="mono">{item.status}</span>
        </div>
      </div>

      {item.draft && (
        <div>
          <div className="d-section-label">
            <Icon name="mail" size={12} />
            {item.kind === "draft_reply" ? "Staged reply" : "Proposed task"}
          </div>
          <div className="draft-preview">
            {item.draft.to.length > 0 && <div className="to">To {item.draft.to.join(", ")}</div>}
            {item.draft.body || item.draft.subject}
          </div>
          {item.approval?.original && <EditedNote a={item.approval} />}
          {item.kind === "draft_reply" && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Approving creates a Gmail draft in this thread (<span className="mono">drafts.create</span>). Nothing is sent.
              {item.messageHref && (
                <>
                  {" "}
                  <a href={item.messageHref}>Open the full message</a>.
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div>
        <div className="d-section-label">
          <Icon name="file" size={12} />
          {item.kind === "email" ? "Message" : "Evidence"}
        </div>
        {item.sources.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {item.sources.map((s, i) => (
              <Source key={i} src={s} />
            ))}
          </div>
        ) : (
          <p className="muted">No evidence attached.</p>
        )}
      </div>

      {item.routing && <RoutingDecision route={item.routing} />}
      {item.reasoning && <ModelReasoning notes={item.reasoning} />}

      {a && (
        <div>
          <div className="d-section-label">
            <Icon name="shield" size={12} />
            Model review audit
          </div>
          <div className="audit">
            <div className="audit-step">
              <span className="ico">
                <Icon name="zap" size={12} />
              </span>
              <div className="audit-who">Reason · {modelShort(a.producer)}</div>
              <div className="audit-what">“{a.claim}”</div>
            </div>
            <div className="audit-step review">
              <span className="ico">
                <Icon name="shield" size={12} />
              </span>
              <div className="audit-who">
                Review · {a.reviewer ? modelShort(a.reviewer) : "pending"}
                {a.verdict && <span className={`verdict ${a.verdict}`}>{VERDICT_LABEL[a.verdict] ?? a.verdict}</span>}
                {a.score != null && <span>confidence {a.score.toFixed(2)}</span>}
              </div>
              <div className="audit-what">
                {a.reason ??
                  (a.verdict === "pass"
                    ? "Quote checked against the source; nothing in the message contradicts it."
                    : a.verdict === "revise"
                      ? "Reviewer corrected the wording before it was shown."
                      : "Not reviewed yet.")}
                {a.originalText && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    Reason originally wrote: <span className="claim-struck">{a.originalText}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

const BLOCKED_BY: Record<string, string> = { review: "review model", verify: "evidence check", policy: "policy guard" };

export function CaughtDrawer({ claims, hrefFor }: { claims: CaughtClaim[]; hrefFor: HrefFor }) {
  return (
    <Shell
      vault
      closeHref={hrefFor(null)}
      title={
        <>
          <Icon name="shield" size={14} />
          Caught by review · {claims.length}
        </>
      }
    >
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Claims the Reason model made that never reached the board. Each was stopped by a second model, the
        deterministic evidence check, or a policy guard, with the reason logged.
      </p>
      {claims.map((c) => (
        <ClaimDiff key={c.id} c={c} />
      ))}
      {claims.length === 0 && <p className="muted">Nothing blocked yet.</p>}
    </Shell>
  );
}

/** One blocked claim: Reason's claim (struck) vs the review verdict, with the contradicting evidence. */
export function ClaimDiff({ c }: { c: CaughtClaim }) {
  return (
    <div className="diff">
      <div className="diff-head trap-quarantine-banner">
        <strong>{c.project ? `${c.project.clientName} / ${c.project.name}` : "Unfiled"}</strong>
        <span className="spacer" />
        <span className="mono" style={{ fontSize: 11 }}>
          {ago(c.at)}
        </span>
      </div>
      <div className="diff-cols">
        <div className="diff-col">
          <div className="diff-label">
            <Icon name="zap" size={11} />
            Reason · {modelShort(c.producer)}
          </div>
          <div className="claim-struck">{c.claim}</div>
        </div>
        <div className="diff-col">
          <div className="diff-label">
            <Icon name="shield" size={11} />
            {c.reviewer ? `Review · ${modelShort(c.reviewer)}` : BLOCKED_BY[c.blockedBy ?? "review"]}
            <span className="verdict block">Blocked</span>
            {c.rule && (
              <a className="rule-chip" href={`/rules#rule-${c.rule.code}`} title={c.rule.text}>
                Rule {c.rule.code}
              </a>
            )}
          </div>
          <div>{c.notes}</div>
        </div>
      </div>
      {(c.conflicting.length > 0 || c.source) && (
        <div style={{ padding: 10, borderTop: "1px solid var(--status-block-border)", display: "flex", flexDirection: "column", gap: 8 }}>
          {c.conflicting.length > 0 ? c.conflicting.map((s, i) => <Source key={i} src={s} />) : c.source && <Source src={c.source} />}
        </div>
      )}
    </div>
  );
}
