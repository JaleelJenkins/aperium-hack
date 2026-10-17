/**
 * Provider-agnostic model layer for the pipeline stages. Every call forces a
 * single tool so the answer comes back as typed JSON, never prose to parse.
 *
 * Headless by design: stages only see the `Llm` interface and name models by
 * profile id (claude-haiku, gemini-flash...) or Claude API id. `pipelineLlm()`
 * routes each call to Anthropic or OpenRouter (see models.ts), so the worker
 * runs the same with ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or both.
 */
import Anthropic from "@anthropic-ai/sdk";
import { estimateCost, fallbackRoute, hasModelKey, routeModel, type Provider, type Route } from "./models";
import { llmTimeoutMs, openRouterCall } from "./openrouter";
import { withToolInstruction } from "./tool-instruction";

export type ContentBlock = Anthropic.Messages.ContentBlockParam;

export interface ToolCall<T> {
  model: string;
  system: string;
  content: ContentBlock[];
  tool: { name: string; description: string; input_schema: Anthropic.Messages.Tool.InputSchema };
  maxTokens?: number;
  /** Tells calls apart: "reason:<message id>", "review:<id>", "extract-image", "resolve"... */
  hint?: string;
  /** Human label for logs (email subject, attachment name). */
  label?: string;
  /** Type witness; not sent. */
  _out?: T;
}

export interface LlmResult<T> {
  input: T;
  usage: { input_tokens: number; output_tokens: number };
  /** USD for this call, when known (provider-reported or estimated from list prices). */
  cost_usd?: number | null;
  /** Which provider served it. */
  provider?: Provider | "fake";
}

export interface Llm {
  call<T>(req: ToolCall<T>): Promise<LlmResult<T>>;
}

export const DEFAULT_MODELS = {
  // Reading page text verbatim matters for evidence quotes, so extraction uses the stronger model.
  // Only used for scanned PDFs with no text layer (most PDFs are read locally, no model call).
  extract: process.env.EXTRACT_MODEL || "claude-sonnet-5-5",
  // Describing a screenshot or photo and copying its visible text: the fast model is enough.
  extractImage: process.env.EXTRACT_IMAGE_MODEL || "claude-haiku-5-5",
  // Matching an email to one of a handful of project summaries is easy; keep it fast.
  resolve: process.env.RESOLVE_MODEL || "claude-haiku-5-5",
};

/** Any model provider configured (Anthropic or OpenRouter). */
export function hasApiKey(): boolean {
  return hasModelKey();
}

/** Short description of the configured providers, for worker/CLI logs. */
export function providerSummary(): string {
  const parts = [];
  if (process.env.ANTHROPIC_API_KEY?.trim()) parts.push("Anthropic");
  if (process.env.OPENROUTER_API_KEY?.trim()) parts.push("OpenRouter");
  const mode = process.env.LLM_PROVIDER?.trim();
  return parts.length ? `${parts.join(" + ")}${mode ? ` (LLM_PROVIDER=${mode})` : ""}` : "no model provider";
}

// ------------------------------------------------------------- call tracing

/** Watches every model call (start, retries, end): the terminal log and `npm run pipeline:watch`. */
export interface CallObserver {
  start(info: { model: string; provider: Provider; hint?: string; label?: string }): string;
  retry(token: string, attempt: number, reason: string, waitMs: number): void;
  /** The call was handed to another provider (OpenRouter failover). */
  switched?(token: string, to: { provider: Provider; model: string }, reason: string): void;
  end(token: string, r: { ok: boolean; ms: number; error?: string; usage?: { input_tokens: number; output_tokens: number }; provider?: string }): void;
}

let observer: CallObserver | null = null;
export function setCallObserver(o: CallObserver | null): void {
  observer = o;
}

let anthropic: Anthropic | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 2;

async function anthropicCall<T>(
  model: string,
  req: ToolCall<T>,
  onRetry?: (attempt: number, reason: string, waitMs: number) => void,
  maxRetries = MAX_RETRIES,
): Promise<LlmResult<T>> {
  // Bounded per request (default 45 s). Retries are ours, not the SDK's, so each one is logged.
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: llmTimeoutMs() });
  let res: Anthropic.Messages.Message;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await anthropic.messages.create({
        model,
        max_tokens: req.maxTokens ?? 4096,
        system: withToolInstruction(req.system, req.tool.name),
        tools: [req.tool],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: req.content }],
      });
      break;
    } catch (err) {
      const status = (err as { status?: number }).status;
      const timedOut = err instanceof Anthropic.APIConnectionTimeoutError;
      const retryable = timedOut || status === 429 || status === 529 || (status !== undefined && status >= 500) || err instanceof Anthropic.APIConnectionError;
      if (!retryable || attempt >= maxRetries) {
        if (timedOut) throw new Error(`${model}: no response after ${llmTimeoutMs() / 1000}s (${attempt + 1} attempts)`);
        throw err;
      }
      const after = Number((err as { headers?: Record<string, string> }).headers?.["retry-after"]);
      const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : 1000 * 2 ** attempt;
      const reason = timedOut ? `no response after ${llmTimeoutMs() / 1000}s` : status === 429 ? "429 rate limited" : status === 529 ? "529 overloaded" : `HTTP ${status ?? "connection error"}`;
      onRetry?.(attempt + 1, reason, timedOut ? 0 : waitMs);
      if (!timedOut) await sleep(waitMs);
    }
  }
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error(`${model} returned no ${req.tool.name} call`);
  return {
    input: block.input as T,
    usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
  };
}

// ------------------------------------------------------------- failover to OpenRouter

/**
 * Why an Anthropic error is worth sending the same call to OpenRouter, or null when it
 * isn't (a bad request would fail there too).
 */
