import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Pin the project root so a stray package-lock.json in a parent folder
// (e.g. the home directory) doesn't make Next.js guess the wrong workspace.
const root = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: root,
};

export default nextConfig;
