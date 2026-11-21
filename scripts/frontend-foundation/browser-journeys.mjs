#!/usr/bin/env node

import { runBrowserCli } from "../browser-cli.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
// `--account-setup` runs only the setup dialog and the invitation page
// journey, on the Portal alone, with its own artifact folder.
const accountSetupOnly = process.argv.includes("--account-setup");
const storefrontUrl = (
  process.env.PANTRY_STOREFRONT_URL ?? "http://cafe.localhost:3001"
).replace(/\/$/u, "");
const portalUrl = (
  process.env.PANTRY_PORTAL_URL ?? "http://127.0.0.1:3103"
).replace(/\/$/u, "");
const artifactDir = join(
  root,
  accountSetupOnly
    ? "output/playwright/account-setup"
    : "output/playwright/frontend-foundation",
);
const daemonDir = join(artifactDir, "daemon");
const session = `frontend-foundation-${process.pid}`;
const storefrontFixture = join(
  root,
  "scripts/frontend-foundation/storefront-fixture.js",
);
const portalFixture = join(
  root,
  "scripts/plan21/browser-acceptance-fixture.js",
);
const cafeJourney = join(root, "scripts/frontend-foundation/cafe-journey.js");
const storeJourney = join(root, "scripts/frontend-foundation/store-journey.js");
const storeSoldoutFixture = join(
  root,
  "scripts/frontend-foundation/store-soldout-fixture.js",
);
const storeSoldoutJourney = join(
  root,
  "scripts/frontend-foundation/store-soldout-journey.js",
);
const storeEmptyFixture = join(
  root,
  "scripts/frontend-foundation/store-empty-fixture.js",
);
const storeEmptyJourney = join(
  root,
  "scripts/frontend-foundation/store-empty-journey.js",
);
const portalJourney = join(
  root,
  "scripts/frontend-foundation/portal-journey.js",
);
const accountSetupBundle = join(artifactDir, "account-setup-journey.js");

mkdirSync(daemonDir, { recursive: true });

const cliEnv = {
  ...process.env,
  PWTEST_DAEMON_SESSION_DIR: daemonDir,
  PLAYWRIGHT_BROWSERS_PATH:
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), "Library/Caches/ms-playwright"),
};

