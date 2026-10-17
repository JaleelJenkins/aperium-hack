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
});
