import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The route reads the process-wide DB from DATA_DIR, so point it at a temp dir before importing.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-att-"));
process.env.DATA_DIR = dataDir;

type Get = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let GET: Get;

beforeAll(async () => {
  ({ GET } = (await import("../src/app/api/attachments/[id]/route")) as unknown as { GET: Get });
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  db.prepare(`INSERT INTO threads (gmail_thread_id, account) VALUES ('t1', 'a@x.com')`).run();
  db.prepare(
    `INSERT INTO messages (gmail_message_id, thread_id, account, received_at, body_source, raw_text, clean_text)
     VALUES ('m1', 't1', 'a@x.com', '2026-10-17T00:00:00Z', 'text/plain', '', '')`,
  ).run();
  fs.mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
  const add = db.prepare(
    `INSERT INTO attachments (id, message_id, part_id, filename, mime_type, kind, storage_path, status)
     VALUES (?, 'm1', ?, ?, 'application/pdf', 'pdf', ?, ?)`,
  );
  for (const [id, status] of [["a-stored", "stored"], ["a-extracted", "extracted"], ["a-skipped", "skipped"]]) {
    fs.writeFileSync(path.join(dataDir, "attachments", `${id}.pdf`), `%PDF-1.4 ${id}`);
    add.run(id, id, `${id}.pdf`, `attachments/${id}.pdf`, status);
  }
});

const get = (id: string) => GET(new Request(`http://localhost/api/attachments/${id}`), { params: Promise.resolve({ id }) });

describe("GET /api/attachments/[id]", () => {
  it("serves stored and extracted files (extract must not break evidence links)", async () => {
    for (const id of ["a-stored", "a-extracted"]) {
      const res = await get(id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(await res.text()).toBe(`%PDF-1.4 ${id}`);
    }
  });

  it("404s attachments that were never downloaded, and unknown ids", async () => {
    expect((await get("a-skipped")).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });
});
