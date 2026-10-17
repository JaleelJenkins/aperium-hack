import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// Same "@/*" -> src/* alias as tsconfig.json, so tests can import app code (route handlers, pages).
export default defineConfig({
  resolve: { alias: { "@": path.join(root, "src") } },
});
