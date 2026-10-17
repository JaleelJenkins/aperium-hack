/**
 * DEV ONLY: fills the board with the PRD's demo story so the frontend can be built
 * before the Reason/Review pipeline exists. Every row id starts with "demo-".
 *
 *   npm run demo:ui            load (replaces earlier demo rows)
 *   npm run demo:ui -- --clear remove demo rows only
 *   npm run db:reset           wipes them along with everything else
 *
 * Refuses to run when real ingested mail is present (pass --force to override),
 * so demo rows never mix with the live inbox on demo day.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import fs from "node:fs";
import path from "node:path";
import { config } from "../src/lib/config";
import { getDb } from "../src/lib/db";
import { applySeed, readSeed } from "../src/lib/seed";

const db = getDb();
const clearOnly = process.argv.includes("--clear");
const force = process.argv.includes("--force");

const real = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE gmail_message_id NOT LIKE 'demo-%'`).get() as { n: number }).n;
if (real > 0 && !force && !clearOnly) {
  console.error(`Refusing: ${real} real ingested messages present. Use --force to add demo rows anyway.`);
  process.exit(1);
}

function clear() {
  db.exec(`DELETE FROM model_reviews WHERE id LIKE 'demo-%';
           DELETE FROM actions       WHERE id LIKE 'demo-%';
           DELETE FROM insights      WHERE id LIKE 'demo-%';
           DELETE FROM signals       WHERE id LIKE 'demo-%';
           DELETE FROM attachments   WHERE id LIKE 'demo-%';
           DELETE FROM messages      WHERE gmail_message_id LIKE 'demo-%';
           DELETE FROM threads       WHERE gmail_thread_id LIKE 'demo-%';`);
  fs.rmSync(path.join(config.dataDir, "attachments", "demo"), { recursive: true, force: true });
}

if (clearOnly) {
  clear();
  console.log("Removed demo rows.");
  process.exit(0);
}

applySeed(db, readSeed());

const NOW = Date.now();
const at = (hours: number) => new Date(NOW + hours * 3600_000).toISOString();
const day = (days: number) => at(days * 24).slice(0, 10);
const longDate = (days: number) =>
  new Date(NOW + days * 86400_000).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const msgEv = (message_id: string, quote: string) => JSON.stringify([{ kind: "message", message_id, quote }]);

const HAIKU = "claude-haiku";
const SONNET = "claude-sonnet";
const OPUS = "claude-opus";

function thread(id: string, projectId: string | null, subject: string, confidence: number | null) {
  db.prepare(
    `INSERT INTO threads (gmail_thread_id, account, subject, project_id, assignment_confidence) VALUES (?, 'pulse.demo@gmail.com', ?, ?, ?)`,
  ).run(id, subject, projectId, confidence);
}

function message(
  id: string,
  threadId: string,
  from: [string, string],
  subject: string,
  hoursAgo: number,
  text: string,
  status = "reviewed",
) {
  db.prepare(
    `INSERT INTO messages (gmail_message_id, thread_id, account, sender_name, sender_email, subject, sent_at, received_at,
                           snippet, body_source, raw_text, clean_text, status)
     VALUES (?, ?, 'pulse.demo@gmail.com', ?, ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)`,
  ).run(id, threadId, from[0], from[1], subject, at(-hoursAgo), at(-hoursAgo), text.slice(0, 120), text, text, status);
}

function signal(
  id: string,
  projectId: string,
  messageId: string,
  type: string,
  text: string,
  quote: string,
  o: {
    due?: string | null; status?: string; verdict?: string; reviewer?: string; producer?: string;
    score?: number; reason?: string; original?: string; evidence?: string;
  } = {},
) {
  const verdict = o.verdict ?? "pass";
  db.prepare(
    `INSERT INTO signals (id, project_id, message_id, type, text, original_text, due_at, status, evidence_json, produced_by_model,
                          review_verdict, reviewed_by_model, review_score, review_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, projectId, messageId, type, text, o.original ?? null, o.due ?? null, o.status ?? "open", o.evidence ?? msgEv(messageId, quote),
    o.producer ?? HAIKU, verdict, o.reviewer ?? SONNET, o.score ?? (verdict === "pass" ? 0.94 : 0.71), o.reason ?? null, at(-1),
  );
}

function action(
  id: string,
  projectId: string | null,
  threadId: string,
  messageId: string,
  type: "draft_reply" | "internal_task" | "new_project",
  payload: object,
  quote: string,
  status = "proposed",
) {
  db.prepare(
    `INSERT INTO actions (id, project_id, thread_id, message_id, type, payload_json, status, evidence_json,
                          produced_by_model, review_verdict, reviewed_by_model, review_score, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pass', ?, 0.92, ?, ?)`,
  ).run(
    id, projectId, threadId, messageId, type, JSON.stringify(payload), status, msgEv(messageId, quote),
    HAIKU, SONNET, at(-1), status === "executed" ? at(-20) : null,
  );
}

function blocked(
  id: string,
  projectId: string,
  messageId: string,
  claim: string,
  notes: string,
  by: "review" | "policy",
  conflicting: object[] = [],
) {
  db.prepare(
    `INSERT INTO model_reviews (id, target_type, target_id, tmp_id, message_id, project_id, produced_by_model, reviewer_model,
                                blocked_by, verdict, score, notes, claim_json, conflicting_evidence_json)
     VALUES (?, 'signal', NULL, 's1', ?, ?, ?, ?, ?, 'block', 0.08, ?, ?, ?)`,
  ).run(
    id, messageId, projectId, HAIKU, by === "review" ? SONNET : null, by, notes, JSON.stringify({ text: claim }), JSON.stringify(conflicting),
  );
}

/**
 * Minimal valid PDF (Helvetica text + vector boxes), so the demo has a real floor plan the
 * evidence drawer can open at a page. No dependencies; ASCII text only.
 */
