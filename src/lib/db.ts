import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";

export type DB = Database.Database;

/**
 * Schema for the Inbox + Ingest stages.
 *
 * Downstream stages hang off `emails.status`:
 *   ingested → extracted → resolved → reasoned → reviewed
 * Extract picks up rows WHERE status = 'ingested'.
 *
 * Kept to plain SQL types so it ports to Postgres/Supabase with minor edits.
 */
const MIGRATIONS: string[] = [
  /* 001 */ `
  CREATE TABLE gmail_accounts (
    email          TEXT PRIMARY KEY,
    refresh_token  TEXT NOT NULL,
    access_token   TEXT,
    expiry_date    INTEGER,
    scope          TEXT,
    history_id     TEXT,             -- Gmail history cursor; NULL means bootstrap on next sync
    last_synced_at TEXT,
    last_error     TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE emails (
    id                TEXT PRIMARY KEY,   -- Gmail message id
    account           TEXT NOT NULL REFERENCES gmail_accounts(email),
    thread_id         TEXT NOT NULL,
    rfc_message_id    TEXT,               -- Message-ID header, used for threading drafts later
    in_reply_to       TEXT,
    references_header TEXT,
    from_name         TEXT,
    from_email        TEXT,
    to_json           TEXT NOT NULL DEFAULT '[]',
    cc_json           TEXT NOT NULL DEFAULT '[]',
    subject           TEXT,
    sent_at           TEXT,               -- Date header
    received_at       TEXT NOT NULL,      -- Gmail internalDate
    snippet           TEXT,
    label_ids         TEXT NOT NULL DEFAULT '[]',
    body_source       TEXT NOT NULL,      -- text/plain | text/html | none
    body_raw          TEXT NOT NULL,      -- full text before cleaning (keeps quoted history)
    body_clean        TEXT NOT NULL,      -- new content only; line numbers are evidence anchors
    status            TEXT NOT NULL DEFAULT 'ingested',
    client_id         TEXT,               -- set by Resolve
    project_id        TEXT,               -- set by Resolve
    ingested_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX emails_status_idx   ON emails(status);
  CREATE INDEX emails_thread_idx   ON emails(thread_id);
  CREATE INDEX emails_received_idx ON emails(received_at DESC);

  CREATE TABLE attachments (
    id                  TEXT PRIMARY KEY,  -- <messageId>:<partId>
    email_id            TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    part_id             TEXT NOT NULL,
    gmail_attachment_id TEXT,
    filename            TEXT NOT NULL,
    mime_type           TEXT NOT NULL,
    size                INTEGER NOT NULL DEFAULT 0,
    kind                TEXT NOT NULL,     -- pdf | image | other
    is_inline           INTEGER NOT NULL DEFAULT 0,
    content_id          TEXT,
    sha256              TEXT,
    storage_path        TEXT,              -- relative to DATA_DIR
    status              TEXT NOT NULL,     -- stored | skipped | failed
    error               TEXT
  );
  CREATE INDEX attachments_email_idx ON attachments(email_id);

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    actor       TEXT NOT NULL,            -- worker | user | <model id>
    action      TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    detail_json TEXT
  );
  CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL"); // worker and web app share the file
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

const g = globalThis as unknown as { __clientPulseDb?: DB };

/** Process-wide connection (survives Next.js dev hot reloads). */
export function getDb(): DB {
  if (!g.__clientPulseDb) g.__clientPulseDb = openDb(config.dbPath);
  return g.__clientPulseDb;
}

export function audit(
  db: DB,
  actor: string,
  action: string,
  entityType: string | null,
  entityId: string | null,
  detail?: unknown,
): void {
  db.prepare(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)`,
  ).run(actor, action, entityType, entityId, detail === undefined ? null : JSON.stringify(detail));
}
