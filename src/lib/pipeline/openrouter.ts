/**
 * OpenRouter adapter: one OpenAI-compatible endpoint for every vendor. Stages
 * build Anthropic-style content blocks (text, base64 image, base64 PDF); this
 * converts them, forces the single tool, and returns the tool's arguments as the
 * typed result, same contract as the Anthropic adapter.
 */
import type { ContentBlock, LlmResult, ToolCall } from "./llm";
import { withToolInstruction } from "./tool-instruction";

const ENDPOINT = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";

type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** Anthropic content blocks -> OpenAI-style content parts. */
export function toOpenRouterParts(blocks: ContentBlock[]): Part[] {
  return blocks.map((b): Part => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image" && b.source.type === "base64") {
      return { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    }
    if (b.type === "document" && b.source.type === "base64") {
      const filename = (b.title ?? "document.pdf").replace(/[^\w.\- ]+/g, "_");
      return { type: "file", file: { filename, file_data: `data:${b.source.media_type};base64,${b.source.data}` } };
    }
    throw new Error(`OpenRouter adapter: unsupported content block ${b.type}`);
  });
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[]; content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number | string };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Per-request model timeout. LLM_TIMEOUT_MS overrides; default 45 s. */
export function llmTimeoutMs(): number {
  const n = Number(process.env.LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 45_000; // normal calls take 5-20s; a hung one fails fast and is retried
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openRouterCall<T>(
  model: string,
  req: ToolCall<T>,
  opts: { apiKey?: string; fetch?: FetchLike; maxRetries?: number; onRetry?: (attempt: number, reason: string, waitMs: number) => void } = {},
): Promise<LlmResult<T> & { cost_usd: number | null; served_model: string }> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const body = JSON.stringify({
    model,
    max_tokens: req.maxTokens ?? 4096,
    messages: [
      { role: "system", content: withToolInstruction(req.system, req.tool.name) },
      { role: "user", content: toOpenRouterParts(req.content) },
    ],
    tools: [{ type: "function", function: { name: req.tool.name, description: req.tool.description, parameters: req.tool.input_schema } }],
    tool_choice: "auto",
    usage: { include: true },
  });
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.OPENROUTER_REFERER?.trim() || "http://localhost:3000",
    "X-Title": "Reasoning Intelligence",
  };

  const retries = opts.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    // A stuck request must not hold the pipeline lease: give up and retry after llmTimeoutMs().
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      res = await doFetch(`${ENDPOINT}/chat/completions`, { method: "POST", headers, body, signal: AbortSignal.timeout(llmTimeoutMs()) });
      text = await res.text();
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (timedOut && attempt < retries) {
        opts.onRetry?.(attempt + 1, `no response after ${llmTimeoutMs() / 1000}s`, 0);
        continue;
      }
      throw timedOut ? new Error(`OpenRouter ${model}: no response after ${llmTimeoutMs() / 1000}s`) : err;
    }
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        opts.onRetry?.(attempt + 1, res.status === 429 ? "429 rate limited" : `HTTP ${res.status}`, 500 * 2 ** attempt);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new Error(`OpenRouter ${model} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = JSON.parse(text) as ChatResponse;
    if (data.error) throw new Error(`OpenRouter ${model}: ${data.error.message ?? JSON.stringify(data.error)}`);
    const call = data.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === req.tool.name) ?? data.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) throw new Error(`${model} returned no ${req.tool.name} call`);
    let input: T;
    try {
      input = JSON.parse(call.function.arguments) as T;
    } catch {
      throw new Error(`${model} returned malformed ${req.tool.name} arguments`);
    }
    return {
      input,
      usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
      cost_usd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
      served_model: data.model ?? model,
    };
  }
}
