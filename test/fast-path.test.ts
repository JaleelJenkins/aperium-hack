import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeExtractor, pdfTextLayer, runExtract } from "../src/lib/pipeline/extract";
import type { Llm, ToolCall } from "../src/lib/pipeline/llm";
import { fastFirstMatcher, runResolve, type Matcher } from "../src/lib/pipeline/resolve";
import { checkEvidence } from "../src/lib/evidence";
import { SEED_ASSETS_DIR } from "../src/lib/seed-inbox";
import { seededDb } from "./seed-fixture";

describe("fast path: fewer, smaller model calls", () => {
  it("reads every seed PDF's text locally, page by page, exact enough for evidence", async () => {
    for (const f of fs.readdirSync(SEED_ASSETS_DIR).filter((f) => f.endsWith(".pdf"))) {
      const pages = await pdfTextLayer(fs.readFileSync(path.join(SEED_ASSETS_DIR, f)));
      expect(pages, f).not.toBeNull();
    }
    const plan = (await pdfTextLayer(fs.readFileSync(path.join(SEED_ASSETS_DIR, "harbor-lobby-floor-plan.pdf"))))!;
    expect(plan).toHaveLength(2);
    expect(plan[1]).toContain("Lobby redesign covers 2 levels");
    expect(plan[1]).toContain("Level 3 (tenant floor) is NOT IN SCOPE");
    expect(await pdfTextLayer(Buffer.from("not a pdf"))).toBeNull();
  });

  it("Extract makes no model call for PDFs and uses the fast model for images; trap 1 is still citable", async () => {
    const { db, dataDir } = await seededDb();
    const calls: ToolCall<unknown>[] = [];
    const llm: Llm = {
      async call(req) {
        calls.push(req as ToolCall<unknown>);
        return { input: { description: "A photo", text: "" } as never, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const r = await runExtract(db, claudeExtractor(llm), { dataDir });
    expect(r.failed).toEqual([]);
    expect(r.attachments).toBe(10);
    expect(calls.every((c) => c.hint === "extract-image")).toBe(true);
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["claude-haiku-5-5"]));
    const plan = db.prepare(`SELECT id, meta_json FROM attachments WHERE filename = 'harbor-lobby-floor-plan.pdf'`).get() as { id: string; meta_json: string };
    expect(JSON.parse(plan.meta_json).model).toBe("text-layer");
    expect(checkEvidence(db, { kind: "attachment_page", attachment_id: plan.id, page: 2, quote: "covers 2 levels" })).toEqual({ ok: true });
  });

  it("Resolve files clear-cut threads without a model call", async () => {
    const { db } = await seededDb();
    let modelCalls = 0;
    const model: Matcher = {
      model: "claude-haiku-5-5",
      async match() {
        modelCalls++;
        return { project_id: null, confidence: 0, reason: "should not be called", new_project_name: null };
      },
    };
    const r = await runResolve(db, fastFirstMatcher(model));
    expect(modelCalls).toBe(0);
    expect(r.assigned).toHaveLength(13);
    expect(new Set(r.assigned.map((a) => a.by))).toEqual(new Set(["rule"]));
    // An ambiguous email still goes to the model.
    const amb = await fastFirstMatcher(model).match(
      { clientName: "Lumen Clinic", sender: "x@lumenclinic.com", subject: "Quick question", text: "Can we talk?", attachments: [] },
      [
        { id: "a", name: "Website refresh", summary: "Website" },
        { id: "b", name: "Booking integration", summary: "Booking" },
      ],
    );
    expect(modelCalls).toBe(1);
    expect(amb.reason).toBe("should not be called");
  });
});
