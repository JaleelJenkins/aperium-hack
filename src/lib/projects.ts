/**
 * Projects page data: every client's projects with their summaries (what
 * Resolve matches new threads against) and how mail has been filed to them.
 */
import { audit, type DB } from "./db";

export interface FiledThread {
  id: string;
  subject: string | null;
  confidence: number | null;
  assignedBy: string | null;
  reason: string | null;
  lastMessageAt: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  summary: string;
  health: "on_track" | "at_risk" | "blocked";
  status: string;
  lastContactAt: string | null;
  routingPolicy: string | null;
  threads: number;
  messages: number;
  attachments: number;
  openSignals: number;
  recentThreads: FiledThread[];
}

export interface ClientProjects {
  id: string;
  name: string;
  domains: string[];
  contacts: { email: string; name: string | null }[];
  projects: ProjectInfo[];
  /** Threads from this client still waiting on a "New project?" decision. */
  unfiledThreads: number;
}

export const MAX_SUMMARY_LENGTH = 1200;

export function listProjects(db: DB): ClientProjects[] {
  const clients = db.prepare(`SELECT id, name, domains_json FROM clients ORDER BY name`).all() as {
    id: string;
    name: string;
    domains_json: string;
  }[];
  const contacts = db.prepare(`SELECT email, name, client_id FROM contacts ORDER BY email`).all() as {
    email: string;
    name: string | null;
    client_id: string;
  }[];
  const projects = db
    .prepare(
      `SELECT p.id, p.client_id, p.name, p.summary, p.health, p.status, p.last_contact_at, p.routing_policy,
              (SELECT COUNT(*) FROM threads t WHERE t.project_id = p.id) AS threads,
              (SELECT COUNT(*) FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id WHERE t.project_id = p.id) AS messages,
              (SELECT COUNT(*) FROM attachments a JOIN messages m ON m.gmail_message_id = a.message_id
                 JOIN threads t ON t.gmail_thread_id = m.thread_id
                WHERE t.project_id = p.id AND a.status IN ('stored', 'extracted')) AS attachments,
              (SELECT COUNT(*) FROM signals s WHERE s.project_id = p.id AND s.status = 'open') AS open_signals
         FROM projects p
        WHERE p.status != 'archived'
        ORDER BY p.name`,
    )
    .all() as {
    id: string;
    client_id: string;
    name: string;
    summary: string;
    health: ProjectInfo["health"];
    status: string;
    last_contact_at: string | null;
    routing_policy: string | null;
    threads: number;
    messages: number;
    attachments: number;
    open_signals: number;
  }[];
  const recent = db.prepare(
    `SELECT gmail_thread_id AS id, subject, assignment_confidence AS confidence, assigned_by AS assignedBy,
            assignment_reason AS reason, last_message_at AS lastMessageAt
       FROM threads WHERE project_id = ? ORDER BY last_message_at DESC LIMIT 4`,
  );
  const unfiled = db.prepare(
    `SELECT COUNT(DISTINCT t.gmail_thread_id) AS n FROM threads t
       JOIN actions a ON a.thread_id = t.gmail_thread_id AND a.type = 'new_project' AND a.status = 'proposed'
      WHERE t.client_id = ? AND t.project_id IS NULL`,
  );

  return clients.map((c) => ({
    id: c.id,
    name: c.name,
    domains: JSON.parse(c.domains_json) as string[],
    contacts: contacts.filter((ct) => ct.client_id === c.id && !/CHANGE_ME/i.test(ct.email)).map(({ email, name }) => ({ email, name })),
    unfiledThreads: (unfiled.get(c.id) as { n: number }).n,
    projects: projects
      .filter((p) => p.client_id === c.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        summary: p.summary,
        health: p.health,
        status: p.status,
        lastContactAt: p.last_contact_at,
        routingPolicy: p.routing_policy,
        threads: p.threads,
        messages: p.messages,
        attachments: p.attachments,
        openSignals: p.open_signals,
        recentThreads: recent.all(p.id) as FiledThread[],
      })),
  }));
}

/**
 * Edit a project summary. Resolve compares new threads against it, so a better
 * summary means better filing; already-filed threads stay where they are.
 */
export function updateProjectSummary(db: DB, projectId: string, summary: string, actor = "user"): void {
  const text = summary.replace(/\r\n?/g, "\n").trim();
  if (text.length < 20) throw new Error("Write at least a sentence: Resolve matches new email against this summary.");
  if (text.length > MAX_SUMMARY_LENGTH) throw new Error(`Keep it under ${MAX_SUMMARY_LENGTH} characters.`);
  const before = db.prepare(`SELECT summary FROM projects WHERE id = ?`).get(projectId) as { summary: string } | undefined;
  if (!before) throw new Error(`Unknown project ${projectId}`);
  if (before.summary === text) return;
  db.transaction(() => {
    db.prepare(`UPDATE projects SET summary = ? WHERE id = ?`).run(text, projectId);
    audit(db, actor, "project.summary_edited", `project:${projectId}`, { before: before.summary, after: text });
  })();
}
