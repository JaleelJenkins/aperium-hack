import { describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/lib/db";
import { INITIAL_PAIR_LEADERBOARD } from "../src/lib/router/leaderboard";
import { inspectEmailPayloadForRouting, selectOptimalModelPair, TRIGGER } from "../src/lib/router/pairRouter";
import {
  dryRunOne,
  finishDryRun,
  getLeaderboard,
  getRouterSettings,
  projectRouting,
  promotePair,
  routeMessage,
  setDefaultPolicy,
  setProjectPolicy,
  startDryRun,
} from "../src/lib/router/store";
import type { RoutingContext, RoutingPolicyMode } from "../src/lib/router/types";
import { applySeed, readSeed } from "../src/lib/seed";

const LB = INITIAL_PAIR_LEADERBOARD;
const ctx = (policyMode: RoutingPolicyMode, over: Partial<RoutingContext> = {}): RoutingContext => ({
  projectId: "p",
  hasPdfAttachment: false,
  hasImageAttachment: false,
  containsFinancialOrScopeKeywords: false,
  isUnknownSenderDomain: false,
  hasQuotedRelativeDate: false,
  policyMode,
  ...over,
});

describe("leaderboard (illustrative seed)", () => {
  it("derives lift, trap rate, badges and rank from the data", () => {
    const byId = Object.fromEntries(LB.map((p) => [p.id, p]));
    expect(LB.map((p) => p.id)).toEqual(["haiku-sonnet", "sonnet-opus", "flash-haiku", "haiku-haiku", "haiku-none"]);
    expect(byId["haiku-sonnet"]).toMatchObject({ trapsCaughtCount: 4, verdictBadge: "PARETO OPTIMAL", source: "illustrative", available: true });
    expect(byId["haiku-sonnet"].rescueLift).toBeCloseTo(0.25);
    expect(byId["sonnet-opus"].verdictBadge).toBe("OVERKILL (SLOW)");
    expect(byId["flash-haiku"]).toMatchObject({ verdictBadge: "MISSED BEC TRAP", available: false });
    expect(byId["haiku-haiku"].verdictBadge).toBe("MISSED PDF TRAP");
    expect(byId["haiku-none"]).toMatchObject({ verdictBadge: "UNSAFE FOR PROD", trapsCaughtCount: 1 });
  });
});

describe("selectOptimalModelPair", () => {
  it("pinned returns the pinned pair; an unavailable pin falls back", () => {
    expect(selectOptimalModelPair(ctx("pinned", { pinnedPairId: "sonnet-opus" }), LB).selectedPair.id).toBe("sonnet-opus");
    const fb = selectOptimalModelPair(ctx("pinned", { pinnedPairId: "flash-haiku" }), LB);
    expect(fb.selectedPair.available).toBe(true);
    expect(fb.routingReason).toMatch(/unavailable/);
  });

  it("complexity escalation: risky payload -> fastest 100% trap-safe pair, with triggers", () => {
    const d = selectOptimalModelPair(ctx("complexity_escalation", { hasPdfAttachment: true, containsFinancialOrScopeKeywords: true }), LB);
    expect(d).toMatchObject({ wasEscalated: true, escalationTriggers: [TRIGGER.pdf, TRIGGER.keywords] });
    expect(d.selectedPair.id).toBe("haiku-sonnet");
    expect(d.routingReason).toBe(`Auto-escalated to Haiku 5.5 → Sonnet 5.5 due to: ${TRIGGER.pdf}; ${TRIGGER.keywords}`);
  });

  it("complexity escalation: plain text -> fast route, never the unavailable or unreviewed pair", () => {
    const d = selectOptimalModelPair(ctx("complexity_escalation"), LB);
    expect(d.wasEscalated).toBe(false);
    expect(d.selectedPair.id).toBe("haiku-haiku"); // flash-haiku is faster but has no adapter; haiku-none has no reviewer
    expect(d.routingReason).toMatch(/Low-risk plain text payload/);
  });

  it("strict trust always escalates", () => {
    const d = selectOptimalModelPair(ctx("strict_trust"), LB);
    expect(d).toMatchObject({ wasEscalated: true, escalationTriggers: ["Strict trust SLA"] });
    expect(d.selectedPair.trapCatchRate).toBe(1);
  });

  it("low latency stays under budget unless a quoted relative date appears", () => {
    expect(selectOptimalModelPair(ctx("low_latency", { hasPdfAttachment: true }), LB).selectedPair.id).toBe("haiku-haiku");
    const d = selectOptimalModelPair(ctx("low_latency", { hasQuotedRelativeDate: true }), LB);
    expect(d).toMatchObject({ wasEscalated: true, escalationTriggers: [TRIGGER.quotedDate] });
    expect(d.selectedPair.id).toBe("haiku-sonnet");
  });

  it("pareto auto picks the best utility among available pairs", () => {
    const d = selectOptimalModelPair(ctx("pareto_auto"), LB);
    expect(d.selectedPair.id).toBe("haiku-sonnet");
    expect(d.estimatedCostUsd).toBeCloseTo(0.0042);
  });
});

describe("inspectEmailPayloadForRouting", () => {
  const project = { id: "p", clientDomains: ["harborpine.com"], knownContacts: ["teammate@gmail.com"], policyMode: "complexity_escalation" as const };
  it("detects PDFs, risk keywords, unknown senders and quoted relative dates", () => {
    const c = inspectEmailPayloadForRouting(
      {
        senderEmail: "maya@harborpine.com",
        text: "See below.\n\n---------- Forwarded message ---------\nDate: Sep 26\nThe pilot goes live next Friday.",
        attachments: [{ mimeType: "application/pdf" }, { mimeType: "image/png" }],
      },
      project,
    );
    expect(c).toMatchObject({ hasPdfAttachment: true, hasImageAttachment: true, isUnknownSenderDomain: false, hasQuotedRelativeDate: true, containsFinancialOrScopeKeywords: false });
    const bec = inspectEmailPayloadForRouting({ senderEmail: "x@lumen-payments.co", text: "Please wire the invoice", attachments: [] }, project);
    expect(bec).toMatchObject({ isUnknownSenderDomain: true, containsFinancialOrScopeKeywords: true, hasQuotedRelativeDate: false });
    // a relative date in the email's own new text is not trap 2
    expect(inspectEmailPayloadForRouting({ senderEmail: "teammate@gmail.com", text: "Ship it next Friday", attachments: [] }, project).hasQuotedRelativeDate).toBe(false);
  });
});

function seeded(): DB {
  const db = openDb(":memory:");
  applySeed(db, readSeed());
  db.prepare(`INSERT INTO threads (gmail_thread_id, account, project_id) VALUES ('t1', 'us@x.com', 'harbor-lobby'), ('t2', 'us@x.com', 'vector-route-dashboard')`).run();
  const msg = db.prepare(
    `INSERT INTO messages (gmail_message_id, thread_id, account, sender_email, received_at, body_source, raw_text, clean_text)
     VALUES (?, ?, 'us@x.com', ?, ?, 'text/plain', ?, ?)`,
  );
  msg.run("m1", "t1", "maya@harborpine.com", "2026-10-17T09:00:00Z", "Plan attached. Covers floors 1-3.", "Plan attached. Covers floors 1-3.");
  msg.run("m2", "t2", "jon@vectorfreight.io", "2026-10-17T10:00:00Z", "Map is not loading.", "Map is not loading.");
  db.prepare(
    `INSERT INTO attachments (id, message_id, part_id, filename, mime_type, kind, status) VALUES ('m1:1', 'm1', '1', 'plan.pdf', 'application/pdf', 'pdf', 'stored')`,
  ).run();
  return db;
}

describe("router store", () => {
  it("seeds per-client policies and a global default", () => {
    const db = seeded();
    expect(getRouterSettings(db).defaultPolicy).toBe("pareto_auto");
    expect(projectRouting(db, "harbor-lobby")).toMatchObject({ policy: "complexity_escalation", inherited: false });
    expect(projectRouting(db, "vector-route-dashboard").policy).toBe("low_latency");
    expect(projectRouting(db, "lumen-booking").policy).toBe("strict_trust");
  });

  it("routes stored messages with their project's policy and reacts to policy changes", () => {
    const db = seeded();
    expect(routeMessage(db, "m1")!).toMatchObject({ wasEscalated: true, escalationTriggers: [TRIGGER.pdf, TRIGGER.keywords] });
    expect(routeMessage(db, "m2")!.selectedPair.id).toBe("haiku-haiku");

    setProjectPolicy(db, "vector-route-dashboard", "strict_trust");
    expect(routeMessage(db, "m2")!.selectedPair.id).toBe("haiku-sonnet");

    setProjectPolicy(db, "vector-route-dashboard", null); // inherit global
    setDefaultPolicy(db, "pareto_auto");
    expect(projectRouting(db, "vector-route-dashboard")).toMatchObject({ policy: "pareto_auto", inherited: true });

    promotePair(db, "sonnet-opus");
    expect(getRouterSettings(db)).toEqual({ defaultPolicy: "pinned", pinnedPairId: "sonnet-opus" });
    expect(routeMessage(db, "m2")!.selectedPair.id).toBe("sonnet-opus");
    expect(() => promotePair(db, "flash-haiku")).toThrow(/no provider adapter/);
  });

  it("dry-run records one decision per email and summarizes", () => {
    const db = seeded();
    const { runId, messageIds } = startDryRun(db);
    expect(messageIds).toEqual(["m1", "m2"]);
    for (const id of messageIds) dryRunOne(db, runId, id);
    const s = finishDryRun(db, runId);
    expect(s).toMatchObject({ emails: 2, escalated: 1, pairs: { "haiku-sonnet": 1, "haiku-haiku": 1 } });
    expect(() => dryRunOne(db, runId, "m1")).toThrow(/finished/);
  });

  it("a fully measured eval_runs row replaces the illustrative seed row", () => {
    const db = seeded();
    const trap = { outcome: "BLOCKED", latencyMs: 1000, note: "" };
    db.prepare(
      `INSERT INTO eval_runs (id, reason_profile_id, review_profile_id, started_at, finished_at, metrics_json)
       VALUES ('e1', 'claude-haiku', 'claude-sonnet', '2026-10-17T11:00:00Z', '2026-10-17T11:05:00Z', ?)`,
    ).run(
      JSON.stringify({
        raw_reason_accuracy: 0.7, verified_accuracy: 0.93, signal_recall: 0.9, latency_p50_ms: 4100, cost_per_email_usd: 0.005,
        trap_matrix: { "TRAP-01": trap, "TRAP-02": trap, "TRAP-03": trap, "TRAP-04": { ...trap, outcome: "LEAKED" } },
      }),
    );
    const row = getLeaderboard(db).find((p) => p.id === "haiku-sonnet")!;
    expect(row).toMatchObject({ source: "measured", verifiedAccuracy: 0.93, trapsCaughtCount: 3, verdictBadge: "MISSED BEC TRAP" });
    expect(row.costPer1kEmailsUsd).toBeCloseTo(5);
    expect(getLeaderboard(db).find((p) => p.id === "sonnet-opus")!.source).toBe("illustrative");
  });
});