export function failoverReason(err: unknown): string | null {
  const status = (err as { status?: number }).status;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return `no response after ${llmTimeoutMs() / 1000}s`;
  if (err instanceof Error && /no response after/.test(err.message)) return err.message;
  if (status === 429) return "429 rate limited";
  if (status === 529) return "529 overloaded";
  if (status !== undefined && status >= 500) return `HTTP ${status}`;
  if (err instanceof Anthropic.APIConnectionError) return "connection error";
  return null;
}

/** Hand the call to OpenRouter when Anthropic hasn't answered after this long (both may run; first answer wins). */
export const hedgeMs = () => {
  const n = Number(process.env.LLM_HEDGE_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
};

/**
 * After repeated rate limits / overloads, Anthropic is skipped for a while and calls go
 * straight to OpenRouter, so a busy minute doesn't make every email wait for a failure first.
 */
const breaker = { hits: [] as number[], openUntil: 0 };
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_HITS = 2;
const BREAKER_OPEN_MS = 120_000;
export function anthropicCoolingDown(now = Date.now()): boolean {
  return now < breaker.openUntil;
}
function noteAnthropicTrouble(now = Date.now()) {
  breaker.hits = [...breaker.hits.filter((t) => now - t < BREAKER_WINDOW_MS), now];
  if (breaker.hits.length >= BREAKER_HITS) breaker.openUntil = now + BREAKER_OPEN_MS;
}
/** Tests only. */
export function resetFailover() {
  breaker.hits = [];
  breaker.openUntil = 0;
}

async function viaOpenRouter<T>(route: Route, req: ToolCall<T>, onRetry?: (attempt: number, reason: string, waitMs: number) => void): Promise<LlmResult<T>> {
  const r = await openRouterCall(route.model, req, { onRetry });
  return { ...r, cost_usd: r.cost_usd ?? estimateCost(route.spec, r.usage), provider: "openrouter" };
}

async function viaAnthropic<T>(route: Route, req: ToolCall<T>, onRetry?: (attempt: number, reason: string, waitMs: number) => void, maxRetries?: number): Promise<LlmResult<T>> {
  const r = await anthropicCall(route.model, req, onRetry, maxRetries);
  return { ...r, cost_usd: estimateCost(route.spec, r.usage), provider: "anthropic" };
}

/**
 * Anthropic first, OpenRouter as the safety net: the same request goes to OpenRouter as
 * soon as Anthropic rate-limits, overloads, errors or simply hasn't answered within
 * hedgeMs(). The first good answer wins; the call fails only if both do.
 */
function withFailover<T>(
  primary: Route,
  alt: Route,
  req: ToolCall<T>,
  hooks: { onRetry?: (attempt: number, reason: string, waitMs: number) => void; switched?: (reason: string) => void },
): Promise<LlmResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let altStarted = false;
    let primaryErr: unknown = null;
    let altErr: unknown = null;
    let primaryDone = false;
    let altDone = false;
    const finish = () => {
      if (settled) return;
      if (primaryDone && (!altStarted || altDone)) {
        settled = true;
        reject(altStarted ? altErr : primaryErr);
      }
    };
    const startAlt = (reason: string) => {
      if (altStarted || settled) return;
      altStarted = true;
      hooks.switched?.(reason);
      viaOpenRouter(alt, req, hooks.onRetry).then(
        (r) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        },
        (e) => {
          altErr = e;
          altDone = true;
          finish();
        },
      );
    };
    const timer = setTimeout(() => startAlt(`Anthropic hasn't answered after ${hedgeMs() / 1000}s`), hedgeMs());
    // One Anthropic attempt only: OpenRouter is the retry.
    viaAnthropic(primary, req, undefined, 0).then(
      (r) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(r);
        }
      },
      (e) => {
        clearTimeout(timer);
        primaryErr = e;
        primaryDone = true;
        const reason = failoverReason(e);
        if (reason) {
          noteAnthropicTrouble();
          startAlt(`Anthropic: ${reason}`);
        }
        finish();
      },
    );
  });
}

/** Routes each call by its model name to whichever configured provider serves it, failing over to OpenRouter. */
export function pipelineLlm(): Llm {
  return {
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      const route = routeModel(req.model);
      if (!route) {
        throw new Error(
          `No provider for model "${req.model}": set ANTHROPIC_API_KEY or OPENROUTER_API_KEY` +
            (req.model === "gemini-flash" ? " and OPENROUTER_MODEL_GEMINI_FLASH" : ""),
        );
      }
      const alt = fallbackRoute(req.model);
      const t0 = Date.now();
      const token = observer?.start({ model: route.model, provider: route.provider, hint: req.hint, label: req.label });
      const onRetry = token ? (attempt: number, reason: string, waitMs: number) => observer?.retry(token, attempt, reason, waitMs) : undefined;
      const switched = (to: Route) => (reason: string) => {
        if (token) observer?.switched?.(token, { provider: to.provider, model: to.model }, reason);
      };
      try {
        let out: LlmResult<T>;
        if (route.provider === "openrouter") out = await viaOpenRouter(route, req, onRetry);
        else if (!alt) out = await viaAnthropic(route, req, onRetry);
        else if (anthropicCoolingDown()) {
          switched(alt)("Anthropic cooling down after repeated rate limits");
          out = await viaOpenRouter(alt, req, onRetry);
        } else out = await withFailover(route, alt, req, { onRetry, switched: switched(alt) });
        if (token) observer?.end(token, { ok: true, ms: Date.now() - t0, usage: out.usage, provider: out.provider });
        return out;
      } catch (err) {
        if (token) observer?.end(token, { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
  };
}

/** @deprecated kept for older imports; same as pipelineLlm(). */
export const claudeLlm = pipelineLlm;
