import { getDb } from "@/lib/db";
import { listAccounts } from "@/lib/gmail/client";
import { AutoRefresh, SyncNowButton } from "./components/LiveControls";
import { ago } from "./format";

export const dynamic = "force-dynamic";

interface InboxRow {
  id: string;
  sender_name: string | null;
  sender_email: string | null;
  project_name: string | null;
  client_name: string | null;
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
  searchParams: Promise<{ error?: string; connected?: string; disconnected?: string }>;
}) {
  const { error, connected, disconnected } = await searchParams;
  const db = getDb();
  const accounts = listAccounts(db);
  const emails = db
    .prepare(
      `SELECT m.gmail_message_id AS id, m.sender_name, m.sender_email, m.subject, m.snippet,
              m.received_at, m.ingested_at, m.status,
              p.name AS project_name, c.name AS client_name,
              COUNT(a.id) FILTER (WHERE a.status IN ('stored','extracted'))                     AS stored,
              COUNT(a.id) FILTER (WHERE a.kind = 'pdf'   AND a.status IN ('stored','extracted')) AS pdfs,
              COUNT(a.id) FILTER (WHERE a.kind = 'image' AND a.status IN ('stored','extracted')) AS images,
              COUNT(a.id) FILTER (WHERE a.status = 'skipped' OR a.status = 'failed')             AS other
         FROM messages m
         JOIN threads t      ON t.gmail_thread_id = m.thread_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN clients c  ON c.id = p.client_id
         LEFT JOIN attachments a ON a.message_id = m.gmail_message_id
        GROUP BY m.gmail_message_id
        ORDER BY m.received_at DESC
        LIMIT 200`,
    )
    .all() as InboxRow[];

  return (
    <>
      <AutoRefresh />
      {error && <div className="banner error">Gmail connection failed: {error}</div>}
      {disconnected && <div className="banner ok">Disconnected. Tokens and stored mail were wiped.</div>}
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
        {accounts.length > 0 && (
          <form method="post" action="/api/auth/google/disconnect">
            <button className="btn" type="submit" title="Wipes tokens and all stored mail">
              Disconnect
            </button>
          </form>
        )}
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
                <th className="hide-sm">Project</th>
                <th className="hide-sm">Files</th>
                <th className="hide-sm">Status</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <tr key={e.id}>
                  <td>
                    <div>{e.sender_name || e.sender_email}</div>
                    {e.sender_name && <div className="muted">{e.sender_email}</div>}
                  </td>
                  <td>
                    <a className="subject" href={`/messages/${encodeURIComponent(e.id)}`}>
                      {e.subject || "(no subject)"}
                    </a>
                    <div className="snippet">{e.snippet}</div>
                  </td>
                  <td className="hide-sm">
                    {e.project_name ? (
                      <>
                        <div>{e.project_name}</div>
                        <div className="muted">{e.client_name}</div>
                      </>
                    ) : (
                      <span className="muted">unassigned</span>
                    )}
                  </td>
                  <td className="hide-sm">
                    {e.pdfs > 0 && <span className="pill">{e.pdfs} PDF</span>}{" "}
                    {e.images > 0 && <span className="pill">{e.images} img</span>}{" "}
                    {e.other > 0 && <span className="pill">{e.other} not downloaded</span>}
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
