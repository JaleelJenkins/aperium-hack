import { describe, expect, it } from "vitest";
import { getBoard } from "../src/lib/board";
import { openDb, type DB } from "../src/lib/db";
import { inspect } from "../src/lib/inspect";
import { dismissInsight, evaluateRules, healthFrom, runInsights } from "../src/lib/pipeline/insights";
import { applySeed, readSeed } from "../src/lib/seed";
import { approveAction } from "../src/lib/approvals";
import { runExecutor } from "../src/lib/pipeline/execute";

const NOW = new Date("2026-10-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
const ev = (message_id: string) => JSON.stringify([{ kind: "message", message_id, quote: "Hi team" }]);
const ME = "inbox@agency.com";

function db0(): DB {
  const db = openDb(":memory:");
  applySeed(db, readSeed());
  return db;
}

function mail(db: DB, id: string, thread: string, project: string, from: string, receivedAt: string, labels = ["INBOX"]) {
  db.prepare(`INSERT OR IGNORE INTO threads (gmail_thread_id, account, project_id) VALUES (?, ?, ?)`).run(thread, ME, project);
  db.prepare(
    `INSERT INTO messages (gmail_message_id, thread_id, account, sender_email, subject, received_at, label_ids, body_source, raw_text, clean_text, status)
     VALUES (?, ?, ?, ?, 'S', ?, ?, 'text/plain', 'Hi team', 'Hi team', 'reviewed')`,
  ).run(id, thread, ME, from, receivedAt, JSON.stringify(labels));
}

function signal(db: DB, id: string, project: string, message: string, type: string, text: string, due: string | null, status = "open") {
  db.prepare(
    `INSERT INTO signals (id, project_id, message_id, type, text, due_at, status, evidence_json, produced_by_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claude-haiku')`,
  ).run(id, project, message, type, text, due, status, ev(message));
}

const health = (db: DB, id: string) => (db.prepare(`SELECT health FROM projects WHERE id = ?`).get(id) as { health: string }).health;
const openInsights = (db: DB) =>
  db.prepare(`SELECT kind, severity, project_id FROM insights WHERE status = 'open' ORDER BY kind`).all() as { kind: string; severity: string; project_id: string }[];

describe("insight rules", () => {
  it("flags a client ask with no reply after the SLA, and not before", () => {
    const db = db0();
    mail(db, "m-old", "t1", "harbor-lobby", "dana@harborpine.com", hoursAgo(30));
    mail(db, "m-new", "t2", "harbor-lobby", "dana@harborpine.com", hoursAgo(3));
    signal(db, "ask-old", "harbor-lobby", "m-old", "ask", "Confirm the revised fee", null);
    signal(db, "ask-new", "harbor-lobby", "m-new", "ask", "Send the lighting concept", null);

    const hits = evaluateRules(db, NOW);
    expect(hits.map((h) => h.key)).toEqual(["unanswered_ask:ask-old"]);
    expect(hits[0].severity).toBe("medium");
    expect(hits[0].text).toContain("30h");
  });

  it("a reply from us in the thread clears the unanswered ask", () => {
    const db = db0();
    mail(db, "m1", "t1", "harbor-lobby", "dana@harborpine.com", hoursAgo(30));
    signal(db, "ask", "harbor-lobby", "m1", "ask", "Confirm the fee", null);
    runInsights(db, { now: NOW });
    expect(openInsights(db)).toHaveLength(1);

    mail(db, "m2", "t1", "harbor-lobby", ME, hoursAgo(1), ["SENT"]);
    const r = runInsights(db, { now: NOW });
    expect(r.resolved).toBe(1);
    expect(openInsights(db)).toHaveLength(0);
    expect(health(db, "harbor-lobby")).toBe("on_track");
  });

  it("an ask past its due date is high severity and blocks the project", () => {
    const db = db0();
    mail(db, "m1", "t1", "vector-route-dashboard", "ops@vectorfreight.io", hoursAgo(40));
    signal(db, "ask", "vector-route-dashboard", "m1", "ask", "Fix the map bug", hoursAgo(2));
    runInsights(db, { now: NOW });
    const kinds = openInsights(db);
    expect(kinds.find((k) => k.kind === "unanswered_ask")?.severity).toBe("high");
    expect(health(db, "vector-route-dashboard")).toBe("blocked");
  });

  it("deadline within 48h with no commitment from us; a later commitment clears it", () => {
    const db = db0();
    mail(db, "m1", "t1", "harbor-lobby", "dana@harborpine.com", hoursAgo(5));
    signal(db, "dl", "harbor-lobby", "m1", "deadline", "Revised scope due", inHours(36));
    signal(db, "dl-far", "harbor-lobby", "m1", "deadline", "Samples due", inHours(24 * 5));

    let hits = evaluateRules(db, NOW).filter((h) => h.kind === "deadline_no_commitment");
    expect(hits.map((h) => h.signalId)).toEqual(["dl"]);
    expect(hits[0].severity).toBe("medium");

    mail(db, "m2", "t1", "harbor-lobby", "dana@harborpine.com", hoursAgo(1));
    signal(db, "ours", "harbor-lobby", "m2", "our_commitment", "We'll send the scope Thursday", inHours(30));
    hits = evaluateRules(db, NOW).filter((h) => h.kind === "deadline_no_commitment");
    expect(hits).toHaveLength(0);
  });

  it("deadline inside 24h is high", () => {
    const db = db0();
    mail(db, "m1", "t1", "harbor-lobby", "dana@harborpine.com", hoursAgo(5));
    signal(db, "dl", "harbor-lobby", "m1", "deadline", "Confirm fee", inHours(10));
    expect(evaluateRules(db, NOW).find((h) => h.kind === "deadline_no_commitment")?.severity).toBe("high");
  });

  it("our commitment past due is overdue and high", () => {
    const db = db0();
    mail(db, "m1", "t1", "lumen-booking", "priya@lumenclinic.com", hoursAgo(40));
    signal(db, "c", "lumen-booking", "m1", "our_commitment", "Fix the double-booking bug", hoursAgo(24 * 8));
    signal(db, "c-done", "lumen-booking", "m1", "our_commitment", "Old promise", hoursAgo(24 * 9), "done");
    const hits = evaluateRules(db, NOW).filter((h) => h.kind === "overdue_commitment");
    expect(hits.map((h) => h.signalId)).toEqual(["c"]);
    expect(hits[0].text).toContain("8 days late");
    runInsights(db, { now: NOW });
    expect(health(db, "lumen-booking")).toBe("blocked");
  });

  it("is idempotent, audits each change, and keeps a dismissal", () => {
    const db = db0();
    mail(db, "m1", "t1", "harbor-lobby", "dana@harborpine.com", hoursAgo(30));
    signal(db, "ask", "harbor-lobby", "m1", "ask", "Confirm the fee", null);

    const first = runInsights(db, { now: NOW });
    expect(first.opened).toBe(1);
    expect(first.health).toEqual([{ project: "harbor-lobby", from: "on_track", to: "at_risk" }]);
    const second = runInsights(db, { now: NOW });
    expect(second).toEqual({ opened: 0, updated: 0, resolved: 0, health: [] });

    const id = (db.prepare(`SELECT id FROM insights`).get() as { id: string }).id;
    expect(dismissInsight(db, id, "user", "Answered on a call")).toBe(true);
    runInsights(db, { now: NOW });
    expect(openInsights(db)).toHaveLength(0);
    expect(health(db, "harbor-lobby")).toBe("on_track");

    const verbs = (db.prepare(`SELECT verb FROM audit_events WHERE verb != 'seed.applied' ORDER BY id`).all() as { verb: string }[]).map((r) => r.verb);
    expect(verbs).toEqual(["insight.opened", "project.health_changed", "insight.dismissed", "project.health_changed"]);
  });

  it("doesn't duplicate an insight Reason already raised from the same email", () => {
    const db = db0();
    mail(db, "m1", "t1", "harbor-lobby", "dana@harborpine.com", hoursAgo(30));
    signal(db, "ask", "harbor-lobby", "m1", "ask", "Confirm the fee", null);
    db.prepare(
      `INSERT INTO insights (id, project_id, kind, severity, text, status, evidence_json, produced_by_model)
       VALUES ('model-i', 'harbor-lobby', 'unanswered_ask', 'medium', 'Dana is waiting', 'open', ?, 'claude-haiku')`,
    ).run(ev("m1"));
    expect(runInsights(db, { now: NOW }).opened).toBe(0);
    expect(health(db, "harbor-lobby")).toBe("at_risk"); // the model insight still counts
  });

  it("health: high -> blocked, medium -> at risk, otherwise on track", () => {
    expect(healthFrom([])).toBe("on_track");
    expect(healthFrom(["low"])).toBe("on_track");
    expect(healthFrom(["low", "medium"])).toBe("at_risk");
    expect(healthFrom(["medium", "high"])).toBe("blocked");
  });
});

describe("insights and the action queue", () => {
  it("approving an internal task turns it into a commitment and clears the deadline insight", async () => {
    const db = db0();
    mail(db, "m1", "t1", "harbor-lobby", "dana@harborpine.com", hoursAgo(5));
    // Real clock here: runExecutor recomputes insights at the current time.
    const due = new Date(Date.now() + 30 * 3600_000).toISOString();
    signal(db, "dl", "harbor-lobby", "m1", "deadline", "Revised scope due", due);
    db.prepare(
      `INSERT INTO actions (id, project_id, thread_id, message_id, type, payload_json, status, evidence_json, produced_by_model)
       VALUES ('task', 'harbor-lobby', 't1', 'm1', 'internal_task', ?, 'proposed', ?, 'claude-haiku')`,
    ).run(JSON.stringify({ title: "Send Dana the revised scope", notes: "" }), ev("m1"));
    runInsights(db);
    expect(openInsights(db).map((i) => i.kind)).toEqual(["deadline_no_commitment"]);

    approveAction(db, "task", "user");
    const r = await runExecutor(db, () => null, { onlyId: "task" });
    expect(r.tasks).toBe(1);
    expect(openInsights(db)).toHaveLength(0);
    const verbs = (db.prepare(`SELECT verb FROM audit_events WHERE verb LIKE 'action.%' OR verb LIKE 'insight.%' ORDER BY id`).all() as { verb: string }[]).map((x) => x.verb);
    expect(verbs).toEqual(["insight.opened", "action.approved", "action.executed", "insight.resolved"]);
  });
});

describe("insights on the board", () => {
  it("open insights lead Waiting on us; dismissed ones move to Done; the drawer opens them", () => {
    const db = db0();
    mail(db, "m1", "t1", "lumen-booking", "priya@lumenclinic.com", hoursAgo(40));
    signal(db, "c", "lumen-booking", "m1", "our_commitment", "Fix the double-booking bug", hoursAgo(24 * 8));
    runInsights(db, { now: NOW });

    const lane = () => getBoard(db, { now: NOW.getTime() }).clients.flatMap((c) => c.lanes).find((l) => l.id === "lumen-booking")!;
    const first = lane().columns.on_us[0];
    expect(first.kind).toBe("insight");
    expect(first.severity).toBe("high");
    expect(first.producedBy).toBe("rule");
    expect(lane().health).toBe("blocked");
    expect(lane().stats.open).toBe(1); // the insight isn't counted as a second open item

    const view = inspect(db, { type: "insight", id: first.id })!;
    expect(view.kind).toBe("insight");
    expect(view.insight?.byRule).toBe(true);
    expect(view.insight?.signalRef).toBe("signal:c");
    expect(view.sources).toHaveLength(1);

    dismissInsight(db, first.id, "user");
    expect(lane().columns.on_us.some((c) => c.kind === "insight")).toBe(false);
    expect(lane().columns.done.some((c) => c.id === first.id)).toBe(true);
  });
});
