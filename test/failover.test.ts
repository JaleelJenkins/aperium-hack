import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicCoolingDown, pipelineLlm, resetFailover, setCallObserver } from "../src/lib/pipeline/llm";
import { fallbackRoute } from "../src/lib/pipeline/models";

type Mode = "ok" | "429" | "529" | "400" | "hang";
const state = { anthropic: "ok" as Mode, openrouter: "ok" as "ok" | "500", anthropicCalls: 0, openrouterCalls: 0 };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "0" } });

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "ak";
  process.env.OPENROUTER_API_KEY = "or";
  process.env.LLM_HEDGE_MS = "80";
  process.env.LLM_TIMEOUT_MS = "2000";
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_FALLBACK;
  // One dispatcher for both providers; behaviour is switched per test via `state`.
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("anthropic.com")) {
      state.anthropicCalls++;
      if (state.anthropic === "hang") {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      if (state.anthropic === "429") return json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
      if (state.anthropic === "529") return json(529, { type: "error", error: { type: "overloaded_error", message: "busy" } });
      if (state.anthropic === "400") return json(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } });
      return json(200, {
        id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "tool_use", stop_sequence: null,
        content: [{ type: "tool_use", id: "t1", name: "t", input: { from: "anthropic" } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    state.openrouterCalls++;
    if (state.openrouter === "500") return json(500, { error: { message: "down" } });
    return json(200, { choices: [{ message: { tool_calls: [{ function: { name: "t", arguments: '{"from":"openrouter"}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
});

beforeEach(() => {
  Object.assign(state, { anthropic: "ok", openrouter: "ok", anthropicCalls: 0, openrouterCalls: 0 });
  resetFailover();
  setCallObserver(null);
});

const call = () =>
  pipelineLlm().call<{ from: string }>({ model: "claude-haiku", system: "", content: [{ type: "text", text: "hi" }], tool: { name: "t", description: "", input_schema: { type: "object" } }, hint: "reason:m1" });

describe("Anthropic → OpenRouter failover", () => {
  it("healthy Anthropic: no OpenRouter call", async () => {
    const r = await call();
    expect(r).toMatchObject({ input: { from: "anthropic" }, provider: "anthropic" });
    expect(state.openrouterCalls).toBe(0);
  });

  it("429 rate limit: the same call goes to OpenRouter at once, and it's reported", async () => {
    state.anthropic = "429";
    const switched: string[] = [];
    setCallObserver({ start: () => "t", retry: () => {}, end: () => {}, switched: (_t, to, reason) => void switched.push(`${to.provider}: ${reason}`) });
    const r = await call();
    expect(r).toMatchObject({ input: { from: "openrouter" }, provider: "openrouter" });
    expect(state.anthropicCalls).toBe(1); // no silent Anthropic retries
    expect(switched).toEqual(["openrouter: Anthropic: 429 rate limited"]);
  });

  it("hung Anthropic call: OpenRouter is started after the hedge delay and wins", async () => {
    state.anthropic = "hang";
    const t0 = Date.now();
    const r = await call();
    expect(r.provider).toBe("openrouter");
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("repeated overloads open the breaker: next calls skip Anthropic for a while", async () => {
    state.anthropic = "529";
    await call();
    await call();
    expect(anthropicCoolingDown()).toBe(true);
    state.anthropic = "ok";
    const before = state.anthropicCalls;
    const r = await call();
    expect(r.provider).toBe("openrouter");
    expect(state.anthropicCalls).toBe(before);
  });

  it("a bad request isn't retried elsewhere (it would fail there too)", async () => {
    state.anthropic = "400";
    await expect(call()).rejects.toThrow();
    expect(state.openrouterCalls).toBe(0);
  });

  it("both down: the call fails with OpenRouter's error", async () => {
    state.anthropic = "429";
    state.openrouter = "500";
    await expect(call()).rejects.toThrow(/OpenRouter .*HTTP 500/);
  });

  it("no OpenRouter key, or LLM_FALLBACK=off: no fallback route", () => {
    expect(fallbackRoute("claude-sonnet")).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
    process.env.LLM_FALLBACK = "off";
    expect(fallbackRoute("claude-sonnet")).toBeNull();
    delete process.env.LLM_FALLBACK;
    const k = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(fallbackRoute("claude-sonnet")).toBeNull();
    process.env.OPENROUTER_API_KEY = k;
  });
});
