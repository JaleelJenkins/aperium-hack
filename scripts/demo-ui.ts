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
    `INSERT INTO threads (gmail_thread_id, account, subject, project_id, assignment_confidence) VALUES (?, 'demo@local', ?, ?, ?)`,
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
     VALUES (?, ?, 'demo@local', ?, ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)`,
  ).run(id, threadId, from[0], from[1], subject, at(-hoursAgo), at(-hoursAgo), text.slice(0, 120), text, text, status);
}

function signal(
  id: string,
  projectId: string,
  messageId: string,
  type: string,
  text: string,
  quote: string,
  o: { due?: string | null; status?: string; verdict?: string; reviewer?: string; producer?: string } = {},
) {
  db.prepare(
    `INSERT INTO signals (id, project_id, message_id, type, text, due_at, status, evidence_json, produced_by_model,
                          review_verdict, reviewed_by_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, projectId, messageId, type, text, o.due ?? null, o.status ?? "open", msgEv(messageId, quote),
    o.producer ?? HAIKU, o.verdict ?? "pass", o.reviewer ?? SONNET, at(-1),
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
                          produced_by_model, review_verdict, reviewed_by_model, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pass', ?, ?, ?)`,
  ).run(
    id, projectId, threadId, messageId, type, JSON.stringify(payload), status, msgEv(messageId, quote),
    HAIKU, SONNET, at(-1), status === "executed" ? at(-20) : null,
  );
}

function blocked(id: string, projectId: string, messageId: string, claim: string, notes: string, by: "review" | "policy") {
  db.prepare(
    `INSERT INTO model_reviews (id, target_type, target_id, tmp_id, message_id, project_id, produced_by_model, reviewer_model,
                                blocked_by, verdict, score, notes, claim_json)
     VALUES (?, 'signal', NULL, 's1', ?, ?, ?, ?, ?, 'block', 0.1, ?, ?)`,
  ).run(id, messageId, projectId, HAIKU, by === "review" ? SONNET : null, by, notes, JSON.stringify({ text: claim }));
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
  signal("demo-s-harbor-ask", "harbor-lobby", "demo-m-harbor-2", "ask", "Send Maya the revised quote",
    "Could you send the revised quote by Friday?", { due: day(1), reviewer: OPUS });
  signal("demo-s-harbor-renders", "harbor-lobby", "demo-m-harbor-1", "our_commitment", "Share the updated lobby renders",
    "We'll share the updated lobby renders by Wednesday.", { due: day(-1) });
  signal("demo-s-harbor-oak", "harbor-lobby", "demo-m-harbor-0", "decision", "Oak finish chosen for the reception desk",
    "Let's go with the oak finish for the reception desk.");
  blocked("demo-r-harbor-floors", "harbor-lobby", "demo-m-harbor-2", "Lobby scope covers 3 floors",
    "PDF p.2 title block says Levels 1-2; the email's 'floors 1-3' is contradicted", "review");
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
    "Can you fix it before Monday standup?", { due: day(2), verdict: "revise", reviewer: OPUS });
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
    "'Next Friday' is from a forward dated 3 weeks ago; resolves to a past date", "review");
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
    "Client only said they'll review it with the board; no acceptance in the thread", "review");
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
    "Recipient is not a known contact on this thread", "policy");
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
})();

const n = (t: string, col = "id") =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} LIKE 'demo-%'`).get() as { n: number }).n;
console.log(
  `Loaded demo board: ${n("messages", "gmail_message_id")} messages, ${n("signals")} signals, ${n("actions")} actions, ${n("model_reviews")} blocked claims.`,
);
