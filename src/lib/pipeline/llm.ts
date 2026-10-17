/**
 * Thin Claude wrapper for the pipeline stages. Every call forces a single tool
 * so the answer comes back as typed JSON, never prose to parse.
 */
import Anthropic from "@anthropic-ai/sdk";

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

export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

export function claudeLlm(): Llm {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
  return {
    async call<T>(req: ToolCall<T>): Promise<LlmResult<T>> {
      const res = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        tools: [req.tool],
        tool_choice: { type: "tool", name: req.tool.name },
        messages: [{ role: "user", content: req.content }],
      });
      const block = res.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") throw new Error(`${req.model} returned no ${req.tool.name} call`);
      return {
        input: block.input as T,
        usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
      };
    },
  };
}
