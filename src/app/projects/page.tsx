import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/projects";
import { POLICY_LABEL, type RoutingPolicyMode } from "@/lib/router/types";
import { Icon } from "../components/Icon";
import { ago, hue, initials } from "../format";
import { SummaryEditor } from "./SummaryEditor";

export const dynamic = "force-dynamic";

const HEALTH_LABEL = { on_track: "On track", at_risk: "At risk", blocked: "Blocked" } as const;

function filedBy(by: string | null): string {
  if (!by) return "";
  if (by === "rule") return "word match";
  if (by === "human") return "you";
  return by.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2");
}

/** Projects (PRD F3): each client's projects and the summaries Resolve files new mail against. */
export default async function ProjectsPage() {
  const clients = listProjects(getDb());
  const total = clients.reduce((n, c) => n + c.projects.length, 0);

  return (
    <div className="projects-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Portfolio</div>
          <h1>Projects</h1>
          <div className="muted">
            {total} projects across {clients.length} clients. Each new email thread is compared with its client&apos;s project
            summaries and filed to the closest match; below 70% confidence it goes to a &ldquo;New project?&rdquo; card instead.
          </div>
        </div>
      </div>

      {clients.length === 0 && (
        <div className="panel muted">
          No clients yet. Run <code className="mono">npm run seed</code> to load them.
        </div>
      )}

      {clients.map((c) => (
        <section key={c.id} id={`client-${c.id}`} className="client-block">
          <div className="client-head">
            <span className="avatar" style={{ ["--h" as string]: hue(c.name), width: 28, height: 28 }} aria-hidden="true">
              {initials(c.name)}
            </span>
            <div>
              <h2>{c.name}</h2>
              <div className="client-meta mono">
                {c.domains.map((d) => `@${d}`).join(" · ")}
                {c.contacts.length > 0 && <> · {c.contacts.length} contacts</>}
              </div>
            </div>
            {c.unfiledThreads > 0 && (
              <a className="pill warn" href="/">
                {c.unfiledThreads} thread{c.unfiledThreads === 1 ? "" : "s"} waiting on &ldquo;New project?&rdquo;
              </a>
            )}
          </div>

          <div className="proj-grid">
            {c.projects.map((p) => (
              <article key={p.id} id={`project-${p.id}`} className="proj-card">
                <header className="proj-card-head">
                  <h3>{p.name}</h3>
                  <span className={`health ${p.health}`}>{HEALTH_LABEL[p.health] ?? p.health}</span>
                </header>

                <div className="proj-label mono">Summary · used to file new mail</div>
                <SummaryEditor projectId={p.id} summary={p.summary} />

                <dl className="proj-stats">
                  <div>
                    <dt>Threads</dt>
                    <dd className="mono">{p.threads}</dd>
                  </div>
                  <div>
                    <dt>Emails</dt>
                    <dd className="mono">{p.messages}</dd>
                  </div>
                  <div>
                    <dt>Files</dt>
                    <dd className="mono">{p.attachments}</dd>
                  </div>
                  <div>
                    <dt>Open items</dt>
                    <dd className="mono">{p.openSignals}</dd>
                  </div>
                  <div>
                    <dt>Last contact</dt>
                    <dd className="mono">{p.lastContactAt ? ago(p.lastContactAt) : "—"}</dd>
                  </div>
                </dl>

                {p.recentThreads.length > 0 && (
                  <div className="proj-threads">
                    <div className="proj-label mono">Recently filed</div>
                    <ul>
                      {p.recentThreads.map((t) => (
                        <li key={t.id} title={t.reason ?? undefined}>
                          <Icon name="mail" size={12} />
                          <span className="proj-thread-subject">{t.subject || "(no subject)"}</span>
                          {t.confidence != null && (
                            <span className="proj-conf mono">
                              {Math.round(t.confidence * 100)}%{t.assignedBy ? ` · ${filedBy(t.assignedBy)}` : ""}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <footer className="proj-foot">
                  <a href={`/#client-${c.id}`}>Open on board</a>
                  {p.routingPolicy && (
                    <span className="muted mono">
                      Router: {POLICY_LABEL[p.routingPolicy as RoutingPolicyMode] ?? p.routingPolicy}
                    </span>
                  )}
                </footer>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
