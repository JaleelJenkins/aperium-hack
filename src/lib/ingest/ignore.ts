/**
 * Senders that are never client mail: Google's own account and security
 * notices for the test inbox, bounces, and so on. Ingest skips them, so they
 * never reach triage or Reason.
 *
 * Add more without code changes: IGNORE_SENDERS in .env.local, a comma-separated
 * list of addresses (no-reply@x.com) or whole domains (@x.com).
 */
const BUILT_IN: RegExp[] = [
  /@accounts\.google\.com$/i, // security alerts, recovery-contact notices
  /^no-?reply@google\.com$/i,
  /^googlecommunityteam-noreply@google\.com$/i,
  /^workspace-noreply@google\.com$/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
];

function fromEnv(): string[] {
  return (process.env.IGNORE_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isIgnoredSender(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  if (BUILT_IN.some((re) => re.test(e))) return true;
  return fromEnv().some((rule) => (rule.startsWith("@") ? e.endsWith(rule) : e === rule));
}
