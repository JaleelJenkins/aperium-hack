/**
 * Contracts between the pipeline and the models (PRD: "Model output contract"
 * and "Model review and model choice"). Lock these in hour 0; Reason and
 * Review prompts must ask for exactly these shapes.
 */
import { z } from "zod";

// ------------------------------------------------------------------ evidence

/**
 * Evidence is one of: a message id with a quote, an attachment id with a
 * page, an attachment id with a start and end time, or an attachment id with
 * an image region. Quotes must be verbatim from messages.clean_text or the
 * attachment's extracted text, so the server can check them.
 */
export const Evidence = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    message_id: z.string().min(1),
    quote: z.string().min(3),
  }),
  z.object({
    kind: z.literal("attachment_page"),
    attachment_id: z.string().min(1),
    page: z.number().int().positive(),
    quote: z.string().min(3).optional(),
  }),
  z.object({
    kind: z.literal("attachment_time"), // P2: audio/video
    attachment_id: z.string().min(1),
    start_s: z.number().nonnegative(),
    end_s: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("attachment_region"),
    attachment_id: z.string().min(1),
    region: z
      .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) // fractions of width/height, 0–1
      .optional(),
    quote: z.string().optional(), // text read from the image, if any
  }),
]);
export type Evidence = z.infer<typeof Evidence>;

const EvidenceList = z.array(Evidence).min(1);

// --------------------------------------------------------------- Reason output

export const SIGNAL_TYPES = ["ask", "our_commitment", "their_commitment", "deadline", "decision", "risk"] as const;
export const INSIGHT_KINDS = [
  "unanswered_ask",
  "deadline_no_commitment",
  "overdue_commitment",
  "scope_change",
  "sentiment_drop",
  "missing_info",
] as const;
export const ACTION_TYPES = ["draft_reply", "internal_task"] as const;

export const SignalOut = z.object({
  type: z.enum(SIGNAL_TYPES),
  text: z.string().min(1),
  due_at: z.string().nullable().default(null), // ISO date or datetime
  evidence: EvidenceList,
});

export const InsightOut = z.object({
  kind: z.enum(INSIGHT_KINDS),
  severity: z.enum(["low", "medium", "high"]),
  text: z.string().min(1),
  suggested_action: z.string().nullable().default(null),
  evidence: EvidenceList,
});

export const ActionOut = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("draft_reply"),
    payload: z.object({ to: z.array(z.string().email()).min(1), subject: z.string(), body: z.string().min(1) }),
    evidence: EvidenceList,
  }),
  z.object({
    type: z.literal("internal_task"),
    payload: z.object({ title: z.string().min(1), notes: z.string().default("") }),
    evidence: EvidenceList,
  }),
]);

/** What Reason returns for one message, given the message, its extracted attachments and the project state. */
export const ReasonOutput = z.object({
  client_guess: z.object({
    client_id: z.string().nullable(),
    name: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  project_match: z.object({
    project_id: z.string().nullable(), // null = new project
    new_project_name: z.string().nullable().default(null),
    confidence: z.number().min(0).max(1),
  }),
  project_summary: z.string().nullable().default(null), // updated running summary, if it changed
  signals: z.array(SignalOut).default([]),
  insights: z.array(InsightOut).default([]),
  actions: z.array(ActionOut).default([]),
});
export type ReasonOutput = z.infer<typeof ReasonOutput>;

// --------------------------------------------------------------- Review output

export const REVIEW_VERDICTS = ["pass", "revise", "block"] as const;

/** Review sees each claim with its cited evidence resolved to text and returns one verdict per item. */
export const ReviewOutput = z.object({
  items: z.array(
    z.object({
      target_type: z.enum(["signal", "insight", "action"]),
      index: z.number().int().nonnegative(), // position in the Reason output array of that type
      verdict: z.enum(REVIEW_VERDICTS),
      score: z.number().min(0).max(1),
      reason: z.string().min(1), // one line; shown in "Caught by review"
      revised_text: z.string().nullable().default(null), // for verdict = revise
    }),
  ),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** Project match below this goes to the action queue as a "new project?" card instead of being assigned. */
export const PROJECT_MATCH_THRESHOLD = 0.7;
