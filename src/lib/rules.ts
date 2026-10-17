/**
 * Review rules: the approval review step. The team writes a rule once and every
 * future email on that scope is held to it, so the PM tunes how the models reason
 * without touching prompts or code.
 *
 *   instruction   plain-language rule. Reason is told to follow it; Review enforces it
 *                 and names the rule it applied (block or revise, per the rule).
 *   block_phrase  code check after Review: any item containing the phrase is blocked.
 *   block_domain  code check after Review: no draft or task may address that domain.
 *
 * Scopes stack: global rules apply everywhere, client rules to every project of that
 * client, project rules to one project. Rejecting a draft with a reason can save the
 * reason as a new rule (source = rejection), which is how feedback becomes tuning.
 */
import { randomUUID } from "node:crypto";
import { audit, type DB } from "./db";

export const RULE_KINDS = ["instruction", "block_phrase", "block_domain"] as const;
export const RULE_SCOPES = ["global", "client", "project"] as const;
export const RULE_TARGETS = ["all", "signal", "insight", "action", "draft_reply", "internal_task"] as const;

export type RuleKind = (typeof RULE_KINDS)[number];
export type RuleScope = (typeof RULE_SCOPES)[number];
export type RuleTarget = (typeof RULE_TARGETS)[number];

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  instruction: "Instruction (models follow and enforce)",
  block_phrase: "Block items containing a phrase",
  block_domain: "Block drafts/tasks to a domain",
};
export const RULE_TARGET_LABEL: Record<RuleTarget, string> = {
  all: "Everything",
  signal: "Signals",
  insight: "Insights",
  action: "All actions",
  draft_reply: "Draft replies",
  internal_task: "Internal tasks",
};

export interface Rule {
  id: string;
  code: string;
  scope: RuleScope;
  clientId: string | null;
  projectId: string | null;
  appliesTo: RuleTarget;
  kind: RuleKind;
  text: string;
  onViolation: "block" | "revise";
  enabled: boolean;
  source: "manual" | "rejection";
  sourceRef: string | null;
  createdBy: string;
  createdAt: string;
  hits: number;
  lastHitAt: string | null;
}

interface RuleRow {
  id: string;
  code: string;
  scope: RuleScope;
  client_id: string | null;
  project_id: string | null;
  applies_to: RuleTarget;
  kind: RuleKind;
  text: string;
  on_violation: "block" | "revise";
  enabled: number;
  source: "manual" | "rejection";
  source_ref: string | null;
  created_by: string;
  created_at: string;
  hits: number;
  last_hit_at: string | null;
}

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  code: r.code,
  scope: r.scope,
  clientId: r.client_id,
  projectId: r.project_id,
  appliesTo: r.applies_to,
  kind: r.kind,
  text: r.text,
  onViolation: r.on_violation,
  enabled: !!r.enabled,
  source: r.source,
  sourceRef: r.source_ref,
  createdBy: r.created_by,
  createdAt: r.created_at,
  hits: r.hits,
  lastHitAt: r.last_hit_at,
});

export function listRules(db: DB): Rule[] {
  return (db.prepare(`SELECT * FROM review_rules ORDER BY CAST(SUBSTR(code, 2) AS INTEGER)`).all() as unknown as RuleRow[]).map(toRule);
}

/** Enabled rules that apply to a project: global + its client's + its own. */
export function rulesForProject(db: DB, projectId: string): Rule[] {
  const p = db.prepare(`SELECT client_id FROM projects WHERE id = ?`).get(projectId) as { client_id: string } | undefined;
  if (!p) return [];
  return (
    db
      .prepare(
        `SELECT * FROM review_rules
          WHERE enabled = 1 AND (scope = 'global' OR (scope = 'client' AND client_id = ?) OR (scope = 'project' AND project_id = ?))
          ORDER BY CAST(SUBSTR(code, 2) AS INTEGER)`,
      )
      .all(p.client_id, projectId) as unknown as RuleRow[]
  ).map(toRule);
}

export interface NewRule {
  scope: RuleScope;
  clientId?: string | null;
  projectId?: string | null;
  appliesTo?: RuleTarget;
  kind: RuleKind;
  text: string;
  onViolation?: "block" | "revise";
  source?: "manual" | "rejection";
  sourceRef?: string | null;
  createdBy?: string;
}

