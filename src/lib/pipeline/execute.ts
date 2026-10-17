/**
 * Executor (PRD F5): carries out actions a person approved. Never sends mail.
 *   draft_reply    -> Gmail drafts.create in the original thread (In-Reply-To / References set),
 *                     after re-checking recipients and team rules. The PM sends it from Gmail.
 *   internal_task  -> becomes an open "We owe" item on the project, with the same evidence.
 * approved | edited -> executed (gmail_draft_id set) | failed (error kept, card shows it).
 */
import { randomUUID } from "node:crypto";
import { checkSendable, type ActionRow } from "../approvals";
import { audit, type DB } from "../db";

export interface DraftApi {
  createDraft(raw: string, threadId: string | null): Promise<{ id: string; messageId?: string | null }>;
}

export interface ExecuteResult {
  drafts: number;
  tasks: number;
  failed: { action: string; error: string }[];
}

const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** Plain-text reply MIME. Exported for tests. */
export function buildReplyMime(r: { from: string; to: string[]; subject: string; body: string; inReplyTo: string | null; references: string | null }): string {
  const headers = [
    `From: ${r.from}`,
    `To: ${r.to.join(", ")}`,
    `Subject: ${encodeHeader(r.subject)}`,
    ...(r.inReplyTo ? [`In-Reply-To: ${r.inReplyTo}`] : []),
    ...(r.references ? [`References: ${r.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(r.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

const reSubject = (s: string | null) => {
  const t = (s ?? "").trim();
  return /^re:/i.test(t) ? t : `Re: ${t || "(no subject)"}`;
};

/**
 * Runs approved actions. `apiFor(account)` returns the Gmail API for the thread's inbox,
 * or null when that inbox isn't connected (the action waits). `onlyId` limits it to one
 * action, for "approve" to execute immediately.
 */
export async function runExecutor(db: DB, apiFor: (account: string) => DraftApi | null, opts: { onlyId?: string } = {}): Promise<ExecuteResult> {
  const out: ExecuteResult = { drafts: 0, tasks: 0, failed: [] };
  const rows = db
    .prepare(
      `SELECT id, project_id, thread_id, message_id, type, payload_json, status, original_payload_json, evidence_json,
              produced_by_model, reviewed_by_model, review_verdict, review_score, review_reason, decided_by
         FROM actions WHERE status IN ('approved', 'edited') AND type IN ('draft_reply', 'internal_task') ${opts.onlyId ? "AND id = ?" : ""}
        ORDER BY decided_at`,
    )
    .all(...(opts.onlyId ? [opts.onlyId] : [])) as unknown as (ActionRow & {
    evidence_json: string;
    produced_by_model: string;
    reviewed_by_model: string | null;
    review_verdict: string | null;
    review_score: number | null;
    review_reason: string | null;
    decided_by: string | null;
  })[];

  for (const a of rows) {
    const payload = JSON.parse(a.payload_json) as { to?: string[]; subject?: string; body?: string; title?: string; notes?: string };
    try {
      if (a.type === "internal_task") {
        if (!a.project_id) throw new Error("task has no project");
        db.transaction(() => {
          const signalId = randomUUID();
          db.prepare(
            `INSERT INTO signals (id, project_id, message_id, type, text, status, evidence_json, produced_by_model,
                                  review_verdict, reviewed_by_model, review_score, review_reason)
             VALUES (?, ?, ?, 'our_commitment', ?, 'open', ?, ?, ?, ?, ?, ?)`,
          ).run(
            signalId, a.project_id, a.message_id, payload.notes ? `${payload.title}: ${payload.notes}` : payload.title ?? "Task",
            a.evidence_json, a.produced_by_model, a.review_verdict, a.reviewed_by_model, a.review_score, a.review_reason,
          );
          db.prepare(`UPDATE actions SET status = 'executed', executed_at = ?, error = NULL WHERE id = ?`).run(new Date().toISOString(), a.id);
          audit(db, "executor", "action.executed", `action:${a.id}`, { type: a.type, signal: signalId });
        })();
        out.tasks++;
        continue;
      }

      const thread = db.prepare(`SELECT gmail_thread_id AS id, account, subject FROM threads WHERE gmail_thread_id = ?`).get(a.thread_id ?? "") as
        | { id: string; account: string; subject: string | null }
        | undefined;
      if (!thread) throw new Error("thread not found");
      const api = apiFor(thread.account);
      if (!api) continue; // inbox not connected right now; try again later
      checkSendable(db, a, payload as Record<string, unknown>);
      const last = db
        .prepare(`SELECT rfc_message_id, references_header FROM messages WHERE thread_id = ? AND rfc_message_id IS NOT NULL ORDER BY received_at DESC LIMIT 1`)
        .get(thread.id) as { rfc_message_id: string; references_header: string | null } | undefined;
      const raw = buildReplyMime({
        from: thread.account,
        to: payload.to ?? [],
        subject: payload.subject?.trim() || reSubject(thread.subject),
        body: payload.body ?? "",
        inReplyTo: last?.rfc_message_id ?? null,
        references: last ? [last.references_header, last.rfc_message_id].filter(Boolean).join(" ") : null,
      });
      const draft = await api.createDraft(raw, thread.id);
      db.prepare(
        `UPDATE actions SET status = 'executed', gmail_draft_id = ?, gmail_draft_message_id = ?, executed_at = ?, error = NULL WHERE id = ?`,
      ).run(draft.id, draft.messageId ?? null, new Date().toISOString(), a.id);
      audit(db, "executor", "action.executed", `action:${a.id}`, { type: a.type, gmail_draft_id: draft.id, method: "drafts.create", account: thread.account });
      out.drafts++;
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      db.prepare(`UPDATE actions SET status = 'failed', error = ? WHERE id = ?`).run(error, a.id);
      audit(db, "executor", "action.failed", `action:${a.id}`, { error });
      out.failed.push({ action: a.id, error });
    }
  }
  return out;
}

/** Puts a failed action back in the queue (e.g. after reconnecting Gmail with compose access). */
export function retryAction(db: DB, id: string, actor = "user"): void {
  const r = db.prepare(`UPDATE actions SET status = 'approved', error = NULL WHERE id = ? AND status = 'failed'`).run(id);
  if (!Number(r.changes)) throw new Error("Only failed actions can be retried.");
  audit(db, actor, "action.retried", `action:${id}`, {});
}
