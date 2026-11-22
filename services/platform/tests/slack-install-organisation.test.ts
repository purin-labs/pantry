import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { describe, expect, it } from "vitest";

import { createOrganisationInstall } from "@purin-labs/tenancy/data/organisation";
import { readAccessControlView } from "@purin-labs/authority/access-control/read-model";
import { READ_AND_PROPOSE_ORGANISATION_GRANT_IDS } from "@purin-labs/authority/data/capability-policy";
import { parseVaultHandle } from "@purin-labs/authority/credential-vault/index";
import {
  newSlackInstallationId,
  parseSlackAppId,
} from "@purin-labs/kernel/ids";
import { parseInitialOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { admitSlackInstallOrganisation } from "../src/slack/install-organisation";
import type { SlackInstallationIdentity } from "@purin-labs/connections/slack/installation-identity";
import { createSlackInstallation } from "@purin-labs/authority/slack/installation-store";
import { createMigratedDatabase } from "./sqlite-d1";
import { requireOrganisationId, requireWorkspaceId } from "./test-ids";
import "./provide-organisation-lifecycle-parts";

describe("Slack install organisation admission", function slackInstallOrganisationAdmissionSuite() {
  it(
    "creates an install with readable access controls and baseline grants",
    createsInstallAccessControls,
  );
  it("routes an existing workspace to its organisation flow", async function rejectsExistingOrganisation() {
    const db = createMigratedDatabase();
    const organisationId = requireOrganisationId(
      "organisation_existing_portal",
    );
    const workspaceId = requireWorkspaceId("T_EXISTING");
    const now = 1_784_555_000_000;

    await createOrganisationInstall(db, db, {
      organisationId,
      name: "watchgod",
      surfaceKind: "slack",
      workspaceId,
      installModel: "unlisted",
      botTokenRef: "vault:slack:bot:t_existing",
      scopes: ["app_mentions:read"],
      placement: requiredInitialPlacement(),
      createdAt: now,
      installedAt: now,
    });

    await seedVaultRow(db, organisationId, "vault:slack:bot:t_existing", now);
    await seedVaultRow(
      db,
      organisationId,
      "vault:slack:bot:t_existing_rotated",
      now + 1,
    );

    await createOrganisationInstall(db, db, {
      organisationId,
      name: "watchgod",
      surfaceKind: "slack",
      workspaceId,
      installModel: "unlisted",
      botTokenRef: "vault:slack:bot:t_existing_rotated",
      scopes: ["app_mentions:read", "chat:write"],
      placement: requiredInitialPlacement(),
      createdAt: now,
      installedAt: now + 1,
    });
    await seedPhysicalSlackInstallation(
      db,
      organisationId,
      workspaceId,
      "vault:slack:bot:t_existing_rotated",
      now + 2,
    );

    const admitted = await admitSlackInstallOrganisation({
      placement: requiredInitialPlacement(),
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      workspaceId,
      installationIdentity: slackInstallationIdentity(),
      teamName: "watchgod",
      occurredAt: now + 2,
    });

    expect(admitted).toMatchObject({
      ok: false,
      error: {
        code: "slack_install_existing_workspace_requires_organisation_flow",
      },
    });
    expect(await organisationExists(db, "organisation_T_EXISTING")).toBe(false);
    await expectCredentialGenerations(db, organisationId, [
      { generation: 1, lifecycle: "superseded" },
      { generation: 2, lifecycle: "active" },
    ]);
    await expectVaultRevocation(
      db,
      organisationId,
      "vault:slack:bot:t_existing",
      now + 1,
    );
    await expectVaultRevocation(
      db,
      organisationId,
      "vault:slack:bot:t_existing_rotated",
      null,
    );
  });

  it("prepares a new install organisation", async function preparesNewOrganisation() {
    const db = createMigratedDatabase();
    const workspaceId = requireWorkspaceId("T_NEW");
    const now = 1_784_555_000_000;

    const admitted = await admitSlackInstallOrganisation({
      placement: requiredInitialPlacement(),
      env: {
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      workspaceId,
      installationIdentity: slackInstallationIdentity(),
      teamName: "New workspace",
      occurredAt: now,
    });
    expect(admitted).toMatchObject({
      ok: true,
      value: {
        kind: "cloudflare_native_bootstrap",
        organisationId: "organisation_T_NEW",
      },
    });
    await expect(
      admitSlackInstallOrganisation({
        placement: requiredInitialPlacement(),
        env: {
          DB: db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        workspaceId,
        installationIdentity: slackInstallationIdentity(),
        teamName: "New workspace",
        occurredAt: now + 1,
      }),
    ).resolves.toEqual(admitted);

    const organisationId = requireOrganisationId("organisation_T_NEW");
    expect(await organisationExists(db, organisationId)).toBe(true);
  });
});

async function createsInstallAccessControls(): Promise<void> {
  const db = createMigratedDatabase();
  const organisationId = requireOrganisationId("organisation_install_access");
  const now = 1_784_555_000_000;
  await createOrganisationInstall(db, db, {
    organisationId,
    name: "Install access",
    surfaceKind: "slack",
    workspaceId: requireWorkspaceId("T_INSTALL_ACCESS"),
    installModel: "unlisted",
    botTokenRef: "vault:slack:bot:t_install_access",
    scopes: ["app_mentions:read"],
    placement: requiredInitialPlacement(),
    createdAt: now,
    installedAt: now,
  });

  const view = await readAccessControlView({
    db,
    organisationId,
    requesterRole: "owner",
    grantOffset: 0,
    sourcePolicyOffset: 0,
  });
  expect(view.ok).toBe(true);
  const grants = await db
    .prepare("SELECT grant_id FROM access_grant WHERE organisation_id = ?")
    .bind(organisationId)
    .all<{ grant_id: string }>();
  expect(grants.results.map(readGrantId).sort()).toEqual(
    [...READ_AND_PROPOSE_ORGANISATION_GRANT_IDS].sort(),
  );
}

function readGrantId(row: { grant_id: string }): string {
  return row.grant_id;
}

async function seedVaultRow(
  db: SingleDatabase,
  organisationId: string,
  handle: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vault_secret (
       organisation_id, vault_handle, key_version, algorithm, nonce_b64,
       ciphertext_b64, created_at, rotated_at, revoked_at
     ) VALUES (?, ?, 'v1', 'AES-GCM-256', 'nonce', 'ciphertext', ?, NULL, NULL)`,
    )
    .bind(organisationId, handle, now)
    .run();
}

async function seedPhysicalSlackInstallation(
  db: SingleDatabase,
  organisationId: ReturnType<typeof requireOrganisationId>,
  workspaceId: ReturnType<typeof requireWorkspaceId>,
  handleRaw: string,
  now: number,
): Promise<void> {
  const handle = parseVaultHandle(handleRaw);
  if (!handle.ok) {
    throw new Error(`Invalid vault handle: ${handleRaw}`);
  }
  const identity = slackInstallationIdentity();
  await createSlackInstallation(db, {
    installationId: newSlackInstallationId(),
    environment: identity.environment,
    appId: identity.appId,
    workspaceId,
    credentialOrganisationId: organisationId,
    botTokenRef: handle.value,
    installModel: "unlisted",
    scopes: ["app_mentions:read", "chat:write"],
    installedAt: now,
  });
}

function slackInstallationIdentity(): SlackInstallationIdentity {
  const appId = parseSlackAppId("A_PLAN_25B_TEST");
  if (!appId.ok) {
    throw new Error("Invalid Slack app test identity");
  }
  return { environment: "development", appId: appId.value };
}

async function expectVaultRevocation(
  db: SingleDatabase,
  organisationId: string,
  handle: string,
  revokedAt: number | null,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT revoked_at AS revokedAt
     FROM vault_secret
     WHERE organisation_id = ? AND vault_handle = ?`,
    )
    .bind(organisationId, handle)
    .first<{ readonly revokedAt: number | null }>();

  expect(row).toEqual({ revokedAt });
}

function requiredInitialPlacement() {
  const parsed = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });

  if (!parsed.ok) {
    throw new Error(`Invalid placement: ${parsed.error.path}`);
  }

  return parsed.value;
}

async function organisationExists(
  db: SingleDatabase,
  organisationId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT organisation_id AS organisationId FROM organisation WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ organisationId: string }>();

  return row !== null;
}

async function expectCredentialGenerations(
  db: SingleDatabase,
  organisationId: string,
  expected: readonly {
    readonly generation: number;
    readonly lifecycle: string;
  }[],
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT credential_generation AS generation, lifecycle
     FROM provider_credential_generation
     WHERE organisation_id = ? AND provider = 'slack'
     ORDER BY credential_generation`,
    )
    .bind(organisationId)
    .all<{ generation: number; lifecycle: string }>();

  expect(rows.results).toEqual(expected);
}
