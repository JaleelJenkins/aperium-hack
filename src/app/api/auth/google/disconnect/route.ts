import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { audit, getDb } from "@/lib/db";
import { disconnectAccount, listAccounts } from "@/lib/gmail/client";
import { safeName } from "@/lib/ingest/store";

export const runtime = "nodejs";

/** Disconnect wipes tokens and stored mail, including downloaded attachments. */
export async function POST(req: NextRequest) {
  const db = getDb();
  const files = db.prepare(`SELECT DISTINCT message_id FROM attachments WHERE storage_path IS NOT NULL`).all() as {
    message_id: string;
  }[];
  for (const acct of listAccounts(db)) {
    const { messages } = disconnectAccount(db, acct.email);
    audit(db, "user", "gmail.disconnected", `gmail_account:${acct.email}`, { messagesWiped: messages });
  }
  for (const f of files) {
    fs.rmSync(path.join(config.attachmentsDir, safeName(f.message_id)), { recursive: true, force: true });
  }
  return NextResponse.redirect(new URL("/?disconnected=1", req.url), 303);
}
