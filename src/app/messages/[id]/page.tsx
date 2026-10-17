import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import type { Address } from "@/lib/ingest/parse";
import { formatBytes } from "../../format";

export const dynamic = "force-dynamic";

interface MessageRow {
  gmail_message_id: string;
  thread_id: string;
  sender_name: string | null;
  sender_email: string | null;
  to_json: string;
  cc_json: string;
  subject: string | null;
  sent_at: string | null;
  received_at: string;
  ingested_at: string;
  body_source: string;
  raw_text: string;
  clean_text: string;
  status: string;
  project_name: string | null;
  client_name: string | null;
  assignment_confidence: number | null;
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

/** Source view: every line is an anchor (#L12) so evidence links land on the quoted line. */
export default async function MessagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const email = db
    .prepare(
      `SELECT m.*, p.name AS project_name, c.name AS client_name, t.assignment_confidence
         FROM messages m
         JOIN threads t ON t.gmail_thread_id = m.thread_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE m.gmail_message_id = ?`,
    )
    .get(id) as MessageRow | undefined;
  if (!email) notFound();
  const attachments = db
    .prepare(`SELECT * FROM attachments WHERE message_id = ? ORDER BY part_id`)
    .all(id) as AttachmentRow[];
  const lines = email.clean_text ? email.clean_text.split("\n") : [];

  return (
    <>
      <Link href="/" className="muted back">
        ← Board
      </Link>
      <h1 style={{ marginTop: 8 }}>{email.subject || "(no subject)"}</h1>
      <dl className="meta">
        <dt>From</dt>
        <dd>{email.sender_name ? `${email.sender_name} <${email.sender_email}>` : email.sender_email}</dd>
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
        <dt>Project</dt>
        <dd>
          {email.project_name ? (
            <>
              {email.client_name} · {email.project_name}
              {email.assignment_confidence != null && (
                <span className="muted"> ({Math.round(email.assignment_confidence * 100)}% match)</span>
              )}
            </>
          ) : (
            <span className="muted">unassigned</span>
          )}
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
            <div className="line" id={`L${i + 1}`} key={i}>
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
                {a.status === "stored" || a.status === "extracted" ? (
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
                {a.status !== "stored" && a.status !== "extracted" && (
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

      {email.raw_text !== email.clean_text && (
        <details style={{ marginTop: 24 }}>
          <summary>Full original text (including quoted history)</summary>
          <pre className="raw">{email.raw_text}</pre>
        </details>
      )}
    </>
  );
}
