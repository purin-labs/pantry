#!/usr/bin/env node
// The Portal's own voice code for the benches (Plan 82C): esbuild bundles
// `features/voice/command.ts` with `@seams/control-api`, so a bench scores with
// the shipped rules and keeps no copy of them.
//
// As a module: `const voice = await loadPortalVoice()`.
// As a program, for a Python bench: `node scripts/shop-voice/portal-voice.mjs kept`
// reads `{"names": [...], "texts": [...]}` on stdin and writes the kept text of
// each, as `keptVoiceText` gives it ("" when the Portal drops the text).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const portal = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/portal",
);

export async function loadPortalVoice() {
  // esbuild comes with the Portal's Vite.
  const fromPortal = createRequire(join(portal, "package.json"));
  const { build } = createRequire(fromPortal.resolve("vite"))("esbuild");
  const bundle = await build({
    stdin: {
      contents: `export * from "./src/features/voice/command.ts";
export { keptVoiceText, normalizeVoicePhrase, voiceMacDeadlineMs } from "@seams/control-api";`,
      resolveDir: portal,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "error",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
}

if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.argv[2] === "kept"
) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { names, texts } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const voice = await loadPortalVoice();
  process.stdout.write(
    JSON.stringify(texts.map((text) => voice.keptVoiceText(text, names))),
  );
}
