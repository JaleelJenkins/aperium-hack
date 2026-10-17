import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db";

describe("DB wrapper over node:sqlite", () => {
  it("commits, rolls back on error, and nests with savepoints", () => {
    const db = openDb(":memory:");
    const add = (id: string) => db.prepare(`INSERT INTO clients (id, name) VALUES (?, ?)`).run(id, id);
    const ids = () => (db.prepare(`SELECT id FROM clients ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

    db.transaction(() => add("a"))();
    expect(() =>
      db.transaction(() => {
        add("b");
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(ids()).toEqual(["a"]);

    db.transaction(() => {
      add("c");
      try {
        db.transaction(() => {
          add("d");
          throw new Error("inner");
        })();
      } catch {
        // inner rolled back, outer continues
      }
    })();
    expect(ids()).toEqual(["a", "c"]);
    expect(add("e").changes).toBe(1);
  });

  it("migration 002: blocked reviews need no target row; review provenance + pipeline_runs exist", () => {
    const db = openDb(":memory:");
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);

    db.prepare(
      `INSERT INTO model_reviews (id, target_type, target_id, produced_by_model, reviewer_model, blocked_by, verdict, notes, claim_json, conflicting_evidence_json)
       VALUES ('r1', 'signal', NULL, 'haiku', 'sonnet', 'review', 'block', 'PDF p.2: Levels 1-2', '{"text":"3 floors"}', '[{"kind":"attachment_page","attachment_id":"m1:2","page":2}]')`,
    ).run();
    expect(db.prepare(`SELECT target_id, blocked_by FROM model_reviews WHERE id = 'r1'`).get()).toEqual({
      target_id: null,
      blocked_by: "review",
    });

    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    for (const t of ["signals", "insights", "actions"]) expect(cols(t)).toContain("reviewed_by_model");
    expect(cols("signals")).toEqual(expect.arrayContaining(["date_basis", "original_text", "closed_by_message"]));
    expect(cols("pipeline_runs")).toEqual(expect.arrayContaining(["latency_ms", "cost_usd"]));
  });
});
