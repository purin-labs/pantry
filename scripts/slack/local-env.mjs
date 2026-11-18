import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

export async function upsertLocalEnv(path, values) {
  const existing = await readOptionalText(path);
  const next = replaceEnvValues(existing, values);
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;

  await writeFile(temporaryPath, next, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export async function removeLocalEnvValues(path, keys) {
  const existing = await readOptionalText(path);
  const next = removeEnvValues(existing, keys);
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;

  await writeFile(temporaryPath, next, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export function replaceEnvValues(source, values) {
  const pending = new Map(Object.entries(values));
  const seen = new Set();
  const output = [];

  for (const line of source.split(/\r?\n/u)) {
    const key = envLineKey(line);

    if (key === null || !pending.has(key)) {
      output.push(line);
      continue;
    }

    if (!seen.has(key)) {
      output.push(`${key}=${quoteEnvValue(pending.get(key))}`);
      seen.add(key);
    }
  }

  for (const [key, value] of pending) {
    if (!seen.has(key)) {
      output.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return `${trimTrailingBlankLines(output).join("\n")}\n`;
}

export function removeEnvValues(source, keys) {
  const removed = new Set(keys);
  const output = source.split(/\r?\n/u).filter(function retainEnvLine(line) {
    const key = envLineKey(line);
    return key === null || !removed.has(key);
  });

  return `${trimTrailingBlankLines(output).join("\n")}\n`;
}

function envLineKey(line) {
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
  return match?.[1] ?? null;
}

function quoteEnvValue(value) {
  if (typeof value !== "string") {
    throw new Error("Local env values must be strings");
  }

  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function trimTrailingBlankLines(lines) {
  const output = [...lines];

  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }

  return output;
}

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return "";
    }

    throw error;
  }
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
