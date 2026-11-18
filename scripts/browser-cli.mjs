import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function cliCommand() {
  const explicit = process.env.PLAYWRIGHT_CLI;
  if (explicit !== undefined && explicit.length > 0)
    return { file: explicit, args: [] };
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const wrapper = join(
    codexHome,
    "skills/playwright/scripts/playwright_cli.sh",
  );
  if (existsSync(wrapper)) return { file: "bash", args: [wrapper] };
  try {
    const global = execFileSync("sh", ["-lc", "command -v playwright-cli"], {
      encoding: "utf8",
    }).trim();
    if (global.length > 0) return { file: global, args: [] };
  } catch {
    // Fall through to the dependency-free npx wrapper.
  }
  return {
    file: "npx",
    args: ["--yes", "--package", "@playwright/cli", "playwright-cli"],
  };
}

export function runBrowserCli(options, command, args = []) {
  const { root, session, env, artifactDir, timeoutMs } = options;
  const cli = cliCommand();
  const result = spawnSync(
    cli.file,
    [...cli.args, "--session", session, "--json", command, ...args],
    {
      cwd: root,
      env,
      timeout: timeoutMs,
      // A journey's result is its evidence; the oven financier one is ~17 MB.
      maxBuffer: 128 * 1024 * 1024,
      encoding: "utf8",
    },
  );
  const prefix = join(artifactDir, `${Date.now()}-${command}`);
  writeFileSync(`${prefix}.stdout.txt`, result.stdout ?? "");
  writeFileSync(`${prefix}.stderr.txt`, result.stderr ?? "");
  // spawnSync reports its own kill as a bare ETIMEDOUT; name the command and
  // its limit, so that a slow journey does not read as a lost browser.
  if (result.error?.code === "ETIMEDOUT")
    throw new Error(
      `${command} ran longer than its ${timeoutMs / 1000} s limit and was stopped`,
    );
  if (result.error !== undefined) throw result.error;
  const output = result.stdout.trim();
  if (result.status !== 0) {
    const diagnostic = [output, result.stderr.trim()]
      .filter(hasText)
      .join("\n");
    throw new Error(`${command} failed (${result.status}): ${diagnostic}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${command} returned non-JSON output: ${output}`);
  }
  if (parsed.isError === true)
    throw new Error(`${command} failed: ${parsed.error ?? output}`);
  const value = parsed.result ?? parsed;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hasText(value) {
  return value.length > 0;
}
