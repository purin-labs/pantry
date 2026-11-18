// Checks that a Portal build holds each shop gateway build with its digest in the install script.
// A production upload without them serves an installer that fails on every shop computer.
// Usage: node services/shop-gateway/check-pack.mjs <Portal dist>/shop-gateway
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GATEWAY_TARGETS = [
  "aarch64-apple-darwin",
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
];

/** The targets that the packed install script cannot install. */
export function missingGatewayBuilds(directory) {
  const script = join(directory, "install.sh");
  if (!existsSync(script)) return [...GATEWAY_TARGETS];
  const text = readFileSync(script, "utf8");
  return GATEWAY_TARGETS.filter((target) => {
    const binary = join(directory, target, "shop-gateway");
    if (!existsSync(binary)) return true;
    const digest = createHash("sha256")
      .update(readFileSync(binary))
      .digest("hex");
    return !text.includes(`TARGET=${target}; WANT='${digest}'`);
  });
}

export function requireGatewayBuilds(directory) {
  const missing = missingGatewayBuilds(directory);
  if (missing.length > 0)
    throw new Error(
      `The Portal build has no shop gateway build for ${missing.join(", ")}, so the installer would fail on those computers. Run \`bash services/shop-gateway/build.sh\`, then \`pnpm portal:build\`, and deploy again.`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw new Error("Provide the packed shop-gateway directory to check.");
  requireGatewayBuilds(resolve(process.argv[2]));
  console.log(
    "ok      shop gateway builds and digests match the install script",
  );
}
