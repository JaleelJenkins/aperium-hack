import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { audit, type DB } from "../db";
import { isIgnoredSender } from "./ignore";
import { safeName } from "./store";

export interface RemovableMessage {
  id: string;
  sender_email: string | null;
  subject: string | null;
  thread_id: string;
}

export function findMessages(
  db: DB,
  by: { ids?: string[]; ignored?: boolean; subject?: string },
): RemovableMessage[] {
  const all = db
    .prepare(`SELECT gmail_message_id AS id, sender_email, subject, thread_id FROM messages ORDER BY received_at`)
    .all() as RemovableMessage[];
  return all.filter(
    (m) =>
      (by.ids?.includes(m.id) ?? false) ||
      (by.ignored === true && isIgnoredSender(m.sender_email)) ||
      (by.subject !== undefined && (m.subject ?? "").toLowerCase().includes(by.subject.toLowerCase())),
  );
}

/**
 * Remove ingested messages and everything derived from them: attachments (and
 * their files), signals, actions, reviews and pipeline traces tied to the
 * message, and threads left with no messages. The email stays in Gmail.
 */
export function removeMessages(db: DB, messages: RemovableMessage[], opts: { dataDir?: string } = {}): number {
  if (messages.length === 0) return 0;
  const ids = messages.map((m) => m.id);
  const marks = ids.map(() => "?").join(",");
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name),
  );
  const hasColumn = (table: string, col: string) =>
    tables.has(table) && (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

  db.transaction(() => {
    // Rows that reference a message with ON DELETE SET NULL would outlive it; remove them explicitly.
    for (const t of ["signals", "actions"]) if (hasColumn(t, "message_id")) db.prepare(`DELETE FROM ${t} WHERE message_id IN (${marks})`).run(...ids);
    // Everything else (attachments, reviews, pipeline/route traces) cascades.
    db.prepare(`DELETE FROM messages WHERE gmail_message_id IN (${marks})`).run(...ids);
    const threads = [...new Set(messages.map((m) => m.thread_id))];
    for (const t of threads) {
      const left = db.prepare(`SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1`).get(t);
      if (!left) {
        if (hasColumn("actions", "thread_id")) db.prepare(`DELETE FROM actions WHERE thread_id = ?`).run(t);
        db.prepare(`DELETE FROM threads WHERE gmail_thread_id = ?`).run(t);
      }
    }
    for (const m of messages) audit(db, "user", "message.removed", `message:${m.id}`, { from: m.sender_email, subject: m.subject });
  })();

  const dataDir = opts.dataDir ?? config.dataDir;
  for (const id of ids) fs.rmSync(path.join(dataDir, "attachments", safeName(id)), { recursive: true, force: true });
  return ids.length;
}
