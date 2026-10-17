import { getDb } from "@/lib/db";
import { listRules, RULE_TARGET_LABEL, type Rule } from "@/lib/rules";
import { Icon } from "../components/Icon";
import { ago } from "../format";
import { NewRuleForm, RuleControls } from "./RuleForms";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<Rule["kind"], string> = {
  instruction: "Instruction",
  block_phrase: "Blocked phrase",
  block_domain: "Blocked domain",
};

/**
 * Review rules: the approval review step. Rules written here are applied to every
 * email reviewed from now on: Reason follows them, the review model enforces them,
 * and phrase/domain rules are checked in code before anything reaches the approval queue.
 */
export default async function RulesPage() {
  const db = getDb();
  const rules = listRules(db);
  // node:sqlite rows have a null prototype; client components need plain objects.
  const clients = (db.prepare(`SELECT id, name FROM clients ORDER BY name`).all() as { id: string; name: string }[]).map((r) => ({ ...r }));
  const projects = db
    .prepare(`SELECT p.id, p.name, p.client_id AS clientId, c.name AS clientName FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.status != 'archived' ORDER BY c.name, p.name`)
    .all()
    .map((r) => ({ ...(r as { id: string; name: string; clientId: string; clientName: string }) }));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const projectName = new Map(projects.map((p) => [p.id, `${p.clientName} / ${p.name}`]));
  const scopeLabel = (r: Rule) =>
    r.scope === "global" ? "Every project" : r.scope === "client" ? `All ${clientName.get(r.clientId ?? "") ?? r.clientId} projects` : (projectName.get(r.projectId ?? "") ?? r.projectId);
  const totalHits = rules.reduce((n, r) => n + r.hits, 0);
  const groups: { title: string; rules: Rule[] }[] = [
    { title: "Every project", rules: rules.filter((r) => r.scope === "global") },
    ...clients.map((c) => ({ title: c.name, rules: rules.filter((r) => r.scope !== "global" && r.clientId === c.id) })),
  ].filter((g) => g.rules.length);

  return (
    <div className="rules-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Queues &amp; trust</div>
          <h1>Review rules</h1>
          <div className="muted">
            Write a rule once and every email reviewed from now on is held to it. This is how you tune the models for a client or
            project without touching prompts. Rejecting a draft with &ldquo;save as rule&rdquo; adds one here too.
          </div>
        </div>
      </div>

      <ol className="flow" aria-label="Where rules apply">
        <li>
          <Icon name="zap" size={13} />
          <span>
            <strong>Reason</strong> follows instruction rules
          </span>
        </li>
        <li>
          <Icon name="file" size={13} />
          <span>
            <strong>Checks</strong> evidence, past dates, unknown recipients
          </span>
        </li>
        <li>
          <Icon name="shield" size={13} />
          <span>
            <strong>Review model</strong> enforces instruction rules, names the rule
          </span>
        </li>
        <li>
          <Icon name="alert" size={13} />
          <span>
            <strong>Rule gate</strong> blocks phrases and domains in code
          </span>
        </li>
        <li className="you">
          <Icon name="check" size={13} />
          <span>
            <strong>You</strong> approve, edit or reject
          </span>
        </li>
      </ol>

      <div className="rules-layout">
        <section className="rules-list">
          <div className="rules-list-head">
            <h2>
              {rules.length} rule{rules.length === 1 ? "" : "s"}
            </h2>
            <span className="muted mono">
              {totalHits} catch{totalHits === 1 ? "" : "es"} so far
            </span>
          </div>
          {rules.length === 0 && (
            <div className="panel muted">
              No rules yet. Add one on the right, or reject a draft on the board and tick &ldquo;Save as a review rule&rdquo;.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.title} className="rule-group">
              <div className="proj-label mono">{g.title}</div>
              {g.rules.map((r) => (
                <article key={r.id} id={`rule-${r.code}`} className={`rule-card${r.enabled ? "" : " off"}`}>
                  <header>
                    <span className="ticket">{r.code}</span>
                    <span className={`chip rule-kind ${r.kind}`}>{KIND_LABEL[r.kind]}</span>
                    <span className="rule-meta">
                      {scopeLabel(r)} · {RULE_TARGET_LABEL[r.appliesTo]}
                      {r.kind === "instruction" && ` · ${r.onViolation === "revise" ? "revise" : "block"} on violation`}
                    </span>
                  </header>
                  <RuleControls rule={{ id: r.id, text: r.text, enabled: r.enabled, kind: r.kind }} />
                  <footer>
                    <span>
                      <Icon name="shield" size={11} /> {r.hits} catch{r.hits === 1 ? "" : "es"}
                      {r.lastHitAt && ` · last ${ago(r.lastHitAt)}`}
                    </span>
                    <span>
                      {r.source === "rejection" ? "From a rejected draft" : "Written by hand"} · {ago(r.createdAt)}
                    </span>
                  </footer>
                </article>
              ))}
            </div>
          ))}
        </section>

        <aside className="panel rules-new">
          <h2>New rule</h2>
          <NewRuleForm clients={clients} projects={projects} />
        </aside>
      </div>
    </div>
  );
}
