// A ratchet on a count for each file: the baseline lists each file with a
// count above zero. A listed file may not pass its count, and a file that is
// not listed must stay at zero. When a file loses a count, lower its entry
// with --update.
//
//   check      fails when a file passes its entry
//   --update   lowers entries and drops the files at zero
//   --init     writes the baseline from the current tree
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Runs one count ratchet and ends the process with its exit code.
 *
 * `count(file, text)` gives the count of one tracked file, and zero for a file
 * that the ratchet does not read. `refusal(file, count, allowed)` is the error
 * line for a file over its entry.
 */
export function runCountRatchet({ name, script, baseline, count, refusal }) {
  const mode = process.argv[2] ?? "check";
  if (!["check", "--update", "--init"].includes(mode)) {
    console.error(`unknown argument ${mode}`);
    process.exit(2);
  }
  const current = new Map();
  const files = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\n");
  for (const file of files) {
    if (file === "") continue;
    let text = null;
    const read = () => {
      // Read only the files that the ratchet asks for.
      if (text === null) text = readFileSync(join(root, file), "utf8");
      return text;
    };
    let found;
    try {
      found = count(file, read);
    } catch (error) {
      if (error?.code === "ENOENT") continue; // listed by git, deleted in the tree
      throw error;
    }
    if (found > 0) current.set(file, found);
  }
  const total = (entries) =>
    [...entries.values()].reduce((sum, value) => sum + value, 0);
  const write = (entries) => {
    const sorted = Object.fromEntries(
      [...entries].sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(
      join(root, baseline),
      `${JSON.stringify({ files: sorted }, null, 2)}\n`,
    );
  };
  if (mode === "--init") {
    write(current);
    console.log(
      `${name}: wrote ${current.size} files with a count of ${total(current)} to ${baseline}`,
    );
    process.exit(0);
  }
  const allowedBy = new Map(
    Object.entries(JSON.parse(readFileSync(join(root, baseline), "utf8")).files),
  );
  const errors = [];
  let lower = 0;
  for (const [file, found] of current) {
    const allowed = allowedBy.get(file) ?? 0;
    if (found > allowed) errors.push(refusal(file, found, allowed));
    else if (found < allowed) lower += 1;
  }
  for (const file of allowedBy.keys()) if (!current.has(file)) lower += 1;
  if (mode === "--update") {
    const next = new Map(
      [...allowedBy]
        .map(([file, allowed]) => [
          file,
          Math.min(allowed, current.get(file) ?? 0),
        ])
        .filter(([, value]) => value > 0),
    );
    write(next);
    console.log(
      `${name}: ${next.size} files remain, with a count of ${total(next)}`,
    );
  } else if (lower > 0)
    console.log(
      `${name}: ${lower} files have a lower count; run node ${script} --update`,
    );
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exit(1);
  if (mode === "check")
    console.log(
      `${name}: ${current.size} files with a count of ${total(current)}, none grew`,
    );
}
