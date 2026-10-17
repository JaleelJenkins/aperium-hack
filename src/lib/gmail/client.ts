import { createRequire } from "node:module";
import type { Auth, gmail_v1 } from "googleapis";
import { assertGoogleConfigured, config } from "../config";
import { decrypt, encrypt } from "../crypto";
import type { DB } from "../db";
import { decodeBase64Url } from "../ingest/parse";

export type OAuth2Client = Auth.OAuth2Client;

const require = createRequire(import.meta.url);
let _google: typeof import("googleapis").google | undefined;
function getGoogle() {
  return (_google ??= (require("googleapis") as typeof import("googleapis")).google);
}

// readonly: ingest. compose: approved replies become drafts in the thread (never send).
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

/**
 * Only for `npm run seed:inbox`: lets the seeder place demo emails into the
 * test inbox with messages.insert. Requested only via /api/auth/google?seed=1,
 * never by the normal Connect Gmail button.
 */
export const SEED_SCOPE = "https://www.googleapis.com/auth/gmail.insert";

export function oauthClient(): OAuth2Client {
  assertGoogleConfigured();
  const { auth } = getGoogle();
  return new auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

export interface GmailAccountRow {
  email: string;
  refresh_token: string;
  access_token: string | null;
  expiry_date: number | null;
  scope: string | null;
  history_id: string | null;
  last_synced_at: string | null;
  last_error: string | null;
}

export function listAccounts(db: DB): GmailAccountRow[] {
  return db.prepare(`SELECT * FROM gmail_accounts ORDER BY created_at`).all() as GmailAccountRow[];
}

/** Store (or replace) a connected inbox. Tokens are encrypted before they touch the DB. */
export function saveAccount(
  db: DB,
  email: string,
  tokens: { refresh_token: string; access_token?: string | null; expiry_date?: number | null; scope?: string | null },
): void {
  db.prepare(
    `INSERT INTO gmail_accounts (email, refresh_token, access_token, expiry_date, scope)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       access_token  = excluded.access_token,
       expiry_date   = excluded.expiry_date,
       scope         = excluded.scope,
       last_error    = NULL`,
  ).run(
    email,
    encrypt(tokens.refresh_token),
    tokens.access_token ? encrypt(tokens.access_token) : null,
    tokens.expiry_date ?? null,
    tokens.scope ?? null,
  );
}

/**
 * Disconnect wipes tokens and stored mail (PRD trust requirements).
 * Clients, projects, model profiles and the audit trail stay.
 */
export function disconnectAccount(db: DB, email: string): { messages: number } {
  return db.transaction(() => {
    const msgs = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE account = ?`).get(email) as { n: number };
    const inAccount = `IN (SELECT gmail_message_id FROM messages WHERE account = ?)`;
    db.prepare(`DELETE FROM signals WHERE message_id ${inAccount}`).run(email);
    db.prepare(`DELETE FROM attachments WHERE message_id ${inAccount}`).run(email);
    db.prepare(`DELETE FROM messages WHERE account = ?`).run(email);
    db.prepare(`DELETE FROM actions WHERE thread_id IN (SELECT gmail_thread_id FROM threads WHERE account = ?)`).run(email);
    db.prepare(`DELETE FROM threads WHERE account = ?`).run(email);
    db.prepare(`DELETE FROM gmail_accounts WHERE email = ?`).run(email);
    return { messages: msgs.n };
  })();
}

/** OAuth client for a stored account; refreshed tokens are encrypted and written back. */
export function authedClient(db: DB, account: GmailAccountRow): OAuth2Client {
  const client = oauthClient();
  client.setCredentials({
    refresh_token: decrypt(account.refresh_token),
    access_token: account.access_token ? decrypt(account.access_token) : undefined,
    expiry_date: account.expiry_date ?? undefined,
  });
  client.on("tokens", (t) => {
    db.prepare(
      `UPDATE gmail_accounts
         SET access_token  = COALESCE(?, access_token),
             expiry_date   = COALESCE(?, expiry_date),
             refresh_token = COALESCE(?, refresh_token)
       WHERE email = ?`,
    ).run(
      t.access_token ? encrypt(t.access_token) : null,
      t.expiry_date ?? null,
      t.refresh_token ? encrypt(t.refresh_token) : null,
      account.email,
    );
  });
  return client;
}

/**
 * The slice of the Gmail API the ingest stage uses. Kept narrow so the sync
 * logic can be tested against a fake inbox.
 */
export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listHistory(
    startHistoryId: string,
    pageToken?: string,
  ): Promise<{ history: gmail_v1.Schema$History[]; historyId: string | null; nextPageToken: string | null }>;
  listMessageIds(query: string, max: number): Promise<string[]>;
  getMessage(id: string): Promise<gmail_v1.Schema$Message>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  /** Executor only: a draft in the thread (gmail.compose). There is deliberately no send. */
  createDraft(raw: string, threadId: string | null): Promise<{ id: string }>;
}

export function gmailApi(auth: OAuth2Client): GmailApi {
  const gmail = getGoogle().gmail({ version: "v1", auth });
  return {
    async getProfile() {
      const { data } = await gmail.users.getProfile({ userId: "me" });
      return { emailAddress: data.emailAddress!.toLowerCase(), historyId: data.historyId! };
    },
    async listHistory(startHistoryId, pageToken) {
      const { data } = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        labelId: "INBOX",
        pageToken,
        maxResults: 500,
      });
      return { history: data.history ?? [], historyId: data.historyId ?? null, nextPageToken: data.nextPageToken ?? null };
    },
    async listMessageIds(query, max) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: Math.min(100, max - ids.length),
          pageToken,
        });
        for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken && ids.length < max);
      return ids;
    },
    async getMessage(id) {
      const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      return data;
    },
    async getAttachment(messageId, attachmentId) {
      const { data } = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
      return decodeBase64Url(data.data ?? "");
    },
    async createDraft(raw, threadId) {
      const { data } = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw: Buffer.from(raw, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) } },
      });
      if (!data.id) throw new Error("Gmail returned no draft id");
      return { id: data.id };
    },
  };
}

/** Gmail returns 404 when startHistoryId is too old (roughly a week) — caller must re-bootstrap. */
export function isHistoryExpired(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  return e?.code === 404 || e?.code === "404" || e?.status === 404 || e?.response?.status === 404;
}

/** Executor's view: the Gmail API for a connected inbox, or null if it isn't connected. */
export function draftApiFor(db: DB): (account: string) => Pick<GmailApi, "createDraft"> | null {
  const accounts = new Map(listAccounts(db).map((a) => [a.email.toLowerCase(), a]));
  return (account) => {
    const row = accounts.get(account.toLowerCase());
    return row ? gmailApi(authedClient(db, row)) : null;
  };
}
