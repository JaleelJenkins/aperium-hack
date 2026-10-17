"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Batch, LogLine } from "@/lib/run-log";
import { Icon } from "./Icon";

const SOURCE: Record<string, string> = { web: "Sync now", worker: "Worker", cli: "npm run pipeline" };
const DISMISS_KEY = "pipeline-panel-dismissed";

const secs = (ms: number | null | undefined) => (ms == null ? "" : `${(ms / 1000).toFixed(1)}s`);
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Live view of the latest pipeline run: the same per-email lines `npm run pipeline`
 * prints, appearing as each email finishes, then totals and the run time. Polls fast
 * while a run is going and refreshes the board as cards move.
 */
export function PipelinePanel() {
  const router = useRouter();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastDone = useRef<number>(-1);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/pipeline/status", { cache: "no-store" });
      const body = (await r.json()) as { busy: boolean; batch: Batch | null };
      setBusy(body.busy);
      setBatch(body.batch);
      // New emails finished: refresh the board so their cards move lanes.
      if (body.batch && body.batch.done !== lastDone.current) {
        if (lastDone.current !== -1) router.refresh();
        lastDone.current = body.batch.done;
      }
    } catch {
      // keep the last view
    }
  }, [router]);

  useEffect(() => {
    setDismissed(readDismissed());
    void poll();
    const onStart = () => {
      setDismissed(null);
      setBusy(true);
      void poll();
    };
    window.addEventListener("pipeline:started", onStart);
    return () => window.removeEventListener("pipeline:started", onStart);
  }, [poll]);

  const running = busy || (batch !== null && !batch.finishedAt);
  useEffect(() => {
    const t = setInterval(() => void poll(), running ? 1500 : 10_000);
    return () => clearInterval(t);
  }, [poll, running]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  if (!batch || (dismissed === batch.id && !running)) return null;
  const finished = !!batch.finishedAt;
  const elapsed = finished ? batch.elapsedMs : now - Date.parse(batch.startedAt);
  const total = Math.max(batch.total, batch.done);
  const pct = total ? Math.round((batch.done / total) * 100) : finished ? 100 : 0;
  const s = batch.summary;

  return (
    <section className={`run-panel${finished ? " done" : ""}${batch.error ? " error" : ""}`} aria-live="polite">
      <header className="run-head">
        {finished ? <Icon name={batch.error ? "alert" : "check"} size={15} /> : <span className="pulse" />}
        <strong>{finished ? (batch.error ? "Pipeline stopped" : "Pipeline finished") : "Pipeline running"}</strong>
        <span className="muted">
          {SOURCE[batch.source] ?? batch.source} · started {clock(batch.startedAt)}
        </span>
        <span className="run-count mono">
          {batch.done}/{total} emails · {secs(elapsed)}
        </span>
        <span className="spacer" />
        {finished && (
          <button
            className="btn ghost sm"
            onClick={() => {
              try {
                localStorage.setItem(DISMISS_KEY, batch.id);
              } catch {
                // per-viewer convenience only
              }
              setDismissed(batch.id);
            }}
            aria-label="Hide run log"
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </header>
      <div className="run-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>

      {finished && s && (
        <div className="run-summary">
          <span>
            <strong>{s.filed}</strong> filed
          </span>
          <span>
            <strong>{s.reviewed}</strong> reviewed
          </span>
          <span>
            <strong>{s.signals}</strong> signals
          </span>
          <Link href={s.approvals ? "/?view=attention" : "/"} className="accent">
            <strong>{s.approvals}</strong> waiting for approval
          </Link>
          <Link href="/?open=caught" className="shield">
            <strong>{s.caught}</strong> caught by review
          </Link>
          {s.cards > 0 && (
            <span>
              <strong>{s.cards}</strong> New project?
            </span>
          )}
          {s.failed > 0 && (
            <span className="bad">
              <strong>{s.failed}</strong> failed
            </span>
          )}
          <span className="muted mono">
            {secs(batch.elapsedMs)} total{s.costUsd ? ` · $${s.costUsd.toFixed(3)}` : ""}
          </span>
        </div>
      )}
      {batch.error && <div className="run-error">{batch.error}</div>}

      <ol className="run-lines">
        {batch.lines.length === 0 && <li className="muted">Reading attachments and filing threads…</li>}
        {batch.lines.map((l) => (
          <RunLine key={l.id} l={l} />
        ))}
      </ol>
    </section>
  );
}

function RunLine({ l }: { l: LogLine }) {
  const d = l.detail;
  const icon = l.kind === "failed" ? "alert" : l.kind === "card" ? "folder" : "check";
  const timing = d && (d.reasonMs != null || d.reviewMs != null) ? `reason ${secs(d.reasonMs)}${d.reviewMs != null ? ` + review ${secs(d.reviewMs)}` : ""}` : d?.by === "rule" ? "filed by rule" : "";
  return (
    <li className={`run-line ${l.kind}`}>
      <Icon name={icon} size={12} />
      {l.messageId ? (
        <Link href={`/?open=email:${encodeURIComponent(l.messageId)}`} scroll={false} className="run-text">
          {l.line}
        </Link>
      ) : (
        <span className="run-text">{l.line}</span>
      )}
      {timing && <span className="run-time mono">{timing}</span>}
    </li>
  );
}
