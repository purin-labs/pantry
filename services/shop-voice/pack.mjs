// Writes the install script with the service's source inside it, for the Portal's assets, so
// that a shop Mac installs the version that the deployed Worker serves.
// Usage: node services/shop-voice/pack.mjs <output file>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2]);
// bsdtar on a Mac adds AppleDouble files unless it is told not to. GNU tar on Linux
// has no such files and refuses the option.
const macOnly = process.platform === "darwin" ? ["--no-mac-metadata"] : [];
const archive = execFileSync(
  "tar",
  [
    "-czf",
    "-",
    ...macOnly,
    "--exclude",
    "__pycache__",
    "shop_voice",
    "requirements.lock",
  ],
  { cwd: here, env: { ...process.env, COPYFILE_DISABLE: "1" } },
);
const script = readFileSync(resolve(here, "install.sh"), "utf8").replace(
  "__SHOP_VOICE_PAYLOAD__",
  archive.toString("base64"),
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, script, { mode: 0o755 });
