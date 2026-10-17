import { getDb } from "@/lib/db";
import { listAccounts } from "@/lib/gmail/client";
import { AutoRefresh, SyncNowButton } from "./components/LiveControls";
import { ago } from "./format";

export const dynamic = "force-dynamic";

interface InboxRow {
  id: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: string;
  ingested_at: string;
  status: string;
  stored: number;
  pdfs: number;
  images: number;
  other: number;
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const { error, connected } = await searchParams;
  const db = getDb();
  const accounts = listAccounts(db);
  const emails = db
    .prepare(
      `SELECT e.id, e.from_name, e.from_email, e.subject, e.snippet, e.received_at, e.ingested_at, e.status,
              COUNT(a.id) FILTER (WHERE a.status = 'stored')                     AS stored,
              COUNT(a.id) FILTER (WHERE a.kind = 'pdf'   AND a.status = 'stored') AS pdfs,
              COUNT(a.id) FILTER (WHERE a.kind = 'image' AND a.status = 'stored') AS images,
              COUNT(a.id) FILTER (WHERE a.kind = 'other')                         AS other
         FROM emails e LEFT JOIN attachments a ON a.email_id = e.id
        GROUP BY e.id
        ORDER BY e.received_at DESC
        LIMIT 200`,
    )
    .all() as InboxRow[];

  return (
    <>
      <AutoRefresh />
      {error && <div className="banner error">Gmail connection failed: {error}</div>}
      {connected && <div className="banner ok">Connected {connected}. The worker will pull recent inbox mail on its next poll.</div>}

      <div className="row" style={{ marginBottom: 16 }}>
        <div>
          <h1>Inbox</h1>
          <div className="muted">
            {accounts.length === 0
              ? "No inbox connected."
              : accounts.map((a) => (
                  <span key={a.email}>
                    {a.email} · {a.last_synced_at ? `synced ${ago(a.last_synced_at)}` : "waiting for first sync"}
                    {a.last_error && <span className="pill bad" style={{ marginLeft: 8 }}>{a.last_error}</span>}
                  </span>
                ))}
          </div>
        </div>
        <div className="spacer" />
        {accounts.length > 0 && <SyncNowButton />}
        <a className={`btn ${accounts.length ? "" : "primary"}`} href="/api/auth/google">
          {accounts.length ? "Reconnect Gmail" : "Connect Gmail"}
        </a>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        {emails.length === 0 ? (
          <p className="muted" style={{ padding: 16, margin: 0 }}>
            {accounts.length
              ? "Nothing ingested yet. Run `npm run worker`, or click Sync now."
              : "Connect the test inbox to start ingesting."}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>Subject</th>
                <th className="hide-sm">Files</th>
                <th className="hide-sm">Status</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <tr key={e.id}>
                  <td>
                    <div>{e.from_name || e.from_email}</div>
                    {e.from_name && <div className="muted">{e.from_email}</div>}
                  </td>
                  <td>
                    <a className="subject" href={`/emails/${encodeURIComponent(e.id)}`}>
                      {e.subject || "(no subject)"}
                    </a>
                    <div className="snippet">{e.snippet}</div>
                  </td>
                  <td className="hide-sm">
                    {e.pdfs > 0 && <span className="pill">{e.pdfs} PDF</span>}{" "}
                    {e.images > 0 && <span className="pill">{e.images} img</span>}{" "}
                    {e.other > 0 && <span className="pill">{e.other} other</span>}
                  </td>
                  <td className="hide-sm">
                    <span className="pill ok">{e.status}</span>
                  </td>
                  <td className="muted" title={`received ${e.received_at}, ingested ${e.ingested_at}`}>
                    {ago(e.received_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
