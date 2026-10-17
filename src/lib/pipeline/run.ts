/**
 * Runs the pipeline stages in order over whatever mail is waiting:
 *   Extract  ingested -> extracted   (PDF pages, image text)
 *   Resolve  -> resolved             (file the thread to a project)
 *   Reason   resolved -> reasoned    (signals, insights, actions + verify/policy checks)
 *   Review   reasoned -> reviewed    (second model over the full source; store)
 *   Insights deterministic rules over open signals + project health (no model, always runs)
 * Called by the worker after every poll, and by `npm run pipeline`. Headless: no
 * UI involved, and every model call goes through the provider-agnostic Llm
 * (Anthropic and/or OpenRouter, see llm.ts / models.ts).
 */
import type { DB } from "../db";
import { claudeExtractor, runExtract, type ExtractResult, type Extractor } from "./extract";
import { hasApiKey, pipelineLlm } from "./llm";
import { runInsights, type InsightsResult } from "./insights";
import { claudeMatcher, heuristicMatcher, runResolve, type Matcher, type ResolveResult } from "./resolve";
import { runReasonReview, type ReasonReviewDeps, type ReasonReviewResult } from "./review";

export interface PipelineDeps {
  /** null = skip Extract (no API key): messages stay "ingested" until one is set. */
  extractor: Extractor | null;
  matcher: Matcher;
  /** null = skip Reason + Review (no API key): filed mail waits in triage as "resolved". */
  reasonReview: ReasonReviewDeps | null;
}

export function defaultDeps(): PipelineDeps {
  if (!hasApiKey()) return { extractor: null, matcher: heuristicMatcher(), reasonReview: null };
  const llm = pipelineLlm();
  return { extractor: claudeExtractor(llm), matcher: claudeMatcher(llm), reasonReview: { llm } };
}

export interface PipelineResult {
  extract: ExtractResult | null;
  resolve: ResolveResult;
  reasonReview: ReasonReviewResult | null;
  insights: InsightsResult;
}

export async function runPipeline(
  db: DB,
  deps: PipelineDeps = defaultDeps(),
  opts: { dataDir?: string; now?: Date } = {},
): Promise<PipelineResult> {
  const extract = deps.extractor ? await runExtract(db, deps.extractor, opts) : null;
  const resolve = await runResolve(db, deps.matcher);
  const reasonReview = deps.reasonReview ? await runReasonReview(db, deps.reasonReview, { now: opts.now }) : null;
  const insights = runInsights(db, { now: opts.now });
  return { extract, resolve, reasonReview, insights };
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
  const rr = r.reasonReview;
  if (rr && (rr.reasoned || rr.reviewed || rr.failed.length)) {
    out.push(
      `reason/review: ${rr.reasoned} reasoned, ${rr.reviewed} reviewed` +
        (rr.failed.length ? `, ${rr.failed.length} failed (${rr.failed.map((f) => `${f.stage}: ${f.error}`).join("; ")})` : ""),
    );
    for (const m of rr.perMessage) {
      const c = m.counts;
      const blocked = c.blocked.review + c.blocked.verify + c.blocked.policy;
      out.push(
        `  ${m.message} [${m.pair}] ${c.signals} signal(s), ${c.insights} insight(s), ${c.actions} action(s)` +
          (c.revised ? `, ${c.revised} revised` : "") +
          (c.byRule ? `, ${c.byRule} by team rules` : "") +
          (blocked ? `, ${blocked} caught (review ${c.blocked.review}, verify ${c.blocked.verify}, policy ${c.blocked.policy})` : "") +
          (c.closed ? `, closed ${c.closed}` : "") +
          ` · $${m.cost_usd.toFixed(4)}` +
          (m.latency_ms != null ? ` · ${(m.latency_ms / 1000).toFixed(1)}s since received` : ""),
      );
    }
  }
  const ins = r.insights;
  if (ins.opened || ins.resolved || ins.health.length) {
    out.push(
      `insights: ${ins.opened} opened, ${ins.resolved} resolved` +
        (ins.health.length ? ` · health ${ins.health.map((h) => `${h.project} ${h.from}->${h.to}`).join(", ")}` : ""),
    );
  }
  return out;
}
