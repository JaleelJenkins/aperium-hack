/**
 * Runs the pipeline stages that exist so far, in order, over whatever mail is
 * waiting: Extract (ingested -> extracted), then Resolve (-> resolved).
 * Called by the worker after every poll, and by `npm run pipeline`.
 */
import type { DB } from "../db";
import { claudeExtractor, runExtract, type ExtractResult, type Extractor } from "./extract";
import { claudeLlm, hasApiKey } from "./llm";
import { claudeMatcher, heuristicMatcher, runResolve, type Matcher, type ResolveResult } from "./resolve";

export interface PipelineDeps {
  /** null = skip Extract (no API key): messages stay "ingested" until one is set. */
  extractor: Extractor | null;
  matcher: Matcher;
}

export function defaultDeps(): PipelineDeps {
  if (!hasApiKey()) return { extractor: null, matcher: heuristicMatcher() };
  const llm = claudeLlm();
  return { extractor: claudeExtractor(llm), matcher: claudeMatcher(llm) };
}

export interface PipelineResult {
  extract: ExtractResult | null;
  resolve: ResolveResult;
}

export async function runPipeline(db: DB, deps: PipelineDeps = defaultDeps(), opts: { dataDir?: string } = {}): Promise<PipelineResult> {
  const extract = deps.extractor ? await runExtract(db, deps.extractor, opts) : null;
  const resolve = await runResolve(db, deps.matcher);
  return { extract, resolve };
}

export function describe(r: PipelineResult): string[] {
  const out: string[] = [];
  if (r.extract && (r.extract.messages || r.extract.failed.length)) {
    out.push(
      `extract: ${r.extract.messages} message(s), ${r.extract.attachments} attachment(s)` +
        (r.extract.failed.length ? `, ${r.extract.failed.length} failed (${r.extract.failed.map((f) => f.error).join("; ")})` : ""),
    );
  }
  const z = r.resolve;
  if (z.assigned.length || z.inherited || z.cards.length || z.failed.length) {
    out.push(
      `resolve: ${z.assigned.length} filed, ${z.inherited} inherited from thread, ${z.cards.length} sent to "New project?"` +
        (z.failed.length ? `, ${z.failed.length} failed (${z.failed.map((f) => f.error).join("; ")})` : ""),
    );
    for (const a of z.assigned) out.push(`  ${a.message} -> ${a.project} (${Math.round(a.confidence * 100)}%, ${a.by})`);
  }
  return out;
}
