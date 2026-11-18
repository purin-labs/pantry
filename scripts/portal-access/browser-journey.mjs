#!/usr/bin/env node

// Drives the access page and the connector consent sheet in the dev preview
// harnesses (/access-preview.html and /integrations-preview.html), which mount
// the real routes on in-memory transports. Start the portal with `pnpm portal`,
// then run `node scripts/portal-access/browser-journey.mjs`.

import { runBrowserCli } from "../browser-cli.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const portalUrl = (
  process.env.SATYR_PORTAL_URL ?? "http://127.0.0.1:3103"
).replace(/\/$/u, "");
const artifactDir = join(root, "output/playwright/portal-access");
const daemonDir = join(artifactDir, "daemon");
const session = `portal-access-${process.pid}`;
const journey = join(root, "scripts/portal-access/access-journey.js");
const consentJourney = join(
  root,
  "scripts/portal-access/connect-consent-journey.js",
);
const previewUrl = `${portalUrl}/access-preview.html?scenario=populated&view=access`;

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
    await assertTargetAvailable(previewUrl);
    runCli("open", [previewUrl]);
    const access = runCli("run-code", ["--filename", journey]);
    assertCheck(
      access.tabsRemoved &&
        access.systems.join("|") ===
          [
            "Stripe · Nuki Cafe",
            "Google Drive · nuki.cafe",
            "Shopify · nuki-cafe.myshopify.com",
            "Commerce records",
            "Seams Pantry workspace",
          ].join("|"),
      "access journey lists one row for each system and no tabs",
    );
    assertCheck(
      access.closedSummary.startsWith("Not shared") &&
        access.closedNotice.includes("Shopify · nuki-cafe.myshopify.com"),
      "access journey flags the connected system that nobody can use",
    );
    assertCheck(
      access.offered.includes("Cancel a Shopify order") &&
        !access.offered.some(isStripeAction),
      "access journey offers only the system's actions in its share dialog",
    );
    assertCheck(
      access.sharedSummary.startsWith("Shared with 1 · 1 can change") &&
        access.noticeAfterShare === 0 &&
        access.sharedRecipient.includes("#cafe-ops") &&
        access.sharedRecipient.includes("Can change, asks first"),
      "access journey shows the new recipient with its level after a grant",
    );
    assertCheck(
      access.canChange.join("|") ===
        "Stripe · Nuki Cafe|Shopify · nuki-cafe.myshopify.com" &&
        access.searched.join("|") === "Google Drive · nuki.cafe",
      "access journey narrows the list by level and by scope text",
    );
    assertCheck(
      access.revokedSummary.startsWith("Not shared") &&
        access.revokedRecord.includes("Removed earlier") &&
        access.focusAfterRevoke &&
        access.noticeAfterRevoke === 1,
      "access journey closes the system after a revoke, keeps the record and keeps focus in the drawer",
    );
    assertCheck(
      access.decisionTitle === "Delivery denied",
      "access journey answers a data-flow check in place",
    );
    assertCheck(
      access.actionSearch === "Stripe" &&
        access.actionCount === "8 of 29 actions" &&
        access.returned === "access",
      "access journey opens one system's actions and returns to the list",
    );
    assertCheck(
      access.viewerControls === 0 && access.viewerRecipients > 0,
      "access journey gives a viewer the list with no grant or revoke control",
    );
    assertCheck(
      access.mobileFits,
      "access journey fits the narrow mobile viewport",
    );
    runCli("screenshot", ["--filename", join(artifactDir, "access.png")]);
    const consent = runCli("run-code", ["--filename", consentJourney]);
    assertCheck(
      consent.points.length === 3 &&
        consent.windowsAtConsent === consent.windowsBefore,
      "consent journey explains the sign-in before any provider window opens",
    );
    assertCheck(
      consent.detailStillOpen &&
        consent.focusReturned &&
        consent.windowsAfterCancel === consent.windowsBefore,
      "consent journey cancels with Escape and starts no sign-in",
    );
    assertCheck(
      consent.providerUrl.includes("popup=dropbox") &&
        consent.consentClosed &&
        consent.filesSetupDirected,
      "consent journey opens the provider window and continues to file access setup",
    );
    assertCheck(
      consent.inlineDisclosure && consent.gmailCompleted && consent.mobileFits,
      "consent journey respects Gmail's inline disclosure and fits the mobile viewport",
    );
    writeReport({ result: "passed", access, consent });
    process.stdout.write("Portal access browser journeys passed.\n");
  } catch (error) {
    writeReport({
      result: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      runCli("screenshot", ["--filename", join(artifactDir, "failure.png")]);
    } catch {
      // Preserve the original failure when the browser could not start.
    }
    throw error;
  } finally {
    try {
      runCli("close");
    } catch {
      // The browser may not have opened when a prerequisite failed.
    }
  }
}

function runCli(command, args = []) {
  return runBrowserCli(
    { root, session, env: cliEnv, artifactDir, timeoutMs: 180000 },
    command,
    args,
  );
}

function writeReport(report) {
  writeFileSync(
    join(artifactDir, "report.json"),
    JSON.stringify(report, null, 2),
  );
}

async function assertTargetAvailable(url) {
  try {
    const response = await fetch(url, { redirect: "manual" });
    if (response.status >= 200 && response.status < 400) return;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `portal unavailable at ${url}; start it with pnpm portal. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertCheck(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`PASS ${message}\n`);
}

function isStripeAction(label) {
  return label.includes("Stripe");
}

await main();
