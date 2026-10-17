"use client";

import { useState, useTransition } from "react";
import type { ApprovalInfo } from "@/lib/inspect";
import {
  approveActionAction,
  decideNewProjectAction,
  editAndApproveActionAction,
  rejectActionAction,
  retryActionAction,
  type ActionResult,
} from "../actions";
import { ago } from "../format";
import { Icon } from "./Icon";
import { useToast } from "./Toast";

type Mode = "idle" | "edit" | "reject";
type RuleScope = "project" | "client" | "global";

/**
 * The human-review step for one action (PRD F5). Approve, edit-and-approve, or reject
 * with a reason; a rejection can be saved as a team review rule so the same mistake is
 * caught automatically next time.
 */
export function ApprovalPanel({ a }: { a: ApprovalInfo }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [pending, start] = useTransition();
  const [toast, show] = useToast(5000);

  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      show(r.message, r.ok ? "ok" : "bad");
      if (r.ok) {
        setMode("idle");
        after?.();
      }
    });

  if (a.type === "new_project") return <NewProjectPanel a={a} pending={pending} run={run} toast={toast} />;

  if (a.status !== "proposed") return <Decided a={a} pending={pending} run={run} toast={toast} />;

  return (
    <div className="approve-panel">
      {mode === "idle" && (
        <>
          <div className="approve-q">
            <Icon name="shield" size={13} />
            {a.type === "draft_reply" ? "Approve this reply? It becomes a Gmail draft in the thread; nothing is sent." : "Approve this task? It's added to Waiting on us."}
          </div>
          <div className="approve-buttons">
            <button className="btn primary" disabled={pending} onClick={() => run(() => approveActionAction(a.actionId))}>
              <Icon name="check" size={14} />
              {pending ? "Approving…" : "Approve"}
            </button>
            <button className="btn" disabled={pending} onClick={() => setMode("edit")}>
              <Icon name="pencil" size={13} />
              Edit
            </button>
            <button className="btn ghost danger" disabled={pending} onClick={() => setMode("reject")}>
              <Icon name="x" size={13} />
              Reject
            </button>
          </div>
        </>
      )}
      {mode === "edit" && <EditForm a={a} pending={pending} run={run} cancel={() => setMode("idle")} />}
      {mode === "reject" && <RejectForm a={a} pending={pending} run={run} cancel={() => setMode("idle")} />}
      {toast}
    </div>
  );
}

type Run = (fn: () => Promise<ActionResult>, after?: () => void) => void;

function EditForm({ a, pending, run, cancel }: { a: ApprovalInfo; pending: boolean; run: Run; cancel: () => void }) {
  const p = a.payload;
  const [to, setTo] = useState((p.to ?? []).join(", "));
  const [subject, setSubject] = useState(p.subject ?? "");
  const [body, setBody] = useState(p.body ?? "");
  const [title, setTitle] = useState(p.title ?? "");
  const [notes, setNotes] = useState(p.notes ?? "");
  const draft = a.type === "draft_reply";
  const save = () =>
    run(() =>
      editAndApproveActionAction(
        a.actionId,
        draft ? { to: to.split(/[,;\s]+/).filter(Boolean), subject, body } : { title, notes },
      ),
    );
  return (
    <div className="approve-form">
      {draft ? (
        <>
          <label>
            <span>To</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
          </label>
          <label>
            <span>Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            <span>Body</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} autoFocus />
          </label>
        </>
      ) : (
        <>
          <label>
            <span>Task</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <label>
            <span>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
          </label>
        </>
      )}
      <div className="approve-buttons">
        <button className="btn ghost" onClick={cancel} disabled={pending}>
          Cancel
        </button>
        <span className="spacer" />
        <button className="btn primary" onClick={save} disabled={pending}>
          <Icon name="check" size={14} />
          {pending ? "Saving…" : "Save & approve"}
        </button>
      </div>
      <div className="muted approve-hint">Recipients must be known contacts on this thread. The model&apos;s version is kept for the audit.</div>
    </div>
  );
}

function RejectForm({ a, pending, run, cancel }: { a: ApprovalInfo; pending: boolean; run: Run; cancel: () => void }) {
  const [reason, setReason] = useState("");
  const [asRule, setAsRule] = useState(false);
  const [scope, setScope] = useState<RuleScope>("project");
  const [ruleText, setRuleText] = useState("");
  const kind = a.type === "draft_reply" ? "draft replies" : "internal tasks";
  const submit = () =>
    run(() => rejectActionAction(a.actionId, reason, asRule ? { scope, text: ruleText.trim() || undefined } : null));
  return (
    <div className="approve-form">
      <label>
        <span>Why reject it?</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          autoFocus
          placeholder="e.g. Don't commit to dates in replies; I confirm dates on a call."
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={asRule} onChange={(e) => setAsRule(e.target.checked)} />
        <span>
          Save as a review rule, so future {kind} are held to it
        </span>
      </label>
      {asRule && (
        <div className="rule-from-reject">
          <label>
            <span>Applies to</span>
            <select value={scope} onChange={(e) => setScope(e.target.value as RuleScope)}>
              <option value="project">This project{a.projectName ? ` (${a.projectName})` : ""}</option>
              <option value="client">All {a.clientName ?? "this client"}&apos;s projects</option>
              <option value="global">Every project</option>
            </select>
          </label>
          <label>
            <span>Rule wording (optional)</span>
            <input value={ruleText} onChange={(e) => setRuleText(e.target.value)} placeholder="Defaults to your reason" />
          </label>
        </div>
      )}
      <div className="approve-buttons">
        <button className="btn ghost" onClick={cancel} disabled={pending}>
          Cancel
        </button>
        <span className="spacer" />
        <button className="btn danger" onClick={submit} disabled={pending || reason.trim().length < 5}>
          <Icon name="x" size={13} />
          {pending ? "Rejecting…" : asRule ? "Reject & save rule" : "Reject"}
        </button>
      </div>
    </div>
  );
}

