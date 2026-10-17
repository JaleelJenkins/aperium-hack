"use client";

import { useState, useTransition } from "react";
import { createRuleAction, deleteRuleAction, setRuleEnabledAction, updateRuleTextAction, type ActionResult } from "../actions";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";

type Kind = "instruction" | "block_phrase" | "block_domain";
type Scope = "global" | "client" | "project";
type Target = "all" | "signal" | "insight" | "action" | "draft_reply" | "internal_task";

const EXAMPLES: Record<Kind, string> = {
  instruction: "Never promise a delivery date in a reply unless the PM confirmed it in this thread.",
  block_phrase: "guaranteed",
  block_domain: "lumen-clinic-payments.com",
};

const HELP: Record<Kind, string> = {
  instruction: "Plain language. Reason is told to follow it; the review model blocks or revises anything that breaks it and names the rule.",
  block_phrase: "Checked in code after review: any item containing this phrase (any case) is blocked.",
  block_domain: "Checked in code after review: no draft or task may address this domain or its subdomains.",
};

function useRun() {
  const [pending, start] = useTransition();
  const [toast, show] = useToast(4500);
  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      show(r.message, r.ok ? "ok" : "bad");
      if (r.ok) after?.();
    });
  return { pending, toast, run };
}

export function NewRuleForm({
  clients,
  projects,
}: {
  clients: { id: string; name: string }[];
  projects: { id: string; name: string; clientId: string; clientName: string }[];
}) {
  const { pending, toast, run } = useRun();
  const [kind, setKind] = useState<Kind>("instruction");
  const [scope, setScope] = useState<Scope>("project");
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [appliesTo, setAppliesTo] = useState<Target>("all");
  const [onViolation, setOnViolation] = useState<"block" | "revise">("block");
  const [text, setText] = useState("");

  const submit = () =>
    run(
      () => createRuleAction({ kind, scope, clientId, projectId, appliesTo: kind === "block_domain" ? "action" : appliesTo, onViolation, text }),
      () => setText(""),
    );

  return (
    <div className="rule-form">
      <label>
        <span>Type</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="instruction">Instruction for the models</option>
          <option value="block_phrase">Block a phrase</option>
          <option value="block_domain">Block a recipient domain</option>
        </select>
      </label>
      <p className="muted rule-help">{HELP[kind]}</p>

      <label>
        <span>{kind === "instruction" ? "Rule" : kind === "block_phrase" ? "Phrase" : "Domain"}</span>
        {kind === "instruction" ? (
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={EXAMPLES[kind]} maxLength={600} />
        ) : (
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLES[kind]} spellCheck={false} />
        )}
      </label>

      <label>
        <span>Applies to</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="project">One project</option>
          <option value="client">Every project for a client</option>
          <option value="global">Every project</option>
        </select>
      </label>
      {scope === "project" && (
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.clientName} / {p.name}
            </option>
          ))}
        </select>
      )}
      {scope === "client" && (
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}

      {kind !== "block_domain" && (
        <label>
          <span>Check</span>
          <select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as Target)}>
            <option value="all">Everything</option>
            <option value="signal">Signals (asks, deadlines, decisions)</option>
            <option value="insight">Insights</option>
            <option value="action">All actions</option>
            <option value="draft_reply">Draft replies</option>
            <option value="internal_task">Internal tasks</option>
          </select>
        </label>
      )}
      {kind === "instruction" && (
        <label>
          <span>When broken</span>
          <select value={onViolation} onChange={(e) => setOnViolation(e.target.value as "block" | "revise")}>
            <option value="block">Block it (goes to Caught by review)</option>
            <option value="revise">Revise it (reviewer rewrites, you see both)</option>
          </select>
        </label>
      )}

      <button className="btn primary" onClick={submit} disabled={pending || text.trim().length < 3}>
        <Icon name="shield" size={13} />
        {pending ? "Saving…" : "Add rule"}
      </button>
      {toast}
    </div>
  );
}

export function RuleControls({ rule }: { rule: { id: string; text: string; enabled: boolean; kind: Kind } }) {
  const { pending, toast, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="rule-body">
      {editing ? (
        <div className="rule-form">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus maxLength={600} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost sm" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
            <span className="spacer" />
            <button className="btn primary sm" onClick={() => run(() => updateRuleTextAction(rule.id, text), () => setEditing(false))} disabled={pending}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className={rule.kind === "instruction" ? "" : "mono"}>{rule.kind === "block_domain" ? `@${rule.text}` : rule.text}</p>
      )}
      {!editing && (
        <div className="rule-actions">
          <label className="switch" title={rule.enabled ? "On: applied to new email" : "Off: kept but not applied"}>
            <input type="checkbox" checked={rule.enabled} disabled={pending} onChange={(e) => run(() => setRuleEnabledAction(rule.id, e.target.checked))} />
            <span>{rule.enabled ? "On" : "Off"}</span>
          </label>
          <button className="btn ghost sm" onClick={() => setEditing(true)} disabled={pending}>
            <Icon name="pencil" size={12} />
            Edit
          </button>
          {confirm ? (
            <button className="btn danger sm" onClick={() => run(() => deleteRuleAction(rule.id))} disabled={pending}>
              Confirm delete
            </button>
          ) : (
            <button className="btn ghost sm" onClick={() => setConfirm(true)} disabled={pending}>
              <Icon name="x" size={12} />
              Delete
            </button>
          )}
        </div>
      )}
      {toast}
    </div>
  );
}
