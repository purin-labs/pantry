// Writes the install script and the gateway binaries into the Portal's assets, so that a
// shop computer installs the version that the deployed Worker serves.
// Usage: node services/shop-gateway/pack.mjs <output folder>
// A target with no build gets no binary, and the script says so on that computer.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GATEWAY_TARGETS as targets } from "./check-pack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2]);
let script = readFileSync(resolve(here, "install.sh"), "utf8");
mkdirSync(output, { recursive: true });
for (const target of targets) {
  const binary = join(here, "dist", target, "shop-gateway");
  if (!existsSync(binary)) continue;
  const bytes = readFileSync(binary);
  mkdirSync(join(output, target), { recursive: true });
  writeFileSync(join(output, target, "shop-gateway"), bytes);
  script = script.replace(
    `__DIGEST_${target}__`,
    createHash("sha256").update(bytes).digest("hex"),
  );
}
writeFileSync(join(output, "install.sh"), script, { mode: 0o755 });
