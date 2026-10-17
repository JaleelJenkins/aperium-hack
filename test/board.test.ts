import { describe, expect, it } from "vitest";
import { clientPrefix, dueState, getBoard, listClientsForNav, ticketKeys } from "../src/lib/board";
import { openDb, type DB } from "../src/lib/db";
import { caughtClaims, inspect, parseInspectRef } from "../src/lib/inspect";
import { applySeed, readSeed } from "../src/lib/seed";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ev = (message_id: string, quote: string) => JSON.stringify([{ kind: "message", message_id, quote }]);

function seeded(): DB {
  const db = openDb(":memory:");
  applySeed(db, readSeed());
  db.prepare(`INSERT INTO threads (gmail_thread_id, account, project_id) VALUES ('t1', 'a@x.com', 'harbor-lobby')`).run();
  db.prepare(`INSERT INTO threads (gmail_thread_id, account, project_id) VALUES ('t2', 'a@x.com', NULL)`).run();
  const msg = db.prepare(
    `INSERT INTO messages (gmail_message_id, thread_id, account, sender_email, subject, received_at, body_source, raw_text, clean_text, status)
     VALUES (?, ?, 'a@x.com', ?, ?, '2026-10-17T10:00:00Z', 'text/plain', '', ?, ?)`,
  );
  msg.run("m1", "t1", "maya@harborpine.com", "Floor plan", "Hi team,\n\nCould you send the revised quote by Friday?", "reviewed");
  msg.run("m2", "t1", "maya@harborpine.com", "Re: Floor plan", "One more thing", "extracted");
  msg.run("m3", "t2", "priya@lumenclinic.com", "Portal idea", "New idea", "resolved");

  const sig = db.prepare(
    `INSERT INTO signals (id, project_id, message_id, type, text, due_at, status, evidence_json, produced_by_model, review_verdict, reviewed_by_model)
     VALUES (?, 'harbor-lobby', 'm1', ?, ?, ?, ?, ?, 'claude-haiku', 'pass', 'claude-opus')`,
  );
  sig.run("s-ask", "ask", "Send the revised quote", "2026-10-18", "open", ev("m1", "Could you send the revised quote"));
  sig.run("s-late", "our_commitment", "Share renders", "2026-10-15", "open", ev("m1", "Hi team"));
  sig.run("s-them", "their_commitment", "Maya sends photos", "2026-10-25", "open", ev("m1", "Hi team"));
  sig.run("s-dec", "decision", "Oak finish", null, "open", ev("m1", "Hi team"));
  sig.run("s-done", "ask", "Old ask", null, "done", ev("m1", "Hi team"));

  db.prepare(
    `INSERT INTO actions (id, project_id, thread_id, message_id, type, payload_json, status, evidence_json, produced_by_model)
     VALUES ('a1', 'harbor-lobby', 't1', 'm1', 'draft_reply', ?, 'proposed', ?, 'claude-haiku')`,
  ).run(JSON.stringify({ to: ["maya@harborpine.com"], subject: "Re: Floor plan", body: "Hi" }), ev("m1", "Hi team"));
  db.prepare(
    `INSERT INTO model_reviews (id, target_type, project_id, verdict, blocked_by, notes) VALUES ('r1', 'signal', 'harbor-lobby', 'block', 'review', 'PDF p.2')`,
  ).run();
  return db;
}

