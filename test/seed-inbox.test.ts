import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { gmail_v1 } from "googleapis";
import { describe, expect, it } from "vitest";
import { SEED_EMAILS } from "../seed/emails";
import { openDb } from "../src/lib/db";
import { syncAccount } from "../src/lib/ingest/sync";
import { applySeed, readSeed } from "../src/lib/seed";
import { buildSeedMessages, encodeHeader, rfc2822Date, SEED_ASSETS_DIR } from "../src/lib/seed-inbox";
import { labelsFile } from "../src/lib/seed-labels";
import { b64url, FakeGmail } from "./helpers";

const ANCHOR = new Date("2026-10-17T12:00:00-07:00");
const INBOX = "pulse-test@gmail.com";

/** Minimal MIME → Gmail "format=full" payload, enough for the messages we generate. */
function toGmailMessage(raw: string, id: string, threadId: string, internalDate: number): gmail_v1.Schema$Message {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  const headers = head.split("\r\n").map((l) => {
    const i = l.indexOf(":");
    return { name: l.slice(0, i), value: l.slice(i + 1).trim() };
  });
  const ctype = headers.find((h) => h.name === "Content-Type")?.value ?? "text/plain";
  const leaf = (partId: string, hdrs: { name: string; value: string }[], content: string): gmail_v1.Schema$MessagePart => {
    const ct = hdrs.find((h) => h.name === "Content-Type")!.value;
    const bytes = Buffer.from(content.replace(/\r\n/g, ""), "base64");
    const filename = /filename="([^"]+)"/.exec(hdrs.find((h) => h.name === "Content-Disposition")?.value ?? "")?.[1] ?? "";
    return {
      partId,
      mimeType: ct.split(";")[0],
      filename,
      headers: hdrs,
      body: filename
        ? { size: bytes.length, attachmentId: `att-${id}-${partId}` }
        : { size: bytes.length, data: b64url(bytes) },
    };
  };

  let payload: gmail_v1.Schema$MessagePart;
  if (ctype.startsWith("multipart/")) {
    const boundary = /boundary="([^"]+)"/.exec(ctype)![1];
    const parts = body
      .split(`--${boundary}`)
      .slice(1, -1)
      .map((p, i) => {
        const [ph, ...pb] = p.replace(/^\r\n/, "").split("\r\n\r\n");
        const phs = ph.split("\r\n").map((l) => ({ name: l.slice(0, l.indexOf(":")), value: l.slice(l.indexOf(":") + 1).trim() }));
        return leaf(String(i), phs, pb.join("\r\n\r\n"));
      });
    payload = { partId: "", mimeType: ctype.split(";")[0], filename: "", headers, body: { size: 0 }, parts };
  } else {
    const ctHeaders = headers.filter((h) => h.name.startsWith("Content-"));
    payload = { ...leaf("", ctHeaders, body), headers };
  }
  return { id, threadId, labelIds: ["INBOX", "UNREAD"], internalDate: String(internalDate), snippet: "", payload };
}

