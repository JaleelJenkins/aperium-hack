"use server";

/**
 * Server actions for the pair router UI. Each one revalidates the whole app so the
 * scoreboard, lane headers and route traces reflect the change without a page reload.
 */
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import {
  dryRunOne,
  finishDryRun,
  promotePair,
  setDefaultPolicy,
  setProjectPolicy,
  startDryRun,
  type RouteRunSummary,
} from "@/lib/router/store";
import { POLICY_LABEL, type RoutingPolicyMode } from "@/lib/router/types";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const done = (message: string): ActionResult => {
  revalidatePath("/", "layout");
  return { ok: true, message };
};
const fail = (err: unknown): ActionResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) });

export async function setDefaultPolicyAction(mode: RoutingPolicyMode): Promise<ActionResult> {
  try {
    setDefaultPolicy(getDb(), mode);
    return done(`Default routing policy set to ${POLICY_LABEL[mode] ?? mode}.`);
  } catch (err) {
    return fail(err);
  }
}

export async function promotePairAction(pairId: string, label: string): Promise<ActionResult> {
  try {
    promotePair(getDb(), pairId);
    return done(`${label} promoted to the default router (pinned).`);
  } catch (err) {
    return fail(err);
  }
}

export async function setProjectPolicyAction(
  projectId: string,
  mode: RoutingPolicyMode | null,
  pinnedPairId: string | null,
): Promise<ActionResult> {
  try {
    setProjectPolicy(getDb(), projectId, mode, pinnedPairId);
    return done(mode ? `Routing policy saved.` : `Project now inherits the default policy.`);
  } catch (err) {
    return fail(err);
  }
}

// Dry-run is three calls so the client's progress bar reflects real per-email work.
export async function startDryRunAction(): Promise<{ runId: string; messageIds: string[] }> {
  return startDryRun(getDb());
}

export async function dryRunOneAction(runId: string, messageId: string): Promise<{ pair: string; escalated: boolean } | null> {
  const d = dryRunOne(getDb(), runId, messageId);
  return d ? { pair: d.selectedPair.id, escalated: d.wasEscalated } : null;
}

export async function finishDryRunAction(runId: string): Promise<RouteRunSummary> {
  const summary = finishDryRun(getDb(), runId);
  revalidatePath("/", "layout");
  return summary;
}
