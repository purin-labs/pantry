import { fileURLToPath, URL as NodeUrl } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**"],
  },
  resolve: {
    alias: [
      {
        find: "quickjs-wasi/quickjs.wasm?module",
        replacement: fileURLToPath(
          new NodeUrl("./tests/quickjs-wasm-module.ts", import.meta.url),
        ),
      },
      {
        find: "cloudflare:workers",
        replacement: fileURLToPath(
          new NodeUrl("./tests/cloudflare-workers-module.ts", import.meta.url),
        ),
      },
    ],
  },
});
