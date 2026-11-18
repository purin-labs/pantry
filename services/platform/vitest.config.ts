import { fileURLToPath, URL as NodeUrl } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/e2e/**", "**/node_modules/**", "**/.git/**"],
    globalSetup: ["tests/commerce-fixture-worker-setup.ts"],
  },
  resolve: {
    alias: [
      {
        find: "../../../../packages/contracts/media-wasm-pkg/media_inspect_bg.wasm?module",
        replacement: fileURLToPath(
          new NodeUrl("./tests/media-wasm-module.ts", import.meta.url),
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