describe("portfolio board", () => {
  it("puts each item in its workflow column", () => {
    const board = getBoard(seeded(), { now: NOW });
    const lane = board.clients.find((c) => c.id === "harbor-pine")!.lanes[0];
    const ids = (col: keyof typeof lane.columns) => lane.columns[col].map((c) => c.id);

    expect(ids("triage")).toEqual(["m2"]); // still in the pipeline
    expect(ids("on_us")).toEqual(["s-late", "s-ask"]); // sorted by due date
    expect(ids("on_client")).toEqual(["s-them"]);
    expect(ids("approval")).toEqual(["a1"]);
    expect(ids("done").sort()).toEqual(["s-dec", "s-done"]); // decisions are recorded facts
    expect(lane.stats).toMatchObject({ open: 3, overdue: 1, dueSoon: 1, approvals: 1, blockedByReview: 1 });
  });

  it("links cards to the exact evidence line, keys them, and names the real models", () => {
    const lane = getBoard(seeded(), { now: NOW }).clients.find((c) => c.id === "harbor-pine")!.lanes[0];
    const ask = lane.columns.on_us.find((c) => c.id === "s-ask")!;
    expect(ask.href).toBe("/messages/m1#L3");
    expect(ask.evidenceLabel).toBe("EMAIL · L3");
    expect(ask.ref).toBe("signal:s-ask");
    expect(ask.key).toMatch(/^HP-\d+$/);
    // profile ids from seed.json resolve to concrete model names for the chain of custody
    expect(ask.producedBy).toBe("claude-haiku-5-5");
    expect(ask.review).toEqual({ verdict: "pass", model: "claude-opus-5-5", score: null });
    expect(ask.dueState).toBe("soon");
  });

  it("gives every signal and action a unique ticket key per client", () => {
    const keys = [...ticketKeys(seeded()).values()];
    expect(keys).toHaveLength(6); // 5 signals + 1 action, all Harbor & Pine
    expect(new Set(keys).size).toBe(6);
    expect(keys.every((k) => k.startsWith("HP-"))).toBe(true);
    expect(clientPrefix("Vector Freight")).toBe("VF");
    expect(clientPrefix("Acme")).toBe("AC");
  });

  it("overdue work makes a project at risk, here and in the sidebar", () => {
    const db = seeded();
    const board = getBoard(db, { now: NOW });
    expect(board.clients.find((c) => c.id === "harbor-pine")!.lanes[0].health).toBe("at_risk");
    expect(board.clients[0].id).toBe("harbor-pine"); // most urgent client first
    expect(listClientsForNav(db).find((c) => c.id === "harbor-pine")!.health).toBe("at_risk");
  });

  it("collects unfiled threads in a triage lane with a client guess", () => {
    const board = getBoard(seeded(), { now: NOW });
    expect(board.triage?.columns.triage.map((c) => [c.id, c.detail])).toEqual([["m3", "priya@lumenclinic.com · likely Lumen Clinic"]]);
  });

  it("'needs attention' hides quiet projects", () => {
    const db = seeded();
    const all = getBoard(db, { now: NOW }).clients.flatMap((c) => c.lanes).map((l) => l.id);
    const attention = getBoard(db, { now: NOW, filter: "attention" }).clients.flatMap((c) => c.lanes).map((l) => l.id);
    expect(all).toHaveLength(5);
    expect(attention).toEqual(["harbor-lobby"]);
  });

  it("evidence drawer: highlights the quoted line and shows the review audit", () => {
    const db = seeded();
    const item = inspect(db, parseInspectRef("signal:s-ask")!)!;
    expect(item.project).toEqual({ id: "harbor-lobby", name: "Lobby redesign", clientName: "Harbor & Pine Architects" });
    expect(item.sources[0].lines.filter((l) => l.hit).map((l) => l.n)).toEqual([3]);
    expect(item.audit).toMatchObject({ producer: "claude-haiku-5-5", reviewer: "claude-opus-5-5", verdict: "pass" });
    expect(parseInspectRef("bogus:x")).toBeNull();
    expect(parseInspectRef("caught")).toEqual({ type: "caught" });
  });

  it("caught-by-review vault lists blocked claims with what contradicted them", () => {
    const db = seeded();
    db.prepare(
      `UPDATE model_reviews SET message_id = 'm1', claim_json = ?, conflicting_evidence_json = ? WHERE id = 'r1'`,
    ).run(JSON.stringify({ text: "Scope covers 3 floors" }), JSON.stringify([{ kind: "message", message_id: "m1", quote: "Could you send" }]));
    const [c] = caughtClaims(db);
    expect(c).toMatchObject({ claim: "Scope covers 3 floors", notes: "PDF p.2", blockedBy: "review" });
    expect(c.project?.name).toBe("Lobby redesign");
    expect(c.conflicting[0].lines.find((l) => l.hit)?.n).toBe(3);
  });

  it("classifies due dates", () => {
    expect(dueState("2026-10-16", NOW)).toBe("overdue");
    expect(dueState("2026-10-18T12:00:00Z", NOW)).toBe("soon");
    expect(dueState("2026-10-30", NOW)).toBe("later");
    expect(dueState(null, NOW)).toBeNull();
  });
});
