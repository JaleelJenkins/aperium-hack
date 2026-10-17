import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { bodyLines, emailLineRef } from "@/lib/evidence";
import type { Address } from "@/lib/ingest/parse";
import { formatBytes } from "../../format";

export const dynamic = "force-dynamic";

interface EmailRow {
  id: string;
  thread_id: string;
  from_name: string | null;
  from_email: string | null;
  to_json: string;
  cc_json: string;
  subject: string | null;
  sent_at: string | null;
  received_at: string;
  ingested_at: string;
  body_source: string;
  body_raw: string;
  body_clean: string;
  status: string;
}

interface AttachmentRow {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  kind: string;
  is_inline: number;
  status: string;
  error: string | null;
}

function fmtAddrs(json: string): string {
  return (JSON.parse(json) as Address[]).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}

/** Source view: every line is an anchor (#L12) so downstream evidence links land here. */
export default async function EmailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const email = db.prepare(`SELECT * FROM emails WHERE id = ?`).get(id) as EmailRow | undefined;
  if (!email) notFound();
  const attachments = db
    .prepare(`SELECT * FROM attachments WHERE email_id = ? ORDER BY part_id`)
    .all(id) as AttachmentRow[];
  const lines = email.body_clean ? bodyLines(email.body_clean) : [];

  return (
    <>
      <a href="/" className="muted">
        ← Inbox
      </a>
      <h1 style={{ marginTop: 8 }}>{email.subject || "(no subject)"}</h1>
      <dl className="meta">
        <dt>From</dt>
        <dd>{email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}</dd>
        <dt>To</dt>
        <dd>{fmtAddrs(email.to_json)}</dd>
        {email.cc_json !== "[]" && (
          <>
            <dt>Cc</dt>
            <dd>{fmtAddrs(email.cc_json)}</dd>
          </>
        )}
        <dt>Received</dt>
        <dd>
          {new Date(email.received_at).toLocaleString()}{" "}
          <span className="muted">(ingested {new Date(email.ingested_at).toLocaleTimeString()})</span>
        </dd>
        <dt>Status</dt>
        <dd>
          <span className="pill ok">{email.status}</span> <span className="muted">from {email.body_source}</span>
        </dd>
      </dl>

      <h2>Message</h2>
      {lines.length === 0 ? (
        <p className="muted">No text body.</p>
      ) : (
        <div className="lines">
          {lines.map((text, i) => (
            <div className="line" id={`L${i + 1}`} key={i} title={emailLineRef(email.id, i + 1)}>
              <a className="ln" href={`#L${i + 1}`}>
                {i + 1}
              </a>
              <span>{text || " "}</span>
            </div>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <>
          <h2>Attachments</h2>
          <div className="panel">
            {attachments.map((a) => (
              <div className="row" key={a.id} style={{ padding: "4px 0" }}>
                <span className="pill">{a.kind}</span>
                {a.status === "stored" ? (
                  <a href={`/api/attachments/${encodeURIComponent(a.id)}`} target="_blank">
                    {a.filename}
                  </a>
                ) : (
                  <span>{a.filename}</span>
                )}
                <span className="muted">
                  {formatBytes(a.size)}
                  {a.is_inline ? " · inline" : ""}
                </span>
                {a.status !== "stored" && (
                  <span className={`pill ${a.status === "failed" ? "bad" : "warn"}`}>
                    {a.status}
                    {a.error ? `: ${a.error}` : ""}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {email.body_raw !== email.body_clean && (
        <details style={{ marginTop: 24 }}>
          <summary>Full original text (including quoted history)</summary>
          <pre className="raw">{email.body_raw}</pre>
        </details>
      )}
    </>
  );
}
