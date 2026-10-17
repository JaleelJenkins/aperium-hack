/**
 * Human review (PRD F5): the approval queue's decisions. A person approves, edits
 * or rejects every proposed action; nothing goes out without one of these.
 *
 *   proposed -> approved | edited -> executed | failed     (executor: lib/pipeline/execute.ts)
 *   proposed -> rejected                                    (reason required)
 *
 * Rejecting with "save as rule" writes the reason into the team's review rules, so
 * the same mistake is caught automatically on every future email (lib/rules.ts).
 * "New project?" cards are decided here too: file to a project, create one, or dismiss.
 */
import { audit, type DB } from "./db";
import { knownContactsFor } from "./pipeline/reason";
import { createRule, hardRuleViolation, rulesForProject, type Rule, type RuleScope } from "./rules";

export interface ActionRow {
  id: string;
  project_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  type: "draft_reply" | "internal_task" | "new_project";
  payload_json: string;
  status: string;
  original_payload_json: string | null;
}

const OPEN = new Set(["proposed"]);

function load(db: DB, id: string): ActionRow {
  const a = db.prepare(`SELECT id, project_id, thread_id, message_id, type, payload_json, status, original_payload_json FROM actions WHERE id = ?`).get(id) as
    | ActionRow
    | undefined;
  if (!a) throw new Error("That action no longer exists.");
  return a;
}

function requireOpen(a: ActionRow) {
  if (!OPEN.has(a.status)) throw new Error(`Already decided (${a.status}).`);
}

const now = () => new Date().toISOString();

// ------------------------------------------------------------------ approve / edit / reject

export function approveAction(db: DB, id: string, actor = "user"): void {
  const a = load(db, id);
  if (a.type === "new_project") throw new Error("Choose where to file this thread: pick a project or create one.");
  requireOpen(a);
  checkSendable(db, a, JSON.parse(a.payload_json));
  db.prepare(`UPDATE actions SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`).run(actor, now(), id);
  audit(db, actor, "action.approved", `action:${id}`, { type: a.type });
}

export interface ActionEdit {
  to?: string[];
  subject?: string;
  body?: string;
  title?: string;
  notes?: string;
}

/** Saves a person's changes and approves the result (status "edited"). Model's version is kept. */
export function editAndApproveAction(db: DB, id: string, edit: ActionEdit, actor = "user"): void {
  const a = load(db, id);
  if (a.type === "new_project") throw new Error("New project cards aren't editable.");
  requireOpen(a);
  const before = JSON.parse(a.payload_json) as Record<string, unknown>;
  let after: Record<string, unknown>;
  if (a.type === "draft_reply") {
    const to = (edit.to ?? (before.to as string[]) ?? []).map((e) => e.trim()).filter(Boolean);
    const body = (edit.body ?? (before.body as string) ?? "").trim();
    if (!to.length) throw new Error("A reply needs at least one recipient.");
    if (to.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error("One of the recipients isn't an email address.");
    if (!body) throw new Error("The reply body is empty.");
    after = { to, subject: (edit.subject ?? (before.subject as string) ?? "").trim(), body };
  } else {
    const title = (edit.title ?? (before.title as string) ?? "").trim();
    if (!title) throw new Error("A task needs a title.");
    after = { title, notes: (edit.notes ?? (before.notes as string) ?? "").trim() };
  }
  checkSendable(db, a, after);
  if (JSON.stringify(after) === JSON.stringify(before)) {
    // Nothing changed: it's a plain approval, and the audit shouldn't claim an edit.
    db.prepare(`UPDATE actions SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`).run(actor, now(), id);
    audit(db, actor, "action.approved", `action:${id}`, { type: a.type });
    return;
  }
  db.prepare(
    `UPDATE actions SET payload_json = ?, original_payload_json = COALESCE(original_payload_json, ?), status = 'edited',
            decided_by = ?, decided_at = ? WHERE id = ?`,
  ).run(JSON.stringify(after), a.payload_json, actor, now(), id);
  audit(db, actor, "action.edited", `action:${id}`, { before, after });
}

export interface SaveAsRule {
  scope: RuleScope;
  /** Defaults to the rejection reason. */
  text?: string;
  /** Defaults to this action's type. */
  appliesTo?: "all" | "action" | "draft_reply" | "internal_task";
}

/** Rejects with a reason; optionally turns the reason into a review rule. Returns the new rule, if any. */
export function rejectAction(db: DB, id: string, reason: string, actor = "user", saveAsRule?: SaveAsRule): Rule | null {
  const a = load(db, id);
  requireOpen(a);
  const why = reason.replace(/\s+/g, " ").trim();
  if (why.length < 5) throw new Error("Say why you're rejecting it (a few words). It's logged, and can become a rule.");
  let rule: Rule | null = null;
  db.transaction(() => {
    db.prepare(`UPDATE actions SET status = 'rejected', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?`).run(actor, now(), why, id);
    if (a.type === "new_project" && a.thread_id) {
      // Not client work: stop it waiting in triage, and stop Resolve raising the card again.
      db.prepare(`UPDATE messages SET status = 'dismissed' WHERE thread_id = ? AND status IN ('ingested', 'extracted', 'resolved')`).run(a.thread_id);
    }
    audit(db, actor, "action.rejected", `action:${id}`, { type: a.type, reason: why });
    if (saveAsRule && a.type !== "new_project") {
      const client = a.project_id
        ? (db.prepare(`SELECT client_id FROM projects WHERE id = ?`).get(a.project_id) as { client_id: string } | undefined)?.client_id
        : null;
      rule = createRule(db, {
        scope: saveAsRule.scope,
        projectId: a.project_id,
        clientId: client ?? null,
        appliesTo: saveAsRule.appliesTo ?? a.type,
        kind: "instruction",
        text: saveAsRule.text?.trim() || why,
        source: "rejection",
        sourceRef: id,
        createdBy: actor,
      });
    }
  })();
  return rule;
}

/**
 * Guard used at approval, edit and again at execution: a draft may only go to known
 * contacts on its thread, and nothing may break a code rule (block_phrase / block_domain).
 */
export function checkSendable(db: DB, a: Pick<ActionRow, "type" | "thread_id" | "project_id">, payload: Record<string, unknown>): void {
  const clientId = a.project_id
    ? ((db.prepare(`SELECT client_id FROM projects WHERE id = ?`).get(a.project_id) as { client_id: string } | undefined)?.client_id ?? null)
    : null;
  if (a.type === "draft_reply") {
    if (!a.thread_id) throw new Error("This draft isn't attached to a thread.");
    const known = new Set(knownContactsFor(db, a.thread_id, clientId));
    const unknown = ((payload.to as string[]) ?? []).map((e) => e.toLowerCase()).filter((e) => !known.has(e));
    if (unknown.length) throw new Error(`${unknown.join(", ")} isn't a known contact on this thread. Add them as a client contact first.`);
  }
  if (a.project_id) {
    const text = a.type === "draft_reply" ? `${payload.subject ?? ""}\n${payload.body ?? ""}` : `${payload.title ?? ""}\n${payload.notes ?? ""}`;
    const hit = hardRuleViolation(rulesForProject(db, a.project_id), "action", a.type, text, (payload.to as string[]) ?? []);
    if (hit) throw new Error(`Blocked by rule ${hit.notes}`);
  }
}

// ------------------------------------------------------------------ "New project?" cards

export type NewProjectDecision = { kind: "file"; projectId: string } | { kind: "create"; name: string; summary?: string };

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project";
}

