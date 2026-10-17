/**
 * Which provider serves which model. The pipeline names models by profile id
 * (claude-haiku, claude-sonnet, claude-opus, gemini-flash: the ids the router
 * and scoreboard use) or by a Claude API id (claude-sonnet-5-5). This file turns
 * either into a concrete provider + model name, so stages never care whether a
 * call goes to Anthropic directly or through OpenRouter.
 *
 * Provider choice (LLM_PROVIDER):
 *   auto (default)  Claude models go to Anthropic when ANTHROPIC_API_KEY is set,
 *                   otherwise to OpenRouter; non-Claude models always go to OpenRouter.
 *   anthropic       Claude models only through Anthropic.
 *   openrouter      everything through OpenRouter (one key for every vendor).
 */
import type { ModelId } from "../router/types";

export type Provider = "anthropic" | "openrouter";

export interface ModelSpec {
  profile: ModelId | null;
  /** Claude API id, when the model is a Claude model. */
  anthropic: string | null;
  /** OpenRouter id, or null when none is configured. */
  openrouter: string | null;
  /** USD per million tokens; OpenRouter's reported cost wins when it returns one. */
  costIn: number;
  costOut: number;
}

const env = (k: string) => process.env[k]?.trim() || "";

/** Prices are Anthropic list prices (also what OpenRouter charges for these models). */
const PROFILES: Record<ModelId, () => ModelSpec> = {
  "claude-haiku": () => ({
    profile: "claude-haiku",
    anthropic: env("MODEL_CLAUDE_HAIKU") || "claude-haiku-5-5",
    openrouter: env("OPENROUTER_MODEL_CLAUDE_HAIKU") || "anthropic/claude-haiku-5.5",
    costIn: 0.1,
    costOut: 0.5,
  }),
  "claude-sonnet": () => ({
    profile: "claude-sonnet",
    anthropic: env("MODEL_CLAUDE_SONNET") || "claude-sonnet-5-5",
    openrouter: env("OPENROUTER_MODEL_CLAUDE_SONNET") || "anthropic/claude-sonnet-5.5",
    costIn: 2,
    costOut: 10,
  }),
  "claude-opus": () => ({
    profile: "claude-opus",
    anthropic: env("MODEL_CLAUDE_OPUS") || "claude-opus-5-5",
    openrouter: env("OPENROUTER_MODEL_CLAUDE_OPUS") || "anthropic/claude-opus-5.5",
    costIn: 4,
    costOut: 20,
  }),
  // Second vendor for the cross-family pair (flash-haiku). Set the OpenRouter id you want,
  // e.g. one listed at https://openrouter.ai/models?q=gemini%20flash; until then the
  // router treats the pair as unavailable.
  "gemini-flash": () => ({
    profile: "gemini-flash",
    anthropic: null,
    openrouter: env("OPENROUTER_MODEL_GEMINI_FLASH") || null,
    costIn: Number(env("GEMINI_FLASH_COST_IN")) || 0,
    costOut: Number(env("GEMINI_FLASH_COST_OUT")) || 0,
  }),
};

export const hasAnthropicKey = () => !!env("ANTHROPIC_API_KEY");
export const hasOpenRouterKey = () => !!env("OPENROUTER_API_KEY");

/** Any model provider configured: the pipeline can make real model calls. */
export const hasModelKey = () => hasAnthropicKey() || hasOpenRouterKey();

function providerMode(): "auto" | Provider {
  const m = env("LLM_PROVIDER").toLowerCase();
  return m === "anthropic" || m === "openrouter" ? m : "auto";
}

/** "claude-sonnet-5-5" -> "anthropic/claude-sonnet-5.5" */
export function anthropicToOpenRouter(id: string): string {
  return `anthropic/${id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}

/** Profile id, Claude API id, or an explicit OpenRouter id ("vendor/model"). */
export function modelSpec(name: string): ModelSpec {
  if (name in PROFILES) return PROFILES[name as ModelId]();
  for (const make of Object.values(PROFILES)) {
    const s = make();
    if (s.anthropic === name || s.openrouter === name) return s;
  }
  if (name.includes("/")) return { profile: null, anthropic: null, openrouter: name, costIn: 0, costOut: 0 };
  if (name.startsWith("claude-")) return { profile: null, anthropic: name, openrouter: anthropicToOpenRouter(name), costIn: 0, costOut: 0 };
  return { profile: null, anthropic: null, openrouter: null, costIn: 0, costOut: 0 };
}

export interface Route {
  provider: Provider;
  model: string;
  spec: ModelSpec;
}

/** Where a call for `name` goes right now, or null if no configured provider can serve it. */
export function routeModel(name: string): Route | null {
  const spec = modelSpec(name);
  const mode = providerMode();
  const viaAnthropic = spec.anthropic && hasAnthropicKey() ? { provider: "anthropic" as const, model: spec.anthropic, spec } : null;
  const viaOpenRouter = spec.openrouter && hasOpenRouterKey() ? { provider: "openrouter" as const, model: spec.openrouter, spec } : null;
  if (mode === "anthropic") return viaAnthropic;
  if (mode === "openrouter") return viaOpenRouter;
  return viaAnthropic ?? viaOpenRouter;
}

/** True when some configured provider can serve this router model. */
export function modelAvailable(id: ModelId): boolean {
  return routeModel(id) !== null;
}

export function estimateCost(spec: ModelSpec, usage: { input_tokens: number; output_tokens: number }): number {
  return (usage.input_tokens * spec.costIn + usage.output_tokens * spec.costOut) / 1_000_000;
}
