import { fileURLToPath, URL as NodeUrl } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**"],
    // Every Commerce test is a journey against a disposable backend. On a CI
    // runner a short journey takes 6 s, so the 5 s Vitest default fails it.
    testTimeout: 60_000,
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
