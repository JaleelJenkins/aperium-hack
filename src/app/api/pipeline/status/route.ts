import { NextResponse } from "next/server";
import { pipelineBusy } from "@/lib/cycle";
import { getDb } from "@/lib/db";
import { latestBatch } from "@/lib/run-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The latest pipeline run (Sync now or worker) with its per-email lines, for the live panel. */
export async function GET() {
  const db = getDb();
  return NextResponse.json({ busy: pipelineBusy(db), batch: latestBatch(db) });
}
