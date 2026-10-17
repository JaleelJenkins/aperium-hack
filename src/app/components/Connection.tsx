import { cache } from "react";
import { pipelineBusy } from "@/lib/cycle";
import { getDb } from "@/lib/db";
import { listAccounts } from "@/lib/gmail/client";
import { ago } from "../format";
import { SyncNowButton } from "./LiveControls";

type Flash = { error?: string; connected?: string; disconnected?: string };

/**
 * Memoized per-request accounts fetch. React.cache deduplicates calls within a
 * single server render so InboxStatus and ConnectionControls share one DB query.
 */
const getAccounts = cache(() => listAccounts(getDb()));

/** OAuth callback / disconnect redirect back with these query params. */
export function ConnectionBanners({ error, connected, disconnected }: Flash) {
  return (
    <>
      {error && <div className="banner error">Gmail connection failed: {error}</div>}
      {disconnected && <div className="banner ok">Disconnected. Tokens and stored mail were wiped.</div>}
      {connected && <div className="banner ok">Connected {connected}. Click Sync now to pull recent mail and run the pipeline (the worker also does this every poll).</div>}
    </>
  );
}

/** Inbox status line: which account, when it last synced, and any sync error. */
export function InboxStatus() {
  const accounts = getAccounts();
  if (accounts.length === 0) return <span className="muted">No inbox connected</span>;
  const db = getDb();
  const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status IN ('ingested', 'extracted', 'resolved', 'reasoning', 'reasoned', 'reviewing')`).get() as { n: number }).n;
  const busy = pipelineBusy(db);
  return (
    <span className="inbox-status">
      {accounts.map((a) => (
        <span key={a.email} className="row" style={{ gap: 6 }}>
          <span className={`dot ${a.last_error ? "bad" : "ok"}`} />
          {a.email}
          <span className="muted">· {a.last_synced_at ? `synced ${ago(a.last_synced_at)}` : "waiting for first sync"}</span>
          {a.last_error && <span className="pill bad">{a.last_error}</span>}
        </span>
      ))}
      {busy ? (
        <span className="meta-item processing" title="Extract, Resolve, Reason and Review are running">
          <span className="pulse" />
          Processing {waiting} email{waiting === 1 ? "" : "s"}
        </span>
      ) : (
        waiting > 0 && (
          <span className="muted" title="Click Sync now, or start the worker (npm run worker), to process them">
            · {waiting} waiting for the pipeline
          </span>
        )
      )}
    </span>
  );
}

/** Sync now + Connect / Reconnect / Disconnect. */
export function ConnectionControls() {
  const connected = getAccounts().length > 0;
  return (
    <div className="row" style={{ gap: 8 }}>
      {connected && <SyncNowButton />}
      <a className={`btn ${connected ? "" : "primary"}`} href="/api/auth/google">
        {connected ? "Reconnect Gmail" : "Connect Gmail"}
      </a>
      {connected && (
        <form method="post" action="/api/auth/google/disconnect">
          <button className="btn ghost" type="submit" title="Wipes tokens and all stored mail">
            Disconnect
          </button>
        </form>
      )}
    </div>
  );
}
