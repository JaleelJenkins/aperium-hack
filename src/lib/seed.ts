import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { audit, type DB } from "./db";

const ROUTING_POLICIES = ["pareto_auto", "complexity_escalation", "strict_trust", "low_latency", "pinned"] as const;

const SeedFile = z.object({
  clients: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      domains: z.array(z.string()),
      contacts: z.array(z.object({ email: z.string(), name: z.string().optional() })),
    }),
  ),
  projects: z.array(
    z.object({
      id: z.string(),
      client_id: z.string(),
      name: z.string(),
      summary: z.string().default(""),
      routing_policy: z.enum(ROUTING_POLICIES).nullable().default(null),
    }),
  ),
  model_profiles: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      model_name: z.string(),
      label: z.string(),
      stages: z.array(z.enum(["reason", "review"])),
      cost_in_per_mtok: z.number().nullable().optional(),
      cost_out_per_mtok: z.number().nullable().optional(),
    }),
  ),
  default_model_prefs: z.object({ reason: z.string(), review: z.string() }),
  default_routing_policy: z.enum(ROUTING_POLICIES).default("pareto_auto"),
});
export type SeedFile = z.infer<typeof SeedFile>;

export const DEFAULT_SEED_PATH = path.resolve("seed/seed.json");
export const DEFAULT_USER = "demo";

/** seed.json's stand-in for the teammate who sends the live demo email from their phone. */
export const LIVE_DEMO_PLACEHOLDER = "change_me.live-demo@gmail.com";

