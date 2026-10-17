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
import { estimateCost, hasModelKey, routeModel, type Provider } from "./models";
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
  end(token: string, r: { ok: boolean; ms: number; error?: string; usage?: { input_tokens: number; output_tokens: number } }): void;
}

let observer: CallObserver | null = null;
export function setCallObserver(o: CallObserver | null): void {
  observer = o;
}

let anthropic: Anthropic | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 2;

async function anthropicCall<T>(model: string, req: ToolCall<T>, onRetry?: (attempt: number, reason: string, waitMs: number) => void): Promise<LlmResult<T>> {
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
      if (!retryable || attempt >= MAX_RETRIES) {
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

/** Routes each call by its model name to whichever configured provider serves it. */
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
      const t0 = Date.now();
      const token = observer?.start({ model: route.model, provider: route.provider, hint: req.hint, label: req.label });
      const onRetry = token ? (attempt: number, reason: string, waitMs: number) => observer?.retry(token, attempt, reason, waitMs) : undefined;
      try {
        let out: LlmResult<T>;
        if (route.provider === "openrouter") {
          const r = await openRouterCall(route.model, req, { onRetry });
          out = { ...r, cost_usd: r.cost_usd ?? estimateCost(route.spec, r.usage), provider: "openrouter" };
        } else {
          const r = await anthropicCall(route.model, req, onRetry);
          out = { ...r, cost_usd: estimateCost(route.spec, r.usage), provider: "anthropic" };
        }
        if (token) observer?.end(token, { ok: true, ms: Date.now() - t0, usage: out.usage });
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
