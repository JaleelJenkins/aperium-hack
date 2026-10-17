export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const DAY = 86400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Overdue · Oct 16", "Due today", "Due tomorrow", "Due Tue", "Due Oct 28". */
export function dueText(iso: string, overdue: boolean, now = Date.now()): string {
  const t = Date.parse(iso);
  const short = new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (overdue) return `Overdue · ${short}`;
  const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY);
  if (days <= 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days < 7) return `Due ${new Date(t).toLocaleDateString("en-US", { weekday: "short" })}`;
  return `Due ${short}`;
}

/** "claude-opus" / "claude-opus-5-5" -> "Opus". */
export function modelShort(id: string | null): string {
  if (!id) return "";
  const word = id.replace(/^claude-/, "").split(/[-_]/)[0];
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function initials(name: string): string {
  const words = name.replace(/&/g, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
}

/** Stable hue per name, for avatars. */
export function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
