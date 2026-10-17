import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config";

/**
 * Thin wrapper over Node's built-in SQLite (node:sqlite, Node 22.13+), so
 * `npm install` never compiles a native module. Exposes the small surface the
 * app uses: prepare / exec / transaction / close.
 */
type Params = SQLInputValue[] | [Record<string, SQLInputValue>, ...SQLInputValue[]];

/** Rows come back untyped; callers cast to their row interface. */
export interface Statement {
  run(...params: Params): { changes: number; lastInsertRowid: number };
  get(...params: Params): unknown;
  all(...params: Params): unknown[];
}

export class DB {
  private readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
  }

  prepare(sql: string): Statement {
    const stmt = this.raw.prepare(sql);
    return {
      run: (...p) => {
        const r = stmt.run(...(p as SQLInputValue[]));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      get: (...p) => stmt.get(...(p as SQLInputValue[])),
      all: (...p) => stmt.all(...(p as SQLInputValue[])),
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** db.transaction(fn)() runs fn atomically; nested calls use savepoints. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      const sp = `sp_${this.depth}`;
      this.raw.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const result = fn();
        this.depth--;
        this.raw.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        this.depth--;
        this.raw.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw err;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * Data model from the PRD ("Architecture, data model and stack"), plus
 * gmail_accounts for OAuth state and eval_runs for the scoreboard.
 *
 * Pipeline position of a message lives in messages.status:
 *   ingested → extracted → resolved → reasoned → reviewed   (or failed)
 * Each stage picks up rows in the previous status and advances them.
 *
 * Every AI-made row (signals, insights, actions) carries evidence_json,
 * produced_by_model and review_verdict. Plain SQL types throughout so the
 * schema ports to Supabase/Postgres with minor edits (TEXT JSON → jsonb).
 */
const MIGRATIONS: string[] = [
  /* 001 */ `
  -- ---------------------------------------------------------------- inbox
  CREATE TABLE gmail_accounts (
    email          TEXT PRIMARY KEY,
    refresh_token  TEXT NOT NULL,        -- AES-256-GCM encrypted (see lib/crypto.ts)
    access_token   TEXT,                 -- encrypted
    expiry_date    INTEGER,
    scope          TEXT,
    history_id     TEXT,                 -- Gmail history cursor; NULL = bootstrap on next sync
    last_synced_at TEXT,
    last_error     TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- ------------------------------------------------------- clients/projects
  CREATE TABLE clients (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    domains_json TEXT NOT NULL DEFAULT '[]'  -- sender domains that identify this client
  );

  CREATE TABLE contacts (
    email     TEXT PRIMARY KEY,              -- lowercased
    name      TEXT,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE projects (
    id              TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    summary         TEXT NOT NULL DEFAULT '',
    health          TEXT NOT NULL DEFAULT 'on_track',  -- on_track | at_risk | blocked
    status          TEXT NOT NULL DEFAULT 'active',    -- active | proposed | archived
    sentiment_trend TEXT,                              -- improving | steady | declining
    last_contact_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX projects_client_idx ON projects(client_id);

  -- ------------------------------------------------------------- messages
  CREATE TABLE threads (
    gmail_thread_id       TEXT PRIMARY KEY,
    account               TEXT NOT NULL,
    subject               TEXT,
    project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL,  -- set by Resolve; replies inherit it
    assignment_confidence REAL,
    first_message_at      TEXT,
    last_message_at       TEXT
  );
  CREATE INDEX threads_project_idx ON threads(project_id);

  CREATE TABLE messages (
    gmail_message_id  TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL REFERENCES threads(gmail_thread_id),
    account           TEXT NOT NULL,
    rfc_message_id    TEXT,                -- Message-ID header; drafts reply In-Reply-To this
    in_reply_to       TEXT,
    references_header TEXT,
    sender_email      TEXT,
    sender_name       TEXT,
    to_json           TEXT NOT NULL DEFAULT '[]',
    cc_json           TEXT NOT NULL DEFAULT '[]',
    subject           TEXT,
    sent_at           TEXT,                -- Date header
    received_at       TEXT NOT NULL,       -- Gmail internalDate; latency is measured from here
    snippet           TEXT,
    label_ids         TEXT NOT NULL DEFAULT '[]',
    body_source       TEXT NOT NULL,       -- text/plain | text/html | none
    raw_text          TEXT NOT NULL,       -- full text before cleaning (keeps quoted history)
    clean_text        TEXT NOT NULL,       -- new content only; evidence quotes must appear here
    status            TEXT NOT NULL DEFAULT 'ingested',
    error             TEXT,
    ingested_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX messages_status_idx   ON messages(status);
  CREATE INDEX messages_thread_idx   ON messages(thread_id);
  CREATE INDEX messages_received_idx ON messages(received_at DESC);

  CREATE TABLE attachments (
    id                  TEXT PRIMARY KEY,  -- <gmail_message_id>:<partId>
    message_id          TEXT NOT NULL REFERENCES messages(gmail_message_id) ON DELETE CASCADE,
    part_id             TEXT NOT NULL,
    gmail_attachment_id TEXT,
    filename            TEXT NOT NULL,
    mime_type           TEXT NOT NULL,
    size                INTEGER NOT NULL DEFAULT 0,
    kind                TEXT NOT NULL,     -- pdf | image | audio | video | other
    is_inline           INTEGER NOT NULL DEFAULT 0,
    content_id          TEXT,
    sha256              TEXT,
    storage_path        TEXT,              -- relative to DATA_DIR
    status              TEXT NOT NULL,     -- stored | skipped | failed | extracted
    error               TEXT,
    extracted_text      TEXT,              -- set by Extract
    meta_json           TEXT               -- set by Extract: {"pages": n, "pageText": [...]} / image description
  );
  CREATE INDEX attachments_message_idx ON attachments(message_id);

  -- ---------------------------------------------------- AI-made objects
  CREATE TABLE signals (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    message_id        TEXT REFERENCES messages(gmail_message_id) ON DELETE SET NULL,
    type              TEXT NOT NULL,       -- ask | our_commitment | their_commitment | deadline | decision | risk
    text              TEXT NOT NULL,
    due_at            TEXT,
    status            TEXT NOT NULL DEFAULT 'open',   -- open | done | superseded
    evidence_json     TEXT NOT NULL,       -- Evidence[] (lib/contracts.ts); never empty
    produced_by_model TEXT NOT NULL,
    review_verdict    TEXT,                -- pass | revise | block
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX signals_project_idx ON signals(project_id, type);

  CREATE TABLE insights (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,       -- unanswered_ask | deadline_no_commitment | overdue_commitment | scope_change | sentiment_drop | missing_info
    severity          TEXT NOT NULL,       -- low | medium | high
    text              TEXT NOT NULL,
    suggested_action  TEXT,
    status            TEXT NOT NULL DEFAULT 'open',   -- open | resolved | dismissed
    evidence_json     TEXT NOT NULL,
    produced_by_model TEXT NOT NULL,       -- model id, or 'rule' for deterministic checks
    review_verdict    TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX insights_project_idx ON insights(project_id, status);

  CREATE TABLE actions (
    id                TEXT PRIMARY KEY,
    project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
    thread_id         TEXT REFERENCES threads(gmail_thread_id),
    type              TEXT NOT NULL,       -- draft_reply | internal_task | new_project
    payload_json      TEXT NOT NULL,       -- draft: {to, subject, body}; task: {title, notes}
    status            TEXT NOT NULL DEFAULT 'proposed',  -- proposed | approved | edited | rejected | executed | failed
    evidence_json     TEXT NOT NULL,
    produced_by_model TEXT NOT NULL,
    review_verdict    TEXT,
    decided_by        TEXT,
    decided_at        TEXT,
    decision_reason   TEXT,                -- required on reject
    gmail_draft_id    TEXT,                -- set by Executor (drafts.create only, never send)
    error             TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX actions_status_idx ON actions(status);

  CREATE TABLE model_reviews (
    id             TEXT PRIMARY KEY,
    target_type    TEXT NOT NULL,          -- signal | insight | action
    target_id      TEXT NOT NULL,
    reviewer_model TEXT NOT NULL,
    verdict        TEXT NOT NULL,          -- pass | revise | block
    score          REAL,
    notes          TEXT,                   -- one-line reason; shown in "Caught by review"
    claim_json     TEXT,                   -- the claim as Reason produced it (blocked items never reach their table)
    at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX model_reviews_verdict_idx ON model_reviews(verdict);

  -- ------------------------------------------------- models and scoreboard
  CREATE TABLE model_profiles (
    id          TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,             -- anthropic | openai | ...
    model_name  TEXT NOT NULL,
    label       TEXT NOT NULL,
    stages_json TEXT NOT NULL,             -- ["reason","review"]
    cost_in_per_mtok  REAL,                -- USD per million input tokens, for the cost metric
    cost_out_per_mtok REAL,
    enabled     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE user_model_prefs (
    user_id          TEXT NOT NULL,
    stage            TEXT NOT NULL,        -- reason | review
    model_profile_id TEXT NOT NULL REFERENCES model_profiles(id),
    PRIMARY KEY (user_id, stage)
  );

  CREATE TABLE eval_runs (
    id                TEXT PRIMARY KEY,
    reason_profile_id TEXT NOT NULL REFERENCES model_profiles(id),
    review_profile_id TEXT NOT NULL REFERENCES model_profiles(id),
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    metrics_json      TEXT,                -- project_accuracy, signal_recall, unsupported_shown, traps_caught, latency_p50_s, cost_per_email_usd
    results_json      TEXT                 -- per seed email detail
  );

  -- ----------------------------------------------------------------- audit
  CREATE TABLE audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor       TEXT NOT NULL,             -- worker | user:<id> | <model id>
    verb        TEXT NOT NULL,             -- e.g. message.ingested, action.approved
    object_ref  TEXT,                      -- e.g. message:<id>, action:<id>
    detail_json TEXT,
    at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX audit_object_idx ON audit_events(object_ref);
  `,

  /* 002: review provenance, "Caught by review" links, live latency/cost */ `
  -- PRD: every stored item records which model produced it AND which reviewed it.
  ALTER TABLE signals  ADD COLUMN reviewed_by_model TEXT;
  ALTER TABLE signals  ADD COLUMN review_score      REAL;
  ALTER TABLE signals  ADD COLUMN review_reason     TEXT;
  ALTER TABLE signals  ADD COLUMN original_text     TEXT;  -- Reason's text when review revised it
  ALTER TABLE signals  ADD COLUMN date_basis        TEXT;  -- how a relative date was resolved (trap 2)
  ALTER TABLE signals  ADD COLUMN closed_by_message TEXT;  -- message that answered it (closes_signal_ids)
  ALTER TABLE insights ADD COLUMN reviewed_by_model TEXT;
  ALTER TABLE insights ADD COLUMN review_score      REAL;
  ALTER TABLE insights ADD COLUMN review_reason     TEXT;
  ALTER TABLE actions  ADD COLUMN reviewed_by_model TEXT;
  ALTER TABLE actions  ADD COLUMN review_score      REAL;
  ALTER TABLE actions  ADD COLUMN review_reason     TEXT;
  ALTER TABLE actions  ADD COLUMN message_id        TEXT REFERENCES messages(gmail_message_id) ON DELETE SET NULL;

  -- Blocked items never get a row in their own table, so target_id must be nullable.
  -- Also: who blocked it, links back to the message/project, and the contradicting evidence.
  CREATE TABLE model_reviews_v2 (
    id                        TEXT PRIMARY KEY,
    target_type               TEXT NOT NULL,          -- signal | insight | action
    target_id                 TEXT,                   -- stored row id; NULL when blocked
    tmp_id                    TEXT,                   -- Reason's tmp_id for the item
    message_id                TEXT REFERENCES messages(gmail_message_id) ON DELETE CASCADE,
    project_id                TEXT REFERENCES projects(id) ON DELETE CASCADE,
    produced_by_model         TEXT,
    reviewer_model            TEXT,                   -- NULL for verify/policy blocks
    blocked_by                TEXT,                   -- review | verify | policy | NULL when not blocked
    verdict                   TEXT NOT NULL,          -- pass | revise | block
    score                     REAL,
    notes                     TEXT,                   -- one-line reason; shown in "Caught by review"
    claim_json                TEXT,                   -- the claim as Reason produced it
    conflicting_evidence_json TEXT NOT NULL DEFAULT '[]',  -- Evidence[] that contradicts the claim
    at                        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO model_reviews_v2 (id, target_type, target_id, reviewer_model, blocked_by, verdict, score, notes, claim_json, at)
    SELECT id, target_type, target_id, reviewer_model,
           CASE WHEN verdict = 'block' THEN 'review' END, verdict, score, notes, claim_json, at
    FROM model_reviews;
  DROP TABLE model_reviews;
  ALTER TABLE model_reviews_v2 RENAME TO model_reviews;
  CREATE INDEX model_reviews_verdict_idx ON model_reviews(verdict, at);
  CREATE INDEX model_reviews_project_idx ON model_reviews(project_id);

  -- One row per message through Reason + Review: live latency and cost on the dashboard.
  CREATE TABLE pipeline_runs (
    id                TEXT PRIMARY KEY,
    message_id        TEXT NOT NULL REFERENCES messages(gmail_message_id) ON DELETE CASCADE,
    reason_profile_id TEXT NOT NULL,
    review_profile_id TEXT NOT NULL,
    input_tokens      INTEGER NOT NULL DEFAULT 0,
    output_tokens     INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0,
    latency_ms        INTEGER,                        -- messages.received_at -> stored
    error             TEXT,
    at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX pipeline_runs_message_idx ON pipeline_runs(message_id);
  `,

  /* 003: Reason x Review pair routing (lib/router) */ `
  -- Per-project routing policy; NULL = inherit the global default in app_settings.
  ALTER TABLE projects ADD COLUMN routing_policy TEXT;  -- pareto_auto | complexity_escalation | strict_trust | low_latency | pinned
  ALTER TABLE projects ADD COLUMN pinned_pair_id TEXT;  -- leaderboard pair id when routing_policy = 'pinned'

  -- Small key/value store: router.default_policy, router.pinned_pair_id.
  CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- A batch of routing decisions: the scoreboard's dry-run over seeded mail, or the live pipeline.
  CREATE TABLE route_runs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,                 -- dry_run | pipeline
    started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at  TEXT,
    emails       INTEGER NOT NULL DEFAULT 0,
    escalated    INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT                           -- {pairs: {pairId: n}, triggers: {trigger: n}}
  );

  -- One row per email routed: which pair, under which policy, and why.
  CREATE TABLE route_decisions (
    id             TEXT PRIMARY KEY,
    run_id         TEXT REFERENCES route_runs(id) ON DELETE CASCADE,
    message_id     TEXT NOT NULL REFERENCES messages(gmail_message_id) ON DELETE CASCADE,
    project_id     TEXT,
    policy         TEXT NOT NULL,
    pair_id        TEXT NOT NULL,
    escalated      INTEGER NOT NULL,
    triggers_json  TEXT NOT NULL DEFAULT '[]',
    reason         TEXT NOT NULL,
    est_cost_usd   REAL,
    est_latency_ms INTEGER,
    source         TEXT NOT NULL,               -- dry_run | pipeline
    at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX route_decisions_message_idx ON route_decisions(message_id, at);
  CREATE INDEX route_decisions_run_idx ON route_decisions(run_id);
  `,

  /* 004: Resolve (PRD F3): how and why a thread was filed to a project */ `
  ALTER TABLE threads ADD COLUMN client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL;
  ALTER TABLE threads ADD COLUMN assigned_by       TEXT;  -- model id | rule | human
  ALTER TABLE threads ADD COLUMN assignment_reason TEXT;  -- one line, shown on the card
  `,

  /* 005: Reason + Review stages. Reason's verified output waits here for Review, so a
     failed Review retries without paying for Reason again. */ `
  ALTER TABLE pipeline_runs ADD COLUMN pair_id     TEXT;     -- router pair, e.g. haiku-sonnet
  ALTER TABLE pipeline_runs ADD COLUMN stage       TEXT;     -- reasoned | reviewed | failed
  ALTER TABLE pipeline_runs ADD COLUMN reason_json TEXT;     -- verified Reason output awaiting Review
  ALTER TABLE pipeline_runs ADD COLUMN reason_ms   INTEGER;
  ALTER TABLE pipeline_runs ADD COLUMN review_ms   INTEGER;
  ALTER TABLE pipeline_runs ADD COLUMN provider    TEXT;     -- anthropic | openrouter | mixed
  `,

  /* 006: Performance indexes for dashboard queries */ `
  CREATE INDEX IF NOT EXISTS signals_project_status_idx ON signals(project_id, status);
  CREATE INDEX IF NOT EXISTS signals_due_status_idx ON signals(status, type, due_at);
  CREATE INDEX IF NOT EXISTS attachments_status_kind_idx ON attachments(status, kind);
  CREATE INDEX IF NOT EXISTS route_decisions_src_msg_idx ON route_decisions(source, message_id);
  `,

  /* 007: team review rules (the approval review step) and human approval decisions */ `
  -- Rules the team writes once and every future email is held to. instruction rules are
  -- given to Reason (to follow) and Review (to enforce); block_phrase / block_domain rules
  -- are checked in code after Review, before anything reaches the approval queue.
  CREATE TABLE review_rules (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,                 -- R1, R2 ... shown in "Caught by review"
    scope       TEXT NOT NULL,                        -- global | client | project
    client_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
    project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
    applies_to  TEXT NOT NULL DEFAULT 'all',          -- all | signal | insight | action | draft_reply | internal_task
    kind        TEXT NOT NULL,                        -- instruction | block_phrase | block_domain
    text        TEXT NOT NULL,                        -- the instruction, phrase or domain
    on_violation TEXT NOT NULL DEFAULT 'block',       -- instruction rules: block | revise
    enabled     INTEGER NOT NULL DEFAULT 1,
    source      TEXT NOT NULL DEFAULT 'manual',       -- manual | rejection
    source_ref  TEXT,                                 -- action id a rejection rule came from
    created_by  TEXT NOT NULL DEFAULT 'user',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    hits        INTEGER NOT NULL DEFAULT 0,
    last_hit_at TEXT
  );
  CREATE INDEX review_rules_scope_idx ON review_rules(scope, client_id, project_id);

  ALTER TABLE model_reviews ADD COLUMN rule_id TEXT REFERENCES review_rules(id) ON DELETE SET NULL;
  -- Edits keep what the model proposed, so the scoreboard can measure how much people change.
  ALTER TABLE actions ADD COLUMN original_payload_json TEXT;
  `,

  /* 008: each model's own explanation, shown in the evidence drawer */ `
  ALTER TABLE pipeline_runs ADD COLUMN reason_trace TEXT;   -- Reason model's notes for this email
  ALTER TABLE pipeline_runs ADD COLUMN review_trace TEXT;   -- Review model's notes on the items
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DB(file);
  // WAL: the worker and the web app share the file.
  // cache_size: 4 MB page cache (negative = kibibytes). mmap_size: 128 MB memory-mapped I/O.
  // synchronous=NORMAL: safe under WAL (no data loss on crash), halves fsync stalls vs FULL.
  // temp_store=MEMORY: sorts/indexes in memory rather than temp files.
  db.exec(`
    PRAGMA journal_mode   = WAL;
    PRAGMA busy_timeout   = 5000;
    PRAGMA foreign_keys   = ON;
    PRAGMA cache_size     = -4096;
    PRAGMA mmap_size      = 134217728;
    PRAGMA synchronous    = NORMAL;
    PRAGMA temp_store     = MEMORY;
  `);
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

const g = globalThis as unknown as { __reasoningIntelligenceDb?: DB };

/**
 * The DB file was renamed from client-pulse.db. If only the old file exists, move it
 * (with its WAL files) so an existing inbox, projects and decisions carry over.
 */
function adoptLegacyDb(dbPath: string): void {
  const legacy = path.join(path.dirname(dbPath), "client-pulse.db");
  if (fs.existsSync(dbPath) || !fs.existsSync(legacy)) return;
  for (const ext of ["", "-wal", "-shm"]) if (fs.existsSync(legacy + ext)) fs.renameSync(legacy + ext, dbPath + ext);
}

/** Process-wide connection (survives Next.js dev hot reloads). */
export function getDb(): DB {
  if (!g.__reasoningIntelligenceDb) {
    adoptLegacyDb(config.dbPath);
    g.__reasoningIntelligenceDb = openDb(config.dbPath);
  }
  return g.__reasoningIntelligenceDb;
}

/** Append to audit_events. objectRef is "<type>:<id>", e.g. "message:18f3a". */
export function audit(db: DB, actor: string, verb: string, objectRef: string | null, detail?: unknown): void {
  db.prepare(`INSERT INTO audit_events (actor, verb, object_ref, detail_json) VALUES (?, ?, ?, ?)`).run(
    actor,
    verb,
    objectRef,
    detail === undefined ? null : JSON.stringify(detail),
  );
}
