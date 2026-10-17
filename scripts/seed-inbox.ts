/**
 * Put the demo seed emails (seed/emails.ts) into the connected Gmail inbox.
 *
 *   npm run seed:inbox -- --dry-run          write .eml files to data/seed-eml/, touch nothing
 *   npm run seed:inbox                       insert into the connected inbox
 *   npm run seed:inbox -- --anchor 2026-10-17T09:00   date everything relative to this time
 *
 * Uses Gmail's messages.insert, so emails arrive with their real client sender
 * addresses, backdated timestamps and proper threads, without anyone sending
 * anything. Needs the extra gmail.insert permission, granted through
 * http://localhost:3000/api/auth/google?seed=1 (see README → Seeding the inbox).
 *
 * Safe to re-run: each email has a fixed Message-ID and is skipped if already
 * in the inbox. Writes ground truth with absolute dates and Gmail ids to
 * data/seed-run.json for the eval.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { config } from "../src/lib/config";
import { audit, getDb } from "../src/lib/db";
import { authedClient, listAccounts, SEED_SCOPE } from "../src/lib/gmail/client";
import { buildSeedMessages, toBase64Url } from "../src/lib/seed-inbox";
import { applySeed, readSeed } from "../src/lib/seed";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const anchorArg = args.includes("--anchor") ? args[args.indexOf("--anchor") + 1] : undefined;
const anchor = anchorArg ? new Date(anchorArg) : new Date();
if (Number.isNaN(anchor.getTime())) {
  console.error(`Couldn't read --anchor ${anchorArg}. Use a date like 2026-10-17T09:00`);
  process.exit(1);
}

const db = getDb();
applySeed(db, readSeed()); // the clients/projects these emails file into
const account = listAccounts(db)[0];
const inbox = account?.email ?? "pulse-test@gmail.com";
const built = buildSeedMessages(anchor, inbox);

if (dryRun) {
  const dir = path.join(config.dataDir, "seed-eml");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  built.forEach((m, i) => fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(2, "0")}-${m.email.key}.eml`), m.raw));
  printTable();
  console.log(`\nDry run: wrote ${built.length} .eml files to ${dir} (open any of them in Mail to preview).`);
  process.exit(0);
}

if (!account) {
  console.error("No Gmail inbox connected. Start `npm run dev`, open http://localhost:3000 and click Connect Gmail first.");
  process.exit(1);
}
if (!(account.scope ?? "").includes(SEED_SCOPE)) {
  console.error(`
  ${account.email} hasn't granted the seeding permission yet.

  1. In Google Cloud → Google Auth Platform → Data Access, add the scope:
       ${SEED_SCOPE}
  2. With npm run dev running, open this link and approve:
       http://localhost:3000/api/auth/google?seed=1
  3. Run npm run seed:inbox again.
`);
  process.exit(1);
}

const gmail = google.gmail({ version: "v1", auth: authedClient(db, account) });

async function findExisting(messageId: string): Promise<{ id: string; threadId: string } | null> {
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: `rfc822msgid:${messageId.replace(/^<|>$/g, "")}`,
    maxResults: 1,
    includeSpamTrash: false,
  });
  const m = data.messages?.[0];
  return m?.id && m.threadId ? { id: m.id, threadId: m.threadId } : null;
}

async function main(): Promise<void> {
  const threadOf = new Map<string, string>(); // root Message-ID -> Gmail threadId
  const results: { key: string; gmail_message_id: string; thread_id: string; status: "inserted" | "already there" }[] = [];

  for (const m of built) {
    const existing = await findExisting(m.messageId);
    if (existing) {
      threadOf.set(m.messageId, existing.threadId);
      results.push({ key: m.email.key, gmail_message_id: existing.id, thread_id: existing.threadId, status: "already there" });
      continue;
    }
    const threadId = m.rootMessageId ? threadOf.get(m.rootMessageId) : undefined;
    const { data } = await gmail.users.messages.insert({
      userId: "me",
      internalDateSource: "dateHeader", // Gmail treats it as received at the backdated Date header
      requestBody: { raw: toBase64Url(m.raw), labelIds: ["INBOX", "UNREAD"], threadId },
    });
    threadOf.set(m.messageId, data.threadId!);
    results.push({ key: m.email.key, gmail_message_id: data.id!, thread_id: data.threadId!, status: "inserted" });
  }

  const run = {
    anchor: anchor.toISOString(),
    inbox: account!.email,
    seeded_at: new Date().toISOString(),
    emails: built.map((m) => ({ ...m.labels, ...results.find((r) => r.key === m.email.key) })),
  };
  const out = path.join(config.dataDir, "seed-run.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(run, null, 2));
  audit(db, "user", "seed.inbox", `gmail_account:${account!.email}`, {
    inserted: results.filter((r) => r.status === "inserted").length,
    anchor: run.anchor,
  });

  printTable(results);
  const inserted = results.filter((r) => r.status === "inserted").length;
  console.log(`\n${inserted} inserted, ${results.length - inserted} already in ${account!.email}.`);
  console.log(`Ground truth with dates and Gmail ids: ${out}`);
  console.log("With npm run worker running, they appear on the dashboard within one poll (~10 s).");
}

function printTable(results?: { key: string; status: string }[]): void {
  console.log(`\nSeed inbox · anchor ${anchor.toLocaleString()} · to ${inbox}\n`);
  for (const m of built) {
    const ago = m.email.sent_hours_ago;
    const files = m.email.attachments.map((a) => a.file.split(".").pop()).join("+") || "-";
    const trap = m.email.labels.trap ? `  TRAP: ${m.email.labels.trap.id}` : "";
    const st = results?.find((r) => r.key === m.email.key)?.status;
    console.log(
      `  ${String(ago).padStart(3)}h ago  ${m.email.labels.project_id.padEnd(22)} ${files.padEnd(5)} ${m.email.subject}${trap}${
        st ? `  [${st}]` : ""
      }`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