function makePdf(pages: { title: string; lines: string[]; draw: string }[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => "\\" + c);
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((p, i) => {
    const text = ["BT", "/F1 20 Tf", "56 736 Td", `(${esc(p.title)}) Tj`, "/F1 11 Tf"]
      .concat(p.lines.flatMap((l) => ["0 -18 Td", `(${esc(l)}) Tj`]))
      .concat(["ET"])
      .join("\n");
    const stream = `${p.draw}\n${text}`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let k = 1; k < objs.length; k++) {
    offsets[k] = Buffer.byteLength(out);
    out += `${k} 0 obj\n${objs[k]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objs.length; k++) out += `${String(offsets[k]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function attachmentPdf(id: string, messageId: string, filename: string, pages: { title: string; lines: string[]; draw: string }[]) {
  const rel = path.join("attachments", "demo", filename);
  const abs = path.join(config.dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const bytes = makePdf(pages);
  fs.writeFileSync(abs, bytes);
  const pageText = pages.map((p) => [p.title, ...p.lines].join("\n"));
  db.prepare(
    `INSERT INTO attachments (id, message_id, part_id, filename, mime_type, size, kind, storage_path, status, extracted_text, meta_json)
     VALUES (?, ?, '1', ?, 'application/pdf', ?, 'pdf', ?, 'stored', ?, ?)`,
  ).run(id, messageId, filename, bytes.length, rel.split(path.sep).join("/"), pageText.join("\n\f\n"), JSON.stringify({ pages: pages.length, pageText }));
}

db.transaction(() => {
  clear();

  // ---------------------------------------------------------- Harbor & Pine: Lobby redesign
  thread("demo-t-harbor", "harbor-lobby", "Lobby redesign: marked-up floor plan", 0.96);
  message("demo-m-harbor-0", "demo-t-harbor", ["Maya Chen", "maya@harborpine.com"], "Lobby redesign: finishes", 190,
    "Hi team,\n\nLet's go with the oak finish for the reception desk.\n\nMaya");
  message("demo-m-harbor-1", "demo-t-harbor", ["Ops (us)", "pulse.demo@gmail.com"], "Re: Lobby redesign: finishes", 150,
    "Thanks Maya.\n\nWe'll share the updated lobby renders by Wednesday.\n\nBest,\nOps");
  message("demo-m-harbor-2", "demo-t-harbor", ["Maya Chen", "maya@harborpine.com"], "Lobby redesign: marked-up floor plan", 70,
    "Hi team,\n\nAttached is the marked-up floor plan for the lobby.\nThe lobby work covers floors 1-3, per our call.\nCould you send the revised quote by Friday?\n\nThanks,\nMaya");
  attachmentPdf("demo-att-floorplan", "demo-m-harbor-2", "Lobby_FloorPlan.pdf", [
    {
      title: "Harbor & Pine: Lobby redesign",
      lines: ["Sheet A-101  Marked-up floor plan, rev 2", "Client markup: M. Chen"],
      draw: "0.5 w 0.35 G 56 120 500 520 re S 56 380 m 556 380 l S 300 120 m 300 380 l S",
    },
    {
      title: "Sheet A-102  Lobby scope",
      lines: ["Scope: Levels 1-2", "Level 3 is out of scope (tenant fit-out by others)."],
      draw: "0.5 w 0.35 G 56 120 500 240 re S 56 380 500 240 re S 1 0 0 RG 2 w 50 704 140 22 re S",
    },
  ]);
  const pdfP2 = { kind: "attachment_page", attachment_id: "demo-att-floorplan", page: 2, quote: "Scope: Levels 1-2" };
  signal("demo-s-harbor-ask", "harbor-lobby", "demo-m-harbor-2", "ask", "Send Maya the revised quote",
    "Could you send the revised quote by Friday?", { due: day(1), reviewer: OPUS, score: 0.97 });
  signal("demo-s-harbor-scope", "harbor-lobby", "demo-m-harbor-2", "risk",
    "Email says floors 1-3 but the floor plan scopes Levels 1-2: confirm with Maya before quoting",
    "", {
      reviewer: OPUS, score: 0.91,
      evidence: JSON.stringify([pdfP2, { kind: "message", message_id: "demo-m-harbor-2", quote: "The lobby work covers floors 1-3, per our call." }]),
    });
  signal("demo-s-harbor-renders", "harbor-lobby", "demo-m-harbor-1", "our_commitment", "Share the updated lobby renders",
    "We'll share the updated lobby renders by Wednesday.", { due: day(-1) });
  signal("demo-s-harbor-oak", "harbor-lobby", "demo-m-harbor-0", "decision", "Oak finish chosen for the reception desk",
    "Let's go with the oak finish for the reception desk.");
  blocked("demo-r-harbor-floors", "harbor-lobby", "demo-m-harbor-2", "Update project scope to cover 3 floors per client email.",
    "Contradicts authoritative attachment: Lobby_FloorPlan.pdf (page 2) scopes Levels 1-2 only.", "review", [pdfP2]);
  action("demo-a-harbor-reply", "harbor-lobby", "demo-t-harbor", "demo-m-harbor-2", "draft_reply",
    { to: ["maya@harborpine.com"], subject: "Re: Lobby redesign: marked-up floor plan", body: "Hi Maya, the revised quote will be with you by Friday." },
    "Could you send the revised quote by Friday?");
  db.prepare(`UPDATE projects SET last_contact_at = ? WHERE id = 'harbor-lobby'`).run(at(-70));

  // ---------------------------------------------------------- Vector Freight: Route dashboard
  thread("demo-t-route", "vector-route-dashboard", "Map not loading on route dashboard", 0.91);
  message("demo-m-route-1", "demo-t-route", ["Jon Park", "jon@vectorfreight.io"], "Map not loading on route dashboard", 3,
    "Hey,\n\nThe map is not loading on the route dashboard since this morning (screenshot attached).\nCan you fix it before Monday standup?\nI'll send a HAR file from the ops laptop tomorrow.\n\nJon");
  message("demo-m-route-2", "demo-t-route", ["Jon Park", "jon@vectorfreight.io"], "Re: Map not loading on route dashboard", 0.02,
    "Adding a second screenshot from the dispatcher view.", "extracted");
  signal("demo-s-route-fix", "vector-route-dashboard", "demo-m-route-1", "ask", "Fix the map not loading on the route dashboard",
    "Can you fix it before Monday standup?", {
      due: day(2), verdict: "revise", reviewer: OPUS, score: 0.74,
      original: "Fix the route dashboard map by Friday",
      reason: "Client asked for a fix 'before Monday standup', not by Friday; due date corrected.",
    });
  signal("demo-s-route-har", "vector-route-dashboard", "demo-m-route-1", "their_commitment", "Jon sends a HAR file from the ops laptop",
    "I'll send a HAR file from the ops laptop tomorrow.", { due: day(1) });
  action("demo-a-route-task", "vector-route-dashboard", "demo-t-route", "demo-m-route-1", "internal_task",
    { title: "Reproduce the map loading bug from the screenshot", notes: "" }, "The map is not loading on the route dashboard");
  db.prepare(`UPDATE projects SET last_contact_at = ? WHERE id = 'vector-route-dashboard'`).run(at(-0.02));

  // ---------------------------------------------------------- Vector Freight: Driver app pilot
  thread("demo-t-pilot", "vector-driver-pilot", "Pilot date", 0.88);
  message("demo-m-pilot-1", "demo-t-pilot", ["Jon Park", "jon@vectorfreight.io"], "Pilot date", 26,
    `Hi,\n\nWe need to move the pilot up a week, to ${longDate(5)}.\nWe still owe you the list of pilot drivers.\n\nJon`);
  signal("demo-s-pilot-date", "vector-driver-pilot", "demo-m-pilot-1", "deadline", `Pilot go-live moved up a week to ${longDate(5)}`,
    "We need to move the pilot up a week", { due: day(5) });
  signal("demo-s-pilot-drivers", "vector-driver-pilot", "demo-m-pilot-1", "their_commitment", "Vector sends the list of pilot drivers",
    "We still owe you the list of pilot drivers.", { due: day(-2) });
  blocked("demo-r-pilot-friday", "vector-driver-pilot", "demo-m-pilot-1", "Pilot deadline is next Friday",
    "'Next Friday' comes from a forward dated 3 weeks ago; it resolves to a date already past.", "review",
    [{ kind: "message", message_id: "demo-m-pilot-1", quote: "We need to move the pilot up a week" }]);
  db.prepare(`UPDATE projects SET last_contact_at = ? WHERE id = 'vector-driver-pilot'`).run(at(-26));

  // ---------------------------------------------------------- Lumen Clinic: Website refresh
  thread("demo-t-web", "lumen-website", "Website refresh: extra pages", 0.93);
  message("demo-m-web-1", "demo-t-web", ["Dr. Ana Ruiz", "ana@lumenclinic.com"], "Website refresh: extra pages", 50,
    "Hello,\n\nWe'd also like four extra service pages added to the refresh.\nWhat would those cost? Please confirm by Thursday.\nThanks for the quote, we'll review it with the board.\n\nAna");
  signal("demo-s-web-scope", "lumen-website", "demo-m-web-1", "risk", "Scope change: four extra service pages requested",
    "We'd also like four extra service pages added to the refresh.");
  signal("demo-s-web-cost", "lumen-website", "demo-m-web-1", "ask", "Confirm the cost of the extra pages",
    "What would those cost? Please confirm by Thursday.", { due: day(4) });
  blocked("demo-r-web-quote", "lumen-website", "demo-m-web-1", "Client approved the quote",
    "No acceptance in the thread: the client only said they'll review the quote with the board.", "review",
    [{ kind: "message", message_id: "demo-m-web-1", quote: "Thanks for the quote, we'll review it with the board." }]);
  action("demo-a-web-sent", "lumen-website", "demo-t-web", "demo-m-web-1", "draft_reply",
    { to: ["ana@lumenclinic.com"], subject: "Re: Website refresh timeline", body: "…" },
    "Thanks for the quote, we'll review it with the board.", "executed");
  db.prepare(`UPDATE projects SET last_contact_at = ? WHERE id = 'lumen-website'`).run(at(-50));

  // ---------------------------------------------------------- Lumen Clinic: Booking integration
  thread("demo-t-booking", "lumen-booking", "Booking integration: billing", 0.9);
  message("demo-m-booking-0", "demo-t-booking", ["Ops (us)", "pulse.demo@gmail.com"], "Booking integration: wireframes", 240,
    "Hi all,\n\nAttached are the booking flow wireframes we promised.\n\nOps");
  message("demo-m-booking-1", "demo-t-booking", ["Lumen Accounts", "accounts@lumenclinic.com"], "Booking integration: billing", 8,
    "Hi,\n\nPlease send all invoices to billing@lumen-payments.co from now on.\nWe'll provide the scheduling API credentials next week.\n\nAccounts");
  signal("demo-s-booking-invoice", "lumen-booking", "demo-m-booking-1", "risk",
    "Request to redirect invoices to an unknown address (billing@lumen-payments.co)",
    "Please send all invoices to billing@lumen-payments.co from now on.", { reviewer: OPUS });
  signal("demo-s-booking-creds", "lumen-booking", "demo-m-booking-1", "their_commitment", "Lumen provides the scheduling API credentials",
    "We'll provide the scheduling API credentials next week.", { due: day(6) });
  signal("demo-s-booking-wire", "lumen-booking", "demo-m-booking-0", "our_commitment", "Share the booking flow wireframes",
    "Attached are the booking flow wireframes we promised.", { status: "done" });
  blocked("demo-r-booking-invoice", "lumen-booking", "demo-m-booking-1", "Draft reply to billing@lumen-payments.co",
    "Recipient is not a known contact on this thread; invoice rerouting is quarantined as high risk.", "policy",
    [{ kind: "message", message_id: "demo-m-booking-1", quote: "Please send all invoices to billing@lumen-payments.co from now on." }]);
  db.prepare(`UPDATE projects SET health = 'at_risk', last_contact_at = ? WHERE id = 'lumen-booking'`).run(at(-8));

  // ---------------------------------------------------------- Unassigned: needs triage
  thread("demo-t-new-1", null, "Patient portal idea", 0.42);
  message("demo-m-new-1", "demo-t-new-1", ["Priya Shah", "priya@lumenclinic.com"], "Patient portal idea", 5,
    "Hi,\n\nWe're thinking about a patient portal next quarter. Could we get on a call?\n\nPriya", "resolved");
  action("demo-a-new-project", null, "demo-t-new-1", "demo-m-new-1", "new_project",
    { suggested_name: "Patient portal", candidates: ["lumen-website", "lumen-booking"] }, "We're thinking about a patient portal next quarter.");
  thread("demo-t-new-2", null, "Quick question", null);
  message("demo-m-new-2", "demo-t-new-2", ["Sam Ortiz", "sam.ortiz@gmail.com"], "Quick question about a microsite", 1,
    "Hi, a friend recommended you. Do you build microsites?", "ingested");

  // Review time = shortly after each source email; the floor-plan trap is the newest, so it leads the vault.
  const reviewedAt = db.prepare(`UPDATE model_reviews SET at = ? WHERE id = ?`);
  reviewedAt.run(at(-0.3), "demo-r-harbor-floors");
  reviewedAt.run(at(-7.9), "demo-r-booking-invoice");
  reviewedAt.run(at(-25.9), "demo-r-pilot-friday");
  reviewedAt.run(at(-49.9), "demo-r-web-quote");
})();

const n = (t: string, col = "id") =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} LIKE 'demo-%'`).get() as { n: number }).n;
console.log(
  `Loaded demo board: ${n("messages", "gmail_message_id")} messages, ${n("signals")} signals, ${n("actions")} actions, ${n("model_reviews")} blocked claims.`,
);
