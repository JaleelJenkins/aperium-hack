import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/lib/db";
import { traceCalls } from "../src/lib/llm-trace";
import { pipelineLlm } from "../src/lib/pipeline/llm";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("call tracing (terminal log + pipeline:watch)", () => {
  it("records each model call, its retries and its duration", async () => {
    process.env.OPENROUTER_API_KEY = "or";
    process.env.LLM_PROVIDER = "openrouter";
    delete process.env.ANTHROPIC_API_KEY;
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1) return { ok: false, status: 429, text: async () => "slow down" };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "t", arguments: "{}" } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      };
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void lines.push(m));
    const db = openDb(":memory:");
    const untrace = traceCalls(db, "cli");
    await pipelineLlm().call({ model: "claude-haiku", system: "", content: [], tool: { name: "t", description: "", input_schema: { type: "object" } }, hint: "reason:m1", label: "Fwd: Pilot go-live" });
    untrace();
    const row = db.prepare(`SELECT stage, message_id, label, model, attempts, last_retry, finished_at, error FROM llm_calls`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ stage: "reason", message_id: "m1", label: "Fwd: Pilot go-live", model: "anthropic/claude-haiku-5.5", attempts: 2, last_retry: "429 rate limited", error: null });
    expect(row.finished_at).toBeTruthy();
    expect(lines.some((l) => /→ reason .*Fwd: Pilot go-live/.test(l))).toBe(true);
    expect(lines.some((l) => /↻ reason .*retry 1 in 0\.5s: 429 rate limited/.test(l))).toBe(true);
    expect(lines.some((l) => /✓ reason .*s {2}"Fwd: Pilot go-live"/.test(l))).toBe(true);
  });

  it("a failed call is logged with its error; calls left open are closed when tracing stops", async () => {
    process.env.OPENROUTER_API_KEY = "or";
    process.env.LLM_PROVIDER = "openrouter";
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 400, text: async () => "bad request" }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = openDb(":memory:");
    const untrace = traceCalls(db, "web");
    await expect(
      pipelineLlm().call({ model: "claude-sonnet", system: "", content: [], tool: { name: "t", description: "", input_schema: { type: "object" } }, hint: "review:m2" }),
    ).rejects.toThrow(/HTTP 400/);
    untrace();
    expect((db.prepare(`SELECT error FROM llm_calls`).get() as { error: string }).error).toMatch(/HTTP 400/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM llm_calls WHERE finished_at IS NULL`).get()).toEqual({ n: 0 });
  });
});
