import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db";
import { listProjects, updateProjectSummary } from "../src/lib/projects";
import { applySeed, readSeed } from "../src/lib/seed";

function db() {
  const d = openDb(":memory:");
  applySeed(d, readSeed());
  return d;
}

describe("projects page data", () => {
  it("groups the 5 seeded projects under their 3 clients with summaries, hiding placeholder contacts", () => {
    const clients = listProjects(db());
    expect(clients.map((c) => [c.name, c.projects.map((p) => p.name)])).toEqual([
      ["Harbor & Pine Architects", ["Lobby redesign"]],
      ["Lumen Clinic", ["Booking integration", "Website refresh"]],
      ["Vector Freight", ["Driver app pilot", "Route dashboard"]],
    ]);
    const harbor = clients[0];
    expect(harbor.projects[0].summary).toMatch(/Dana Whitfield/);
    expect(harbor.contacts.some((c) => /CHANGE_ME/.test(c.email))).toBe(false);
    expect(harbor.projects[0]).toMatchObject({ threads: 0, messages: 0, openSignals: 0, recentThreads: [] });
  });

  it("counts filed threads and shows how they were filed", () => {
    const d = db();
    d.prepare(
      `INSERT INTO threads (gmail_thread_id, account, subject, project_id, assignment_confidence, assigned_by, assignment_reason, last_message_at)
       VALUES ('t1', 'a', 'Floor plan', 'harbor-lobby', 0.93, 'claude-haiku-5-5', 'mentions the lobby', '2026-10-17T10:00:00Z')`,
    ).run();
    d.prepare(
      `INSERT INTO messages (gmail_message_id, thread_id, account, received_at, body_source, raw_text, clean_text) VALUES ('m1', 't1', 'a', '2026-10-17T10:00:00Z', 'text/plain', '', '')`,
    ).run();
    const p = listProjects(d)[0].projects[0];
    expect(p).toMatchObject({ threads: 1, messages: 1 });
    expect(p.recentThreads[0]).toMatchObject({ subject: "Floor plan", confidence: 0.93, assignedBy: "claude-haiku-5-5", reason: "mentions the lobby" });
  });

  it("edits a summary with validation and an audit entry", () => {
    const d = db();
    updateProjectSummary(d, "lumen-booking", "  Booking integration with CareSlot, plus patient reminder texts for Kelly Tran.  ");
    expect((d.prepare(`SELECT summary FROM projects WHERE id = 'lumen-booking'`).get() as { summary: string }).summary).toBe(
      "Booking integration with CareSlot, plus patient reminder texts for Kelly Tran.",
    );
    expect(d.prepare(`SELECT verb, object_ref FROM audit_events WHERE verb = 'project.summary_edited'`).get()).toEqual({
      verb: "project.summary_edited",
      object_ref: "project:lumen-booking",
    });
    expect(() => updateProjectSummary(d, "lumen-booking", "too short")).toThrow(/at least a sentence/);
    expect(() => updateProjectSummary(d, "nope", "A perfectly reasonable summary of a project.")).toThrow(/Unknown project/);
  });
});
