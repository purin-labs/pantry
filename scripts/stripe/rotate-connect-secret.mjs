#!/usr/bin/env node

// Replaces the Stripe Connect platform secret after a roll in the Stripe
// dashboard. Copy the new key in the dashboard, then run this script. It reads
// the key from the clipboard, checks it against Stripe, writes it in place of
// the old key in every local env file that holds the old key, uploads it to
// the production Worker and clears the clipboard. It prints no key.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const NAME = "STRIPE_CONNECT_CLIENT_SECRET";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function keyIn(text) {
  const line = text
    .split("\n")
    .find((entry) => new RegExp(`^\\s*(export\\s+)?${NAME}\\s*=`).test(entry));
  return line
    ?.replace(/^[^=]*=/u, "")
    .trim()
    .replace(/^["']|["']$/gu, "");
}

function mode(key) {
  if (/^sk_test_[A-Za-z0-9]{16,}$/u.test(key)) return "test";
  if (/^sk_live_[A-Za-z0-9]{16,}$/u.test(key)) return "live";
  return undefined;
}

async function stripeAccount(key) {
  const response = await fetch("https://api.stripe.com/v1/account", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) return { status: response.status };
  const account = await response.json();
  return { status: response.status, id: account.id };
}

async function main() {
  const oldKey = keyIn(readFileSync(join(root, ".env.local"), "utf8"));
  if (oldKey === undefined) throw new Error(`.env.local has no ${NAME}`);
  const newKey = execFileSync("pbpaste", { encoding: "utf8" }).trim();
  if (mode(newKey) === undefined)
    throw new Error("The clipboard holds no Stripe secret key (sk_test_…)");
  if (newKey === oldKey)
    throw new Error("The clipboard holds the old key; copy the rolled key");
  if (mode(newKey) !== mode(oldKey))
    throw new Error(
      `The new key is ${mode(newKey)} mode; the old key is ${mode(oldKey)} mode`,
    );

  const [before, after] = await Promise.all([
    stripeAccount(oldKey),
    stripeAccount(newKey),
  ]);
  if (after.status !== 200)
    throw new Error(`Stripe refused the new key (HTTP ${after.status})`);
  if (before.status === 200 && before.id !== after.id)
    throw new Error("The new key belongs to another Stripe account");
  console.log(`Stripe accepted the new ${mode(newKey)}-mode key.`);

  for (const directory of [".", "services/platform", "services/commerce"]) {
    let names = [];
    try {
      names = readdirSync(join(root, directory));
    } catch {
      continue;
    }
    for (const name of names.filter((entry) =>
      /^\.(env|dev\.vars)/u.test(entry),
    )) {
      const path = join(root, directory, name);
      const text = readFileSync(path, "utf8");
      if (!text.includes(oldKey)) continue;
      writeFileSync(path, text.split(oldKey).join(newKey));
      console.log(`Replaced the key in ${join(directory, name)}.`);
    }
  }

  const upload = spawnSync(
    process.execPath,
    [
      join(root, "scripts/cloudflare/sync-worker-secret.mjs"),
      NAME,
      "--env",
      "production",
    ],
    { cwd: root, env: { ...process.env, [NAME]: newKey }, stdio: "inherit" },
  );
  if (upload.error !== undefined) throw upload.error;
  if (upload.status !== 0) throw new Error(`The upload of ${NAME} failed`);

  execFileSync("pbcopy", { input: "" });
  console.log("Cleared the clipboard. The old key now stops at its expiry.");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