/** Files the card's thread to an existing project or a new one. Resolve then picks the mail up. */
export function decideNewProject(db: DB, actionId: string, d: NewProjectDecision, actor = "user"): { projectId: string } {
  const a = load(db, actionId);
  if (a.type !== "new_project") throw new Error("Not a New project? card.");
  requireOpen(a);
  if (!a.thread_id) throw new Error("This card has no thread.");
  const payload = JSON.parse(a.payload_json) as { client_id?: string | null; suggested_name?: string; reason?: string };
  let projectId: string;
  db.transaction(() => {
    if (d.kind === "file") {
      const p = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(d.projectId) as { id: string } | undefined;
      if (!p) throw new Error("Pick a project.");
      projectId = p.id;
    } else {
      const name = d.name.replace(/\s+/g, " ").trim();
      if (name.length < 3) throw new Error("Give the new project a name.");
      if (!payload.client_id) throw new Error("The sender isn't a known client, so there's no client to create the project under. Add the client first.");
      let id = `${payload.client_id.split("-")[0]}-${slug(name)}`;
      for (let n = 2; db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
      const subject = (db.prepare(`SELECT subject FROM threads WHERE gmail_thread_id = ?`).get(a.thread_id) as { subject: string | null } | undefined)?.subject;
      const summary = (d.summary?.trim() || `${name}. Opened from the thread “${subject ?? "(no subject)"}”. Edit this summary so new mail files here.`).slice(0, 1200);
      db.prepare(`INSERT INTO projects (id, client_id, name, summary, health, status) VALUES (?, ?, ?, ?, 'on_track', 'active')`).run(id, payload.client_id, name, summary);
      audit(db, actor, "project.created", `project:${id}`, { name, from_action: actionId });
      projectId = id;
    }
    db.prepare(
      `UPDATE threads SET project_id = ?, assignment_confidence = 1, assigned_by = 'human', assignment_reason = ? WHERE gmail_thread_id = ?`,
    ).run(projectId, d.kind === "file" ? "Filed by a person from the New project? card" : "New project created by a person from the New project? card", a.thread_id);
    db.prepare(`UPDATE actions SET status = 'executed', project_id = ?, decided_by = ?, decided_at = ? WHERE id = ?`).run(projectId, actor, now(), actionId);
    audit(db, actor, "action.approved", `action:${actionId}`, { type: "new_project", decision: d.kind, project: projectId });
  })();
  return { projectId: projectId! };
}
