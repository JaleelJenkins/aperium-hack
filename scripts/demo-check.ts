/**
 * Demo-day preflight: npm run demo:check
 * Exit code 1 if anything would break the live demo.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import fs from "node:fs";
import { getDb } from "../src/lib/db";
import { runPreflight, type Level } from "../src/lib/preflight";

const ICON: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

async function devServerUp(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:3000/", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const labels = JSON.parse(fs.readFileSync("seed/labels.json", "utf8")) as { emails: unknown[] };
const checks = runPreflight(getDb(), { expectedSeedEmails: labels.emails.length });
checks.push(
  (await devServerUp())
    ? { level: "ok", label: "Dashboard up at http://localhost:3000" }
    : { level: "fail", label: "Dashboard not reachable at http://localhost:3000", fix: "npm run dev" },
);

for (const c of checks) console.log(`${ICON[c.level]} ${c.label}${c.fix && c.level !== "ok" ? `\n    → ${c.fix}` : ""}`);
const fails = checks.filter((c) => c.level === "fail").length;
const warns = checks.filter((c) => c.level === "warn").length;
console.log(`\n${fails ? `${fails} blocking` : "Ready"}${warns ? `, ${warns} warning(s)` : ""}.`);
process.exit(fails ? 1 : 0);
