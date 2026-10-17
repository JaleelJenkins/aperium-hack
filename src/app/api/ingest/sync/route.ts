import { after, NextResponse } from "next/server";
import { ensureSeeded, pipelineBusy, processWaiting } from "@/lib/cycle";
import { getDb } from "@/lib/db";
import { syncAll } from "@/lib/ingest/sync";
import { describe } from "@/lib/pipeline/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Sync now": pull new mail, then run the whole pipeline (Extract -> Resolve -> Reason ->
 * Review -> Executor) on everything waiting. The pipeline continues after the response is
 * sent, since model calls take a while; the board refreshes itself and cards move through
 * their stages as it goes. If the worker is already processing, this doesn't start a second run.
 */
export async function POST() {
  const db = getDb();
  const seeded = ensureSeeded(db);
  const results = await syncAll(db);
  const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status IN ('ingested', 'extracted', 'resolved', 'reasoned')`).get() as { n: number }).n;
  const approved = (db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE status IN ('approved', 'edited')`).get() as { n: number }).n;
  const busy = pipelineBusy(db);
  const pipeline = busy ? "busy" : waiting || approved ? "started" : "idle";
  if (pipeline === "started") {
    after(async () => {
      try {
        const r = await processWaiting(db, "web");
        if (r.ran) for (const line of describe(r.pipeline)) console.log(`[sync now] ${line}`);
      } catch (err) {
        console.error(`[sync now] pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
  return NextResponse.json({ results, pipeline, waiting, seeded: seeded !== null });
}
