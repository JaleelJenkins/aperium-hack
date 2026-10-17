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
import { claudeMatcher, fastFirstMatcher, heuristicMatcher, runResolve, type Matcher, type ResolveResult } from "./resolve";
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
  // Clear-cut threads are filed by word overlap; only ambiguous ones call the model.
  return { extractor: claudeExtractor(llm), matcher: fastFirstMatcher(claudeMatcher(llm)), reasonReview: { llm } };
}

export interface PipelineResult {
  extract: ExtractResult | null;
  resolve: ResolveResult;
  reasonReview: ReasonReviewResult | null;
  insights: InsightsResult;
  /** Wall-clock time for this run. */
  elapsedMs?: number;
}

/** How many emails go through the pipeline at once (each is a few model calls). */
export const PIPELINE_CONCURRENCY = Math.max(1, Number(process.env.PIPELINE_CONCURRENCY) || 6);

const emptyResult = (deps: PipelineDeps): Omit<PipelineResult, "insights"> & { insights?: InsightsResult } => ({
  extract: deps.extractor ? { messages: 0, attachments: 0, failed: [] } : null,
  resolve: { assigned: [], inherited: 0, cards: [], failed: [] },
  reasonReview: deps.reasonReview ? { reasoned: 0, reviewed: 0, failed: [], perMessage: [] } : null,
});

/**
 * Streams waiting mail through every stage one email at a time, several emails in
 * parallel: each email goes Extract -> Resolve -> Reason -> Review before the worker
 * slot moves on, so cards leave Triage within seconds instead of after the whole
 * inbox has been read. Emails in the same thread run in order (a reply inherits the
 * project its thread was filed to); different threads run concurrently.
 */
export async function runPipeline(
  db: DB,
  deps: PipelineDeps = defaultDeps(),
  opts: { dataDir?: string; now?: Date; concurrency?: number; limit?: number } = {},
): Promise<PipelineResult> {
  const started = Date.now();
  const out = emptyResult(deps);
  const rows = db
    .prepare(
      `SELECT gmail_message_id AS id, thread_id FROM messages
        WHERE status IN ('ingested', 'extracted', 'resolved', 'reasoned') ORDER BY received_at LIMIT ?`,
    )
    .all(opts.limit ?? 200) as { id: string; thread_id: string }[];
  const threads = new Map<string, string[]>();
  for (const r of rows) threads.set(r.thread_id, [...(threads.get(r.thread_id) ?? []), r.id]);

  const one = async (id: string) => {
    if (deps.extractor && out.extract) {
      const e = await runExtract(db, deps.extractor, { dataDir: opts.dataDir, onlyId: id });
      out.extract.messages += e.messages;
      out.extract.attachments += e.attachments;
      out.extract.failed.push(...e.failed);
    }
    const r = await runResolve(db, deps.matcher, { onlyId: id });
    out.resolve.assigned.push(...r.assigned);
    out.resolve.inherited += r.inherited;
    out.resolve.cards.push(...r.cards);
    out.resolve.failed.push(...r.failed);
    if (deps.reasonReview && out.reasonReview) {
      const rr = await runReasonReview(db, deps.reasonReview, { now: opts.now, onlyId: id });
      out.reasonReview.reasoned += rr.reasoned;
      out.reasonReview.reviewed += rr.reviewed;
      out.reasonReview.failed.push(...rr.failed);
      out.reasonReview.perMessage.push(...rr.perMessage);
    }
  };

  const queue = [...threads.values()];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? PIPELINE_CONCURRENCY, queue.length) }, async () => {
    for (let ids = queue.shift(); ids; ids = queue.shift()) {
      for (const id of ids) {
        try {
          await one(id);
        } catch (err) {
          // Stages record their own failures; this only guards against an unexpected throw.
          out.resolve.failed.push({ message: id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  });
  await Promise.all(workers);
  // Deterministic insight rules and project health over everything stored (no model call).
  const insights = runInsights(db, { now: opts.now });
  return { ...out, insights, elapsedMs: Date.now() - started };
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
          (m.reason_ms != null ? ` · reason ${(m.reason_ms / 1000).toFixed(1)}s` : "") +
          (m.review_ms != null ? ` + review ${(m.review_ms / 1000).toFixed(1)}s` : "") +
          (m.latency_ms != null ? ` · ${(m.latency_ms / 1000).toFixed(1)}s since received` : ""),
      );
    }
  }
  const n = (r.extract?.messages ?? 0) + r.resolve.assigned.length + r.resolve.inherited + (r.reasonReview?.reviewed ?? 0);
  if (n && r.elapsedMs != null) out.push(`done in ${(r.elapsedMs / 1000).toFixed(1)}s (${PIPELINE_CONCURRENCY} at a time)`);
  const ins = r.insights;
  if (ins.opened || ins.resolved || ins.health.length) {
    out.push(
      `insights: ${ins.opened} opened, ${ins.resolved} resolved` +
        (ins.health.length ? ` · health ${ins.health.map((h) => `${h.project} ${h.from}->${h.to}`).join(", ")}` : ""),
    );
  }
  return out;
}
