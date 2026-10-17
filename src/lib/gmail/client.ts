import { google, type gmail_v1 } from "googleapis";
import { assertGoogleConfigured, config } from "../config";
import type { DB } from "../db";
import { decodeBase64Url } from "../ingest/parse";

export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

// readonly: ingest. compose: approved replies become drafts in the thread (never send).
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

export function oauthClient(): OAuth2Client {
  assertGoogleConfigured();
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
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

/** OAuth client for a stored account; refreshed tokens are written back. */
export function authedClient(db: DB, account: GmailAccountRow): OAuth2Client {
  const client = oauthClient();
  client.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token ?? undefined,
    expiry_date: account.expiry_date ?? undefined,
  });
  client.on("tokens", (t) => {
    db.prepare(
      `UPDATE gmail_accounts
         SET access_token = COALESCE(?, access_token),
             expiry_date  = COALESCE(?, expiry_date),
             refresh_token = COALESCE(?, refresh_token)
       WHERE email = ?`,
    ).run(t.access_token ?? null, t.expiry_date ?? null, t.refresh_token ?? null, account.email);
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
}

export function gmailApi(auth: OAuth2Client): GmailApi {
  const gmail = google.gmail({ version: "v1", auth });
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
  };
}

/** Gmail returns 404 when startHistoryId is too old (roughly a week) — caller must re-bootstrap. */
export function isHistoryExpired(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  return e?.code === 404 || e?.code === "404" || e?.status === 404 || e?.response?.status === 404;
}