async function main() {
  try {
    if (!accountSetupOnly)
      await assertTargetAvailable(
        `${storefrontUrl}/store/cafe`,
        "storefront",
        "pnpm site",
      );
    await assertTargetAvailable(`${portalUrl}/portal`, "portal", "pnpm site");
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@purin-labs/platform",
        "exec",
        "esbuild",
        join(
          root,
          "scripts/frontend-foundation/portal-account-setup-journey.mjs",
        ),
        "--bundle",
        "--platform=browser",
        "--format=iife",
        "--global-name=SatyrSetupJourney",
        `--outfile=${accountSetupBundle}`,
      ],
      { cwd: root, stdio: "inherit" },
    );
    runCli("open", [
      "data:text/html,<title>Frontend foundation fixture</title>",
    ]);
    if (accountSetupOnly) {
      process.stdout.write(`[frontend] account setup targets ${portalUrl}\n`);
      runCli("run-code", ["--filename", portalFixture]);
      const accountSetup = runCli("run-code", [accountSetupBrowserCommand()]);
      writeFileSync(
        join(artifactDir, "report.json"),
        JSON.stringify({ result: "passed", portalUrl, accountSetup }, null, 2),
      );
      process.stdout.write("Account setup browser journey passed.\n");
      return;
    }
    process.stdout.write(
      `[frontend] browser journeys target ${storefrontUrl} and ${portalUrl}\n`,
    );
    runCli("run-code", ["--filename", storefrontFixture]);

    runCli("goto", [`${storefrontUrl}/store/cafe`]);
    const cafe = runCli("run-code", ["--filename", cafeJourney]);
    assertCheck(
      cafe.flavorMenuImagePresent &&
        cafeMenuItems().every(
          cafe.flavorMenuText.includes.bind(cafe.flavorMenuText),
        ),
      "café journey presents all twelve French–Taiwanese menu items",
    );
    assertCheck(
      cafe.quoteTotal === "¥1,925",
      "café journey quotes a mixed-flavor pickup order with oat milk",
    );
    assertCheck(
      cafe.languageRestored &&
        cafe.restoredQuantity === "3" &&
        cafe.restoredOatMilk,
      "café journey restores bilingual state, mixed-flavor quantities, and oat milk after review",
    );
    assertCheck(
      cafe.noHorizontalOverflow,
      "café journey fits the browser viewport",
    );

    runCli("screenshot", ["--filename", join(artifactDir, "cafe.png")]);
    runCli("goto", [`${storefrontUrl}/store/shipping`]);
    const store = runCli("run-code", ["--filename", storeJourney]);
    assertCheck(
      store.cardCount === 5 && store.keyboardSelected,
      "store journey renders five gift boxes and selects one by keyboard",
    );
    assertCheck(
      store.mixedBasket && store.quantity.startsWith("2"),
      "store journey keeps mixed basket lines and removes one before quoting",
    );
    assertCheck(
      store.validationFocus,
      "store journey focuses the first invalid field on an empty address submit",
    );
    assertCheck(
      store.quoteTotal === "¥11,974" &&
        store.carrierVisible &&
        store.matchaLineVisible,
      "store journey quotes the matcha box with the carrier and landed total",
    );
    assertCheck(
      store.selectionRestored &&
        store.recipient === "Aiko Sato" &&
        store.postalCode === "018957",
      "store journey restores the flavored selection and edits the shipping address",
    );
    assertCheck(
      store.noHorizontalOverflow && store.mobileFits,
      "store journey fits desktop and mobile viewports",
    );

    runCli("screenshot", ["--filename", join(artifactDir, "shipping.png")]);
    runCli("run-code", ["--filename", storeSoldoutFixture]);
    runCli("goto", [`${storefrontUrl}/store/shipping`]);
    const soldout = runCli("run-code", ["--filename", storeSoldoutJourney]);
    assertCheck(
      soldout.soldOutBadge && soldout.matchaDisabled,
      "store journey renders the sold-out box with a disabled control",
    );
    assertCheck(
      soldout.gingerEnabled && soldout.fallbackSummary,
      "store journey keeps other boxes purchasable and falls back to an available selection",
    );

    runCli("run-code", ["--filename", storeEmptyFixture]);
    runCli("goto", [`${storefrontUrl}/store/shipping`]);
    const empty = runCli("run-code", ["--filename", storeEmptyJourney]);
    assertCheck(
      empty.emptyStateVisible && empty.recovered,
      "store journey renders the empty catalog and recovers through Check again",
    );

    runCli("run-code", ["--filename", portalFixture]);
    const accountSetup = runCli("run-code", [accountSetupBrowserCommand()]);
    runCli("goto", [`${portalUrl}/portal?p21_auth=1&p21_provider=1`]);
    const portal = runCli("run-code", ["--filename", portalJourney]);
    assertCheck(
      portal.path === "/portal/cafe-browser-lab/main/operations",
      "portal journey keeps the canonical workspace route",
    );
    assertCheck(
      portal.approved && !portal.providerReceiptClaimed,
      "portal journey approves an operator change without inventing a provider receipt",
    );
    assertCheck(
      portal.noHorizontalOverflow,
      "portal journey fits the browser viewport",
    );
    assertCheck(
      portal.integrationsOverview,
      "integrations journey opens on the account overview and app catalogue",
    );
    assertCheck(
      portal.driveSearch,
      "integrations search finds Google Drive through its file aliases",
    );
    assertCheck(
      portal.driveDetail && portal.backRestored,
      "integrations journey opens Google Drive detail and returns focus to its tile",
    );
    assertCheck(
      portal.integrationsMobileFits,
      "integrations overview fits the narrow mobile viewport",
    );
    writeFileSync(
      join(artifactDir, "report.json"),
      JSON.stringify(
        { result: "passed", cafe, store, soldout, empty, accountSetup, portal },
        null,
        2,
      ),
    );
    runCli("screenshot", ["--filename", join(artifactDir, "portal.png")]);
    process.stdout.write("Frontend foundation browser journeys passed.\n");
  } catch (error) {
    writeFileSync(
      join(artifactDir, "report.json"),
      JSON.stringify(
        {
          result: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    try {
      runCli("snapshot");
      runCli("screenshot", ["--filename", join(artifactDir, "failure.png")]);
    } catch {
      // Preserve the original failure when the browser could not start.
    }
    throw error;
  } finally {
    closeBrowser();
  }
}

/** The browser CLI VM cannot import modules, so it receives the built journey. */
function accountSetupBrowserCommand() {
  return `async function accountSetupJourney(page) {
    ${readFileSync(accountSetupBundle, "utf8")}
    return SatyrSetupJourney.runAccountSetupJourney(page, ${JSON.stringify({ portalUrl, artifactDir })});
  }`;
}

function runCli(command, args = []) {
  return runBrowserCli(
    { root, session, env: cliEnv, artifactDir, timeoutMs: 180000 },
    command,
    args,
  );
}

async function assertTargetAvailable(url, label, startCommand) {
  try {
    const response = await fetch(url, { redirect: "manual" });
    if (response.status >= 200 && response.status < 400) return;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `${label} unavailable at ${url}; start it with ${startCommand}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertCheck(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`PASS ${message}\n`);
}

function cafeMenuItems() {
  return [
    "Sesame latte",
    "Sesame cookie",
    "Sesame financier",
    "Ginger milk tea",
    "Ginger cookie",
    "Ginger financier",
    "Taro milk tea",
    "Taro cookie",
    "Taro financier",
    "Matcha tea",
    "Matcha cookie",
    "Matcha financier",
  ];
}

function closeBrowser() {
  try {
    runCli("close");
  } catch {
    // The browser may not have opened when a prerequisite failed.
  }
}

await main();
