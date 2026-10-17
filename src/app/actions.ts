"use server";

/**
 * Server actions for the pair router UI. Each one revalidates the whole app so the
 * scoreboard, lane headers and route traces reflect the change without a page reload.
 */
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import {
  approveAction,
  decideNewProject,
  editAndApproveAction,
  rejectAction,
  type ActionEdit,
  type NewProjectDecision,
  type SaveAsRule,
} from "@/lib/approvals";
import { draftApiFor } from "@/lib/gmail/client";
import { retryAction, runExecutor } from "@/lib/pipeline/execute";
import { updateProjectSummary } from "@/lib/projects";
import { createRule, deleteRule, setRuleEnabled, updateRuleText, type NewRule } from "@/lib/rules";
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

export async function updateProjectSummaryAction(projectId: string, summary: string): Promise<ActionResult> {
  try {
    updateProjectSummary(getDb(), projectId, summary);
    return done("Summary saved. New email is matched against it from now on.");
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- approval queue (F5)

/** After approval, try to execute right away; the worker retries anything left over. */
async function executeNow(id: string): Promise<string> {
  const db = getDb();
  try {
    const r = await runExecutor(db, draftApiFor(db), { onlyId: id });
    if (r.drafts) return " Gmail draft created in the thread. Open Gmail to send it.";
    if (r.tasks) return " Added to Waiting on us.";
    if (r.failed.length) return ` Couldn't create the draft: ${r.failed[0].error}`;
    return " The worker will create the Gmail draft on its next pass.";
  } catch (err) {
    return ` The worker will retry: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function approveActionAction(id: string): Promise<ActionResult> {
  try {
    approveAction(getDb(), id, "user");
    return done(`Approved.${await executeNow(id)}`);
  } catch (err) {
    return fail(err);
  }
}

export async function editAndApproveActionAction(id: string, edit: ActionEdit): Promise<ActionResult> {
  try {
    editAndApproveAction(getDb(), id, edit, "user");
    return done(`Saved your edit and approved.${await executeNow(id)}`);
  } catch (err) {
    return fail(err);
  }
}

export async function rejectActionAction(id: string, reason: string, saveAsRule: SaveAsRule | null): Promise<ActionResult> {
  try {
    const rule = rejectAction(getDb(), id, reason, "user", saveAsRule ?? undefined);
    return done(rule ? `Rejected. Saved as rule ${rule.code}: future emails are reviewed against it.` : "Rejected. The reason is logged.");
  } catch (err) {
    return fail(err);
  }
}

export async function decideNewProjectAction(id: string, decision: NewProjectDecision): Promise<ActionResult> {
  try {
    const { projectId } = decideNewProject(getDb(), id, decision, "user");
    return done(`Filed to ${projectId}. Its mail goes through Reason and Review on the next pipeline pass.`);
  } catch (err) {
    return fail(err);
  }
}

export async function retryActionAction(id: string): Promise<ActionResult> {
  try {
    retryAction(getDb(), id, "user");
    return done(`Retrying.${await executeNow(id)}`);
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- review rules

export async function createRuleAction(input: NewRule): Promise<ActionResult> {
  try {
    const r = createRule(getDb(), { ...input, createdBy: "user" });
    return done(`Rule ${r.code} saved. It applies to every email reviewed from now on.`);
  } catch (err) {
    return fail(err);
  }
}

export async function setRuleEnabledAction(id: string, enabled: boolean): Promise<ActionResult> {
  try {
    setRuleEnabled(getDb(), id, enabled);
    return done(enabled ? "Rule turned on." : "Rule turned off. It's kept, just not applied.");
  } catch (err) {
    return fail(err);
  }
}

export async function updateRuleTextAction(id: string, text: string): Promise<ActionResult> {
  try {
    updateRuleText(getDb(), id, text);
    return done("Rule updated.");
  } catch (err) {
    return fail(err);
  }
}

export async function deleteRuleAction(id: string): Promise<ActionResult> {
  try {
    deleteRule(getDb(), id);
    return done("Rule deleted.");
  } catch (err) {
    return fail(err);
  }
}
