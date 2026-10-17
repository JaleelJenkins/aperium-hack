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
import { openRouterCall } from "./openrouter";

export type ContentBlock = Anthropic.Messages.ContentBlockParam;

export interface ToolCall<T> {
  model: string;
  system: string;
  content: ContentBlock[];
  tool: { name: string; description: string; input_schema: Anthropic.Messages.Tool.InputSchema };
  maxTokens?: number;
  /** Only used by fakes in tests, to tell calls apart. */
  hint?: string;
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
  extract: process.env.EXTRACT_MODEL || "claude-sonnet-5-5",
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

let anthropic: Anthropic | null = null;

async function anthropicCall<T>(model: string, req: ToolCall<T>): Promise<LlmResult<T>> {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
  const res = await anthropic.messages.create({
    model,
    max_tokens: req.maxTokens ?? 4096,
    system: req.system,
    tools: [req.tool],
    tool_choice: { type: "tool", name: req.tool.name },
    messages: [{ role: "user", content: req.content }],
  });
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
      if (route.provider === "openrouter") {
        const r = await openRouterCall(route.model, req);
        return { ...r, cost_usd: r.cost_usd ?? estimateCost(route.spec, r.usage), provider: "openrouter" };
      }
      const r = await anthropicCall(route.model, req);
      return { ...r, cost_usd: estimateCost(route.spec, r.usage), provider: "anthropic" };
    },
  };
}

/** @deprecated kept for older imports; same as pipelineLlm(). */
export const claudeLlm = pipelineLlm;
