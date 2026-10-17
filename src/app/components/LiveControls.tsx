"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Refreshes the server-rendered inbox every few seconds so new mail shows up on its own. */
export function AutoRefresh({ everyMs = 15_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}

export function SyncNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/ingest/sync", { method: "POST" });
      const body = (await res.json()) as {
        results: ({ account: string; newEmailIds?: string[]; error?: string })[];
        pipeline: "started" | "busy" | "idle";
        waiting: number;
      };
      const parts = body.results.map((r) => (r.error ? `${r.account}: ${r.error}` : `+${r.newEmailIds?.length ?? 0} new`));
      if (!parts.length) parts.push("No inbox connected");
      if (body.pipeline === "started") parts.push(`processing ${body.waiting} email${body.waiting === 1 ? "" : "s"}…`);
      else if (body.pipeline === "busy") parts.push("pipeline already running");
      setMsg(parts.join(" · "));
      // Tell the run panel to start watching right away.
      window.dispatchEvent(new Event("pipeline:started"));
      router.refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="row">
      <button className="btn" onClick={run} disabled={busy}>
        {busy ? "Syncing…" : "Sync now"}
      </button>
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}
