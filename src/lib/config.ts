import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.split("#")[0].trim());
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  get dataDir() {
    return path.resolve(process.env.DATA_DIR || "./data");
  },
  get dbPath() {
    return path.join(this.dataDir, "client-pulse.db");
  },
  get attachmentsDir() {
    return path.join(this.dataDir, "attachments");
  },
  google: {
    get clientId() {
      return process.env.GOOGLE_CLIENT_ID || "";
    },
    get clientSecret() {
      return process.env.GOOGLE_CLIENT_SECRET || "";
    },
    get redirectUri() {
      return process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/auth/google/callback";
    },
  },
  get pollIntervalMs() {
    return num("POLL_INTERVAL_MS", 10_000);
  },
  get bootstrapDays() {
    return num("BOOTSTRAP_DAYS", 7);
  },
  get bootstrapMaxMessages() {
    return num("BOOTSTRAP_MAX_MESSAGES", 100);
  },
  get maxAttachmentBytes() {
    return num("MAX_ATTACHMENT_BYTES", 20_000_000);
  },
};

export function assertGoogleConfigured(): void {
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}. Copy .env.example to .env.local and fill it in.`);
  }
}