function normalizeDomain(s: string): string {
  return s.trim().toLowerCase().replace(/^.*@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function createRule(db: DB, input: NewRule): Rule {
  if (!RULE_SCOPES.includes(input.scope)) throw new Error(`Unknown scope ${input.scope}`);
  if (!RULE_KINDS.includes(input.kind)) throw new Error(`Unknown rule kind ${input.kind}`);
  const appliesTo = input.appliesTo ?? "all";
  if (!RULE_TARGETS.includes(appliesTo)) throw new Error(`Unknown target ${appliesTo}`);
  let text = input.text.replace(/\s+/g, " ").trim();
  if (input.kind === "block_domain") {
    text = normalizeDomain(text);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(text)) throw new Error("Enter a domain like lookalike-payments.com");
  } else if (input.kind === "block_phrase") {
    if (text.length < 3) throw new Error("A phrase needs at least 3 characters.");
  } else if (text.length < 10) {
    throw new Error("Write the rule as a full sentence, e.g. “Never promise a delivery date the PM hasn't confirmed.”");
  }
  if (text.length > 600) throw new Error("Keep a rule under 600 characters.");

  let clientId: string | null = null;
  let projectId: string | null = null;
  if (input.scope === "project") {
    const p = db.prepare(`SELECT id, client_id FROM projects WHERE id = ?`).get(input.projectId ?? "") as { id: string; client_id: string } | undefined;
    if (!p) throw new Error("Pick the project this rule applies to.");
    projectId = p.id;
    clientId = p.client_id;
  } else if (input.scope === "client") {
    const c = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(input.clientId ?? "") as { id: string } | undefined;
    if (!c) throw new Error("Pick the client this rule applies to.");
    clientId = c.id;
  }

  const n = (db.prepare(`SELECT COALESCE(MAX(CAST(SUBSTR(code, 2) AS INTEGER)), 0) AS n FROM review_rules`).get() as { n: number }).n;
  const id = randomUUID();
  const code = `R${n + 1}`;
  db.prepare(
    `INSERT INTO review_rules (id, code, scope, client_id, project_id, applies_to, kind, text, on_violation, source, source_ref, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, code, input.scope, clientId, projectId, appliesTo, input.kind, text, input.onViolation ?? "block",
    input.source ?? "manual", input.sourceRef ?? null, input.createdBy ?? "user",
  );
  audit(db, input.createdBy ?? "user", "rule.created", `rule:${id}`, { code, scope: input.scope, kind: input.kind, text, source: input.source ?? "manual" });
  return toRule(db.prepare(`SELECT * FROM review_rules WHERE id = ?`).get(id) as unknown as RuleRow);
}

export function setRuleEnabled(db: DB, id: string, enabled: boolean, actor = "user"): void {
  const r = db.prepare(`UPDATE review_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  if (!Number(r.changes)) throw new Error("Rule not found");
  audit(db, actor, enabled ? "rule.enabled" : "rule.disabled", `rule:${id}`, {});
}

export function updateRuleText(db: DB, id: string, text: string, actor = "user"): void {
  const before = db.prepare(`SELECT * FROM review_rules WHERE id = ?`).get(id) as unknown as RuleRow | undefined;
  if (!before) throw new Error("Rule not found");
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 3 || t.length > 600) throw new Error("Rule text must be 3-600 characters.");
  db.prepare(`UPDATE review_rules SET text = ? WHERE id = ?`).run(before.kind === "block_domain" ? normalizeDomain(t) : t, id);
  audit(db, actor, "rule.edited", `rule:${id}`, { before: before.text, after: t });
}

export function deleteRule(db: DB, id: string, actor = "user"): void {
  const before = db.prepare(`SELECT code, text FROM review_rules WHERE id = ?`).get(id) as { code: string; text: string } | undefined;
  if (!before) throw new Error("Rule not found");
  db.prepare(`DELETE FROM review_rules WHERE id = ?`).run(id);
  audit(db, actor, "rule.deleted", `rule:${id}`, before);
}

export function recordHit(db: DB, ruleId: string): void {
  db.prepare(`UPDATE review_rules SET hits = hits + 1, last_hit_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(ruleId);
}

// ------------------------------------------------------------------ applying rules

export type ItemKind = "signal" | "insight" | "action";

/** Does a rule's target cover this item? actionType is draft_reply | internal_task for actions. */
export function ruleApplies(rule: Pick<Rule, "appliesTo">, kind: ItemKind, actionType?: string): boolean {
  if (rule.appliesTo === "all") return true;
  if (rule.appliesTo === kind) return true;
  return kind === "action" && rule.appliesTo === actionType;
}

const TARGET_HINT: Record<RuleTarget, string> = {
  all: "all items",
  signal: "signals",
  insight: "insights",
  action: "actions",
  draft_reply: "draft replies",
  internal_task: "internal tasks",
};

/** The <team_rules> block given to Reason (to follow) and Review (to enforce). */
export function renderRules(rules: Rule[]): string {
  const ins = rules.filter((r) => r.kind === "instruction");
  const hard = rules.filter((r) => r.kind !== "instruction");
  if (!ins.length && !hard.length) return "";
  const lines = [
    ...ins.map((r) => `- ${r.code} (${TARGET_HINT[r.appliesTo]}; on violation: ${r.onViolation}): ${r.text}`),
    ...hard.map((r) =>
      r.kind === "block_phrase"
        ? `- ${r.code} (${TARGET_HINT[r.appliesTo]}; enforced in code): never include "${r.text}"`
        : `- ${r.code} (actions; enforced in code): never address anyone @${r.text}`,
    ),
  ];
  return `<team_rules>\nRules this team wrote for this project. They override your defaults.\n${lines.join("\n")}\n</team_rules>`;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * The code half of the approval review step: first block_phrase / block_domain rule an
 * item breaks, or null. `text` is everything a person would read; `recipients` the
 * addresses an action targets.
 */
export function hardRuleViolation(
  rules: Rule[],
  kind: ItemKind,
  actionType: string | undefined,
  text: string,
  recipients: string[] = [],
): { rule: Rule; notes: string } | null {
  const lower = text.toLowerCase();
  const addrs = [...recipients, ...(text.match(EMAIL_RE) ?? [])].map((e) => e.toLowerCase());
  for (const r of rules) {
    if (!ruleApplies(r, kind, actionType)) continue;
    if (r.kind === "block_phrase" && lower.includes(r.text.toLowerCase())) {
      return { rule: r, notes: `${r.code}: contains “${r.text}”, which this team blocks` };
    }
    if (r.kind === "block_domain" && kind === "action") {
      const hit = addrs.find((a) => a.endsWith(`@${r.text}`) || a.endsWith(`.${r.text}`));
      if (hit) return { rule: r, notes: `${r.code}: addresses ${hit}; @${r.text} is blocked for this team` };
    }
  }
  return null;
}
