import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncAll } from "@/lib/ingest/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Sync now": run one ingest pass in-process (the worker does this on a loop). */
export async function POST() {
  const results = await syncAll(getDb());
  return NextResponse.json({ results });
}
