import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  readWorkerEnvironment,
  requireLocalWorkerSecrets,
  validateWorkerOrigins,
} from "./worker-environment.mjs";

test("local startup requires its own secrets file; unavailable targets fail", function explicitTargets() {
  const directory = mkdtempSync(resolve(tmpdir(), "satyr-startup-"));
  try {
    const config = readWorkerEnvironment("platform", "local");
    assert.throws(
      requireLocalWorkerSecrets.bind(null, "platform", {
        ...config,
        configPath: resolve(directory, "wrangler.jsonc"),
      }),
      /required .dev.vars.local is missing/u,
    );
    assert.throws(
      readWorkerEnvironment.bind(null, "platform", "preview"),
      /Select local, staging or production/u,
    );
    assert.throws(
      readWorkerEnvironment.bind(null, "platform", undefined),
      /Select local, staging or production/u,
    );
    const production = readWorkerEnvironment("platform", "production");
    assert.throws(
      validateWorkerOrigins.bind(null, "platform", "production", {
        ...production,
        vars: {
          ...production.vars,
          SATYR_OAUTH_CALLBACK_ORIGIN: "http://localhost:8787",
        },
      }),
      /SATYR_OAUTH_CALLBACK_ORIGIN/u,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("local platform startup does not require Slack configuration", function optionalSlack() {
  const directory = mkdtempSync(resolve(tmpdir(), "satyr-startup-"));
  try {
    writeFileSync(
      resolve(directory, ".dev.vars.local"),
      [
        "SESSION_TOKEN_SECRET=test-session-secret",
        "SLACK_OAUTH_STATE_SECRET=test-oauth-state-secret",
        "UNDERCLERK_SERVICE_TOKEN=test-service-token",
        "ACCOUNT_PLATFORM_PROVISION_TOKEN=test-account-provision",
        "ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U=test-account-private-key",
        "ACCOUNT_PLATFORM_PROVISION_ASSERTION_JWK=test-account-public-key",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const config = readWorkerEnvironment("platform", "local");

    assert.doesNotThrow(
      requireLocalWorkerSecrets.bind(null, "platform", {
        ...config,
        configPath: resolve(directory, "wrangler.jsonc"),
      }),
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