describe("seed inbox content", () => {
  const built = buildSeedMessages(ANCHOR, INBOX);

  it("has 15 emails across all 5 seeded projects, with the 4 PRD traps", () => {
    const seed = readSeed();
    expect(built).toHaveLength(15);
    expect(new Set(built.map((m) => m.labels.project_id))).toEqual(new Set(seed.projects.map((p) => p.id)));
    expect(built.flatMap((m) => (m.labels.trap ? [m.labels.trap.id] : [])).sort()).toEqual(
      ["invoice-redirect", "pdf-contradicts-email", "stale-next-friday", "unaccepted-quote"].sort(),
    );
    expect(built.filter((m) => m.email.attachments.some((a) => a.contentType === "application/pdf")).length).toBeGreaterThanOrEqual(4);
    expect(built.filter((m) => m.email.attachments.some((a) => a.contentType.startsWith("image/"))).length).toBeGreaterThanOrEqual(4);
  });

  it("every sender resolves to the labeled project's client (domain, or contact for free-mail)", () => {
    const seed = readSeed();
    for (const e of SEED_EMAILS) {
      const client = seed.projects.find((p) => p.id === e.labels.project_id)!.client_id;
      const c = seed.clients.find((x) => x.id === client)!;
      const domain = e.from.email.split("@")[1];
      const byContact = c.contacts.some((ct) => ct.email.toLowerCase() === e.from.email);
      expect(c.domains.includes(domain) || byContact, `${e.key} from ${e.from.email}`).toBe(true);
    }
  });

  it("references only assets that exist, and replies only to earlier emails", () => {
    for (const e of SEED_EMAILS) {
      for (const a of e.attachments) expect(fs.existsSync(path.join(SEED_ASSETS_DIR, a.file)), a.file).toBe(true);
      if (e.reply_to) {
        const root = SEED_EMAILS.find((x) => x.key === e.reply_to)!;
        expect(root.sent_hours_ago).toBeGreaterThan(e.sent_hours_ago);
      }
    }
  });

  it("renders body dates from the same offsets the labels use", () => {
    const pilot = built.find((m) => m.email.key === "vector-02-pilot-moved")!;
    expect(pilot.labels.deadlines.map((d) => d.due_at)).toEqual(["2026-10-21", "2026-10-23"]);
    const text = Buffer.from(pilot.raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();
    expect(text).toContain("Friday, Oct 23");
    expect(text).toContain("Wednesday, Oct 21");
  });

  it("seed/labels.json is in sync with seed/emails.ts (run npm run seed:labels)", () => {
    expect(JSON.parse(fs.readFileSync("seed/labels.json", "utf8"))).toEqual(JSON.parse(JSON.stringify(labelsFile())));
  });

  it("formats headers per RFC 2822 / 2047", () => {
    expect(encodeHeader("Lobby redesign: plan")).toBe("Lobby redesign: plan");
    expect(encodeHeader("Café")).toBe("=?UTF-8?B?Q2Fmw6k=?=");
    expect(rfc2822Date(new Date(2026, 9, 17, 9, 5, 7))).toMatch(/^Sat, 17 Oct 2026 09:05:07 [+-]\d{4}$/);
  });
});

describe("seed inbox through the real ingest pipeline", () => {
  it("ingests all 15 with intact attachments, threads, cleaned bodies and visible traps", async () => {
    const built = buildSeedMessages(ANCHOR, INBOX);
    const db = openDb(":memory:");
    applySeed(db, readSeed());
    db.prepare(`INSERT INTO gmail_accounts (email, refresh_token) VALUES (?, 'rt')`).run(INBOX);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-seed-"));

    // Bootstrap with nothing, then deliver the seed set through history, as Gmail would after insert.
    const gmail = new FakeGmail();
    await syncAccount(db, gmail, INBOX, { dataDir });
    const threadOf = new Map<string, string>();
    for (const [i, m] of built.entries()) {
      const id = `g${i}`;
      const threadId = m.rootMessageId ? threadOf.get(m.rootMessageId)! : `t${i}`;
      threadOf.set(m.messageId, threadId);
      const msg = toGmailMessage(m.raw, id, threadId, m.date.getTime());
      for (const [pi, a] of m.email.attachments.entries()) {
        gmail.attachments.set(`att-${id}-${pi + 1}`, fs.readFileSync(path.join(SEED_ASSETS_DIR, a.file)));
      }
      gmail.deliver(msg);
    }
    const r = await syncAccount(db, gmail, INBOX, { dataDir });
    expect(r.failed).toEqual([]);
    expect(r.newEmailIds).toHaveLength(15);

    // Attachments: every PDF and image stored, byte-identical to the asset.
    const atts = db.prepare(`SELECT filename, kind, status, sha256 FROM attachments ORDER BY filename`).all() as {
      filename: string;
      kind: string;
      status: string;
      sha256: string;
    }[];
    expect(atts).toHaveLength(SEED_EMAILS.reduce((n, e) => n + e.attachments.length, 0));
    for (const a of atts) {
      expect(a.status, a.filename).toBe("stored");
      const want = crypto.createHash("sha256").update(fs.readFileSync(path.join(SEED_ASSETS_DIR, a.filename))).digest("hex");
      expect(a.sha256, a.filename).toBe(want);
    }

    const clean = (subject: string) =>
      (db.prepare(`SELECT clean_text FROM messages WHERE subject = ?`).get(subject) as { clean_text: string }).clean_text;

    // Trap 1 claim is in the email body (Reason will be tempted); quoted history is stripped from replies.
    expect(clean("Lobby redesign: marked-up floor plan")).toContain("all three floors");
    const reply = clean("Re: Lobby redesign: marked-up floor plan");
    expect(reply).toContain("terrazzo option B");
    expect(reply).not.toContain("all three floors");
    // Trap 2: forwarded content survives cleaning, with the old Date line that disproves "next Friday".
    const fwd = clean("Fwd: Pilot go-live");
    expect(fwd).toContain("next Friday");
    expect(fwd).toMatch(/Date: .*2026/);
    // Signatures stripped, content kept.
    expect(clean("Route dashboard: map not loading, ETAs frozen")).not.toContain("Head of Operations");
    expect(clean("Website refresh: a few more pages?")).not.toContain("Sent from my iPhone");

    // Replies landed in their root's thread.
    const threads = db.prepare(`SELECT COUNT(DISTINCT thread_id) AS n FROM messages`).get() as { n: number };
    expect(threads.n).toBe(13);
    const sent = db.prepare(`SELECT received_at FROM messages WHERE subject = 'Website refresh: a few more pages?'`).get() as {
      received_at: string;
    };
    expect(Date.parse(sent.received_at)).toBe(ANCHOR.getTime() - 70 * 3_600_000);
  });
});
