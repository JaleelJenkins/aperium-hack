import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

/** Serve a stored attachment inline (PDFs open in the browser viewer; #page=N works). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = getDb()
    .prepare(`SELECT filename, mime_type, storage_path FROM attachments WHERE id = ? AND status = 'stored'`)
    .get(id) as { filename: string; mime_type: string; storage_path: string } | undefined;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const root = path.resolve(config.dataDir);
  const abs = path.resolve(root, row.storage_path);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) {
    return NextResponse.json({ error: "file missing" }, { status: 404 });
  }
  return new NextResponse(fs.readFileSync(abs), {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
