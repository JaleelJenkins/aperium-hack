/**
 * Demo snapshots (PRD: "keep a preloaded database state"). Save the whole demo state, then
 * restore it between rehearsals or if anything goes wrong on stage.
 *
 * Both work while `npm run dev` and the worker are running:
 *  - save uses VACUUM INTO, which writes a consistent copy even with other connections open;
 *  - restore swaps every table's rows inside the LIVE database in one transaction (no file
 *    replacement, which Windows refuses for open files), so the app shows it immediately.
 *
 * Restore keeps the current Gmail connection (tokens + history cursor). Rewinding the cursor
 * would make the worker re-ingest the rehearsal email on its next poll.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { DB } from "./db";

export interface SnapshotInfo {
  name: string;
  createdAt: string;
  userVersion: number;
  counts: Record<string, number>;
  hasAttachments: boolean;
}

const COUNTED = ["messages", "attachments", "signals", "actions", "model_reviews", "route_decisions", "eval_runs"];
/** Tables restore never overwrites while a live row exists. */
const KEEP_LIVE = new Set(["gmail_accounts"]);

export const snapshotsDir = () => path.join(config.dataDir, "snapshots");

function assertName(name: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error(`Snapshot names are letters, digits, . _ - (got "${name}")`);
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const userVersion = (db: DB, schema = "main") =>
  (db.prepare(`PRAGMA ${schema}.user_version`).get() as { user_version: number }).user_version;
const tables = (db: DB, schema: string) =>
  (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map(
    (r) => r.name,
  );
const columns = (db: DB, schema: string, table: string) =>
  (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name).join(",");

export function saveSnapshot(db: DB, name: string): SnapshotInfo {
  assertName(name);
  const dir = path.join(snapshotsDir(), name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  db.exec(`VACUUM INTO ${sqlString(path.join(dir, "client-pulse.db"))}`);

  const hasAttachments = fs.existsSync(config.attachmentsDir);
  if (hasAttachments) fs.cpSync(config.attachmentsDir, path.join(dir, "attachments"), { recursive: true });

  const counts: Record<string, number> = {};
  for (const t of COUNTED) counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const info: SnapshotInfo = { name, createdAt: new Date().toISOString(), userVersion: userVersion(db), counts, hasAttachments };
  fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify(info, null, 2));
  return info;
}

export function listSnapshots(): SnapshotInfo[] {
  const root = snapshotsDir();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((n) => path.join(root, n, "snapshot.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as SnapshotInfo)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface RestoreResult {
  name: string;
  tables: number;
  rows: number;
  keptLiveGmail: boolean;
}

export function restoreSnapshot(db: DB, name: string): RestoreResult {
  assertName(name);
  const dir = path.join(snapshotsDir(), name);
  const file = path.join(dir, "client-pulse.db");
  if (!fs.existsSync(file)) {
    const known = listSnapshots().map((s) => s.name);
    throw new Error(`No snapshot "${name}".${known.length ? ` Available: ${known.join(", ")}` : " Save one with npm run demo:snapshot."}`);
  }

  db.exec(`ATTACH DATABASE ${sqlString(file)} AS snap`);
  let result: RestoreResult;
  try {
    const live = userVersion(db);
    const snap = userVersion(db, "snap");
    if (live !== snap) {
      throw new Error(`Snapshot "${name}" is schema v${snap}, the live database is v${live}. Save a fresh snapshot after migrating.`);
    }
    const snapTables = new Set(tables(db, "snap"));
    const liveTables = tables(db, "main");
    for (const t of liveTables) {
      if (snapTables.has(t) && columns(db, "main", t) !== columns(db, "snap", t)) {
        throw new Error(`Table ${t} differs between the snapshot and the live database; save a fresh snapshot.`);
      }
    }

    const keptLiveGmail = (db.prepare(`SELECT COUNT(*) AS n FROM main.gmail_accounts`).get() as { n: number }).n > 0;
    let rows = 0;
    // Foreign keys can't be toggled inside a transaction, and rows arrive in table order.
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        for (const t of liveTables) {
          if (KEEP_LIVE.has(t) && keptLiveGmail) continue;
          db.exec(`DELETE FROM main.${t}`);
          if (snapTables.has(t)) rows += db.prepare(`INSERT INTO main.${t} SELECT * FROM snap.${t}`).run().changes;
        }
        const seq = (schema: string) =>
          (db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.sqlite_master WHERE name = 'sqlite_sequence'`).get() as { n: number }).n > 0;
        if (seq("main") && seq("snap")) {
          db.exec(`DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM snap.sqlite_sequence;`);
        }
      })();
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    result = { name, tables: liveTables.length, rows, keptLiveGmail };
  } finally {
    db.exec("DETACH DATABASE snap");
  }

  // Attachment files: the DB rows above point into data/attachments.
  const snapAttachments = path.join(dir, "attachments");
  fs.rmSync(config.attachmentsDir, { recursive: true, force: true });
  if (fs.existsSync(snapAttachments)) fs.cpSync(snapAttachments, config.attachmentsDir, { recursive: true });
  return result;
}
