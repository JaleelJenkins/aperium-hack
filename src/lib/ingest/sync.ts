import { config } from "../config";
import { audit, type DB } from "../db";
import { authedClient, gmailApi, isHistoryExpired, listAccounts, type GmailApi } from "../gmail/client";
import { ingestMessage } from "./store";

export interface SyncResult {
  account: string;
  mode: "bootstrap" | "history";
  newEmailIds: string[];
  existing: number;
  skipped: number;
  failed: { id: string; error: string }[];
  historyId: string | null;
}

export interface SyncOptions {
  dataDir?: string;
  bootstrapDays?: number;
  bootstrapMax?: number;
  concurrency?: number;
}

/**
 * One poll of one inbox.
 *
 * First run (no cursor): take the current historyId, then pull recent inbox
 * mail. Later runs: ask Gmail for history since the cursor and ingest only the
 * messages added to INBOX. The cursor only advances when every message in the
 * batch was stored, so a transient failure is retried on the next poll
 * (ingest is idempotent).
 */
export async function syncAccount(db: DB, api: GmailApi, account: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const row = db.prepare(`SELECT history_id FROM gmail_accounts WHERE email = ?`).get(account) as
    | { history_id: string | null }
    | undefined;
  if (!row) throw new Error(`Unknown Gmail account ${account}`);

  try {
    const result = row.history_id
      ? await syncFromHistory(db, api, account, row.history_id, opts)
      : await bootstrap(db, api, account, opts);
    db.prepare(`UPDATE gmail_accounts SET last_synced_at = ?, last_error = ? WHERE email = ?`).run(
      new Date().toISOString(),
      result.failed.length ? `${result.failed.length} message(s) failed; will retry` : null,
      account,
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE gmail_accounts SET last_error = ? WHERE email = ?`).run(message, account);
    throw err;
  }
}

async function bootstrap(db: DB, api: GmailApi, account: string, opts: SyncOptions): Promise<SyncResult> {
  // Read the cursor first so mail arriving mid-bootstrap is picked up by the next history poll.
  const profile = await api.getProfile();
  const days = opts.bootstrapDays ?? config.bootstrapDays;
  const max = opts.bootstrapMax ?? config.bootstrapMaxMessages;
  const ids = (await api.listMessageIds(`in:inbox newer_than:${days}d`, max)).reverse(); // oldest first

  const result = await ingestAll(db, api, account, ids, "bootstrap", opts);
  if (result.failed.length === 0) {
    setCursor(db, account, profile.historyId);
    result.historyId = profile.historyId;
  }
  audit(db, "worker", "sync.bootstrap", `gmail_account:${account}`, summary(result));
  return result;
}

async function syncFromHistory(
  db: DB,
  api: GmailApi,
  account: string,
  startHistoryId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let latest: string | null = null;
  let pageToken: string | undefined;

  try {
    do {
      const page = await api.listHistory(startHistoryId, pageToken);
      for (const h of page.history) {
        for (const added of h.messagesAdded ?? []) {
          const m = added.message;
          if (!m?.id || seen.has(m.id)) continue;
          const labels = m.labelIds ?? [];
          if (!labels.includes("INBOX") || labels.includes("DRAFT")) continue;
          seen.add(m.id);
          ids.push(m.id);
        }
      }
      latest = page.historyId ?? latest;
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (!isHistoryExpired(err)) throw err;
    audit(db, "worker", "sync.history_expired", `gmail_account:${account}`, { startHistoryId });
    setCursor(db, account, null);
    return bootstrap(db, api, account, opts);
  }

  const result = await ingestAll(db, api, account, ids, "history", opts);
  if (result.failed.length === 0 && latest) {
    setCursor(db, account, latest);
    result.historyId = latest;
  } else {
    result.historyId = startHistoryId;
  }
  if (ids.length) audit(db, "worker", "sync.history", `gmail_account:${account}`, summary(result));
  return result;
}

async function ingestAll(
  db: DB,
  api: GmailApi,
  account: string,
  ids: string[],
  mode: SyncResult["mode"],
  opts: SyncOptions,
): Promise<SyncResult> {
  const result: SyncResult = { account, mode, newEmailIds: [], existing: 0, skipped: 0, failed: [], historyId: null };
  const outcomes = await mapLimit(ids, opts.concurrency ?? 4, async (id) => {
    try {
      return { id, outcome: await ingestMessage(db, api, account, id, { dataDir: opts.dataDir }) };
    } catch (err) {
      // Deleted between the history call and the fetch: nothing to ingest.
      if (isHistoryExpired(err)) return { id, outcome: "skipped" as const };
      return { id, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // Report in the order Gmail gave us (oldest first).
  for (const o of outcomes) {
    if ("error" in o) result.failed.push({ id: o.id, error: o.error! });
    else if (o.outcome === "new") result.newEmailIds.push(o.id);
    else if (o.outcome === "exists") result.existing++;
    else result.skipped++;
  }
  return result;
}

function setCursor(db: DB, account: string, historyId: string | null): void {
  db.prepare(`UPDATE gmail_accounts SET history_id = ? WHERE email = ?`).run(historyId, account);
}

function summary(r: SyncResult) {
  return { new: r.newEmailIds.length, existing: r.existing, skipped: r.skipped, failed: r.failed, historyId: r.historyId };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Poll every connected inbox once. Used by the worker loop and the dashboard's "Sync now". */
export async function syncAll(db: DB, opts: SyncOptions = {}): Promise<(SyncResult | { account: string; error: string })[]> {
  const results: (SyncResult | { account: string; error: string })[] = [];
  for (const acct of listAccounts(db)) {
    try {
      results.push(await syncAccount(db, gmailApi(authedClient(db, acct)), acct.email, opts));
    } catch (err) {
      results.push({ account: acct.email, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