/** LIVE_DEMO_SENDER from .env.local, if it's a plausible address. Lets each machine set it without editing seed.json. */
export function liveDemoSender(): string | null {
  const v = process.env.LIVE_DEMO_SENDER?.trim().toLowerCase();
  return v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

export function readSeed(file = DEFAULT_SEED_PATH): SeedFile {
  const seed = SeedFile.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const sender = liveDemoSender();
  if (sender) {
    for (const c of seed.clients) {
      for (const ct of c.contacts) if (ct.email.toLowerCase() === LIVE_DEMO_PLACEHOLDER) ct.email = sender;
    }
  }
  return seed;
}

/**
 * Upsert clients, contacts, projects and model profiles from seed config.
 * Safe to run repeatedly. Returns warnings (e.g. placeholder addresses).
 */
export function applySeed(db: DB, seed: SeedFile, opts: { overwriteSummaries?: boolean } = {}): string[] {
  const warnings: string[] = [];
  db.transaction(() => {
    const upClient = db.prepare(
      `INSERT INTO clients (id, name, domains_json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, domains_json = excluded.domains_json`,
    );
    const upContact = db.prepare(
      `INSERT INTO contacts (email, name, client_id) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, client_id = excluded.client_id`,
    );
    for (const c of seed.clients) {
      upClient.run(c.id, c.name, JSON.stringify(c.domains.map((d) => d.toLowerCase())));
      for (const ct of c.contacts) {
        if (ct.email.toLowerCase() === LIVE_DEMO_PLACEHOLDER) {
          warnings.push(`${c.name}: set LIVE_DEMO_SENDER in .env.local to the address that sends the live demo email, then npm run seed`);
        } else if (/CHANGE_ME/i.test(ct.email)) {
          warnings.push(`${c.name}: replace placeholder contact ${ct.email}`);
        }
        upContact.run(ct.email.toLowerCase(), ct.name ?? null, c.id);
      }
    }
    // Once the real live sender is configured, drop the placeholder row an earlier seed left behind.
    const seededEmails = seed.clients.flatMap((c) => c.contacts.map((ct) => ct.email.toLowerCase()));
    if (!seededEmails.includes(LIVE_DEMO_PLACEHOLDER)) {
      db.prepare(`DELETE FROM contacts WHERE email = ?`).run(LIVE_DEMO_PLACEHOLDER);
    }

    // routing_policy only fills an empty policy; it never overrides a choice made in the UI.
    const upProject = db.prepare(
      `INSERT INTO projects (id, client_id, name, summary, routing_policy) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, name = excluded.name,
         routing_policy = COALESCE(projects.routing_policy, excluded.routing_policy)`,
    );
    for (const p of seed.projects) upProject.run(p.id, p.client_id, p.name, p.summary, p.routing_policy);
    // Summaries evolve as mail arrives, so the seed only sets them on first insert, an empty
    // summary, or when asked (npm run seed -- --summaries).
    const setSummary = db.prepare(
      opts.overwriteSummaries
        ? `UPDATE projects SET summary = ? WHERE id = ?`
        : `UPDATE projects SET summary = ? WHERE id = ? AND (summary IS NULL OR summary = '')`,
    );
    for (const p of seed.projects) setSummary.run(p.summary, p.id);
    db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('router.default_policy', ?)`).run(seed.default_routing_policy);

    const upProfile = db.prepare(
      `INSERT INTO model_profiles (id, provider, model_name, label, stages_json, cost_in_per_mtok, cost_out_per_mtok)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model_name = excluded.model_name,
         label = excluded.label, stages_json = excluded.stages_json,
         cost_in_per_mtok = excluded.cost_in_per_mtok, cost_out_per_mtok = excluded.cost_out_per_mtok`,
    );
    for (const m of seed.model_profiles) {
      upProfile.run(m.id, m.provider, m.model_name, m.label, JSON.stringify(m.stages), m.cost_in_per_mtok ?? null, m.cost_out_per_mtok ?? null);
    }

    // Only set defaults; never override a choice made in settings.
    const pref = db.prepare(
      `INSERT OR IGNORE INTO user_model_prefs (user_id, stage, model_profile_id) VALUES (?, ?, ?)`,
    );
    pref.run(DEFAULT_USER, "reason", seed.default_model_prefs.reason);
    pref.run(DEFAULT_USER, "review", seed.default_model_prefs.review);

    audit(db, "worker", "seed.applied", null, {
      clients: seed.clients.length,
      projects: seed.projects.length,
      models: seed.model_profiles.length,
    });
  })();
  return warnings;
}

/**
 * Back to a clean demo state: wipe pipeline output and AI-proposed projects,
 * restore seeded projects, keep the Gmail connection and model preferences.
 */
export function resetToSeed(db: DB, seed: SeedFile, opts: { disconnect?: boolean } = {}): string[] {
  const seededProjects = seed.projects.map((p) => p.id);
  db.transaction(() => {
    db.exec(`DELETE FROM route_decisions; DELETE FROM route_runs; DELETE FROM pipeline_runs; DELETE FROM model_reviews; DELETE FROM actions; DELETE FROM insights; DELETE FROM signals;
             DELETE FROM attachments; DELETE FROM messages; DELETE FROM threads;
             DELETE FROM eval_runs; DELETE FROM audit_events;`);
    db.prepare(`DELETE FROM projects WHERE id NOT IN (${seededProjects.map(() => "?").join(",")})`).run(...seededProjects);
    db.exec(`UPDATE projects SET health = 'on_track', status = 'active', sentiment_trend = NULL, last_contact_at = NULL;`);
    if (opts.disconnect) db.exec(`DELETE FROM gmail_accounts;`);
    else db.exec(`UPDATE gmail_accounts SET history_id = NULL, last_synced_at = NULL, last_error = NULL;`);
  })();
  // Restores seeded summaries too (the upsert above leaves summaries alone).
  const restore = db.prepare(`UPDATE projects SET summary = ?, routing_policy = ?, pinned_pair_id = NULL WHERE id = ?`);
  for (const p of seed.projects) restore.run(p.summary, p.routing_policy, p.id);
  db.prepare(`DELETE FROM app_settings WHERE key LIKE 'router.%'`).run();
  return applySeed(db, seed);
}