function Decided({ a, pending, run, toast }: { a: ApprovalInfo; pending: boolean; run: Run; toast: React.ReactNode }) {
  const when = a.decidedAt ? ago(a.decidedAt) : "";
  let body: React.ReactNode;
  if (a.status === "approved" || a.status === "edited") {
    body = (
      <>
        <span className="verdict pass">{a.status === "edited" ? "Edited & approved" : "Approved"}</span>
        <span>
          {when} · {a.type === "draft_reply" ? "creating the Gmail draft…" : "adding to Waiting on us…"}
        </span>
      </>
    );
  } else if (a.status === "executed") {
    body = (
      <>
        <span className="verdict pass">{a.type === "draft_reply" ? "Draft in Gmail" : "Task added"}</span>
        <span>{when}</span>
        {a.type === "draft_reply" && (
          <a className="btn sm" href={a.gmailDraftUrl ?? "https://mail.google.com/mail/u/0/#drafts"} target="_blank" rel="noreferrer">
            <Icon name="external" size={12} />
            Open draft in Gmail
          </a>
        )}
      </>
    );
  } else if (a.status === "rejected") {
    body = (
      <>
        <span className="verdict block">Rejected</span>
        <span>
          {when}
          {a.decisionReason ? ` · “${a.decisionReason}”` : ""}
        </span>
      </>
    );
  } else if (a.status === "failed") {
    body = (
      <>
        <span className="verdict block">Failed</span>
        <span className="bad-text" style={{ fontWeight: 500 }}>
          {a.error}
        </span>
        <button className="btn sm" disabled={pending} onClick={() => run(() => retryActionAction(a.actionId))}>
          <Icon name="refresh" size={12} />
          {pending ? "Retrying…" : "Retry"}
        </button>
      </>
    );
  } else {
    body = <span className="mono">{a.status}</span>;
  }
  return (
    <div className="approve-panel">
      <div className="approve-status">{body}</div>
      {toast}
    </div>
  );
}

function NewProjectPanel({ a, pending, run, toast }: { a: ApprovalInfo; pending: boolean; run: Run; toast: React.ReactNode }) {
  const np = a.newProject!;
  const [projectId, setProjectId] = useState(np.closestProjectId ?? np.projects[0]?.id ?? "");
  const [name, setName] = useState(np.suggestedName);
  const [mode, setMode] = useState<"idle" | "dismiss">("idle");
  const [reason, setReason] = useState("");
  if (a.status !== "proposed") return <Decided a={a} pending={pending} run={run} toast={toast} />;
  return (
    <div className="approve-panel">
      {mode === "idle" ? (
        <div className="approve-form">
          <div className="approve-q">
            <Icon name="folder" size={13} />
            Where does this thread belong{np.clientName ? ` at ${np.clientName}` : ""}?
          </div>
          {np.projects.length > 0 && (
            <div className="np-row">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Existing project">
                {np.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.id === np.closestProjectId ? " (closest match)" : ""}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={pending || !projectId} onClick={() => run(() => decideNewProjectAction(a.actionId, { kind: "file", projectId }))}>
                <Icon name="check" size={14} />
                File here
              </button>
            </div>
          )}
          {np.clientId && (
            <div className="np-row">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" aria-label="New project name" />
              <button className="btn" disabled={pending || name.trim().length < 3} onClick={() => run(() => decideNewProjectAction(a.actionId, { kind: "create", name }))}>
                <Icon name="spark" size={13} />
                Create project
              </button>
            </div>
          )}
          <button className="btn ghost danger sm np-dismiss" disabled={pending} onClick={() => setMode("dismiss")}>
            Not client work
          </button>
        </div>
      ) : (
        <div className="approve-form">
          <label>
            <span>Why dismiss it?</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} autoFocus placeholder="e.g. Vendor newsletter, not a client request" />
          </label>
          <div className="approve-buttons">
            <button className="btn ghost" onClick={() => setMode("idle")} disabled={pending}>
              Cancel
            </button>
            <span className="spacer" />
            <button className="btn danger" disabled={pending || reason.trim().length < 5} onClick={() => run(() => rejectActionAction(a.actionId, reason, null))}>
              Dismiss thread
            </button>
          </div>
        </div>
      )}
      {toast}
    </div>
  );
}
