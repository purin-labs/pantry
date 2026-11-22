import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it, vi } from "vitest";

import gateway from "../src/integration-gateway";
import { issueControlSession, upsertUser } from "@purin-labs/tenancy/data/control-plane";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  upsertSurfaceInstallation,
} from "@purin-labs/connections/data/integration-account";
import { parseVaultHandle } from "../src/credential-vault";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { isRecord } from "@purin-labs/std";
import { createMigratedDatabase } from "./sqlite-d1";
import {
  platformEnv,
  testExecutionContext,
  type UnitTestEnv,
} from "./worker-fakes";

const ADMIN_TOKEN = "identity-link-authority-admin-token";
const ORIGIN = "https://pantry.example";
const WORKSPACE_ID = "T0IDENTITYLINK";

describe("provider-neutral identity linking", identityLinkSuite);

function identityLinkSuite(): void {
  it(
    "binds the exact Slack identity to an authenticated organisation member once",
    linksAuthenticatedMemberOnce,
  );
  it(
    "accepts Google's alternate issuer through the same link contract",
    linksAlternateGoogleIssuer,
  );
  it(
    "accepts a passkey-authenticated session through the same link contract",
    linksPasskeyIssuer,
  );
  it(
    "accepts a Seams-authenticated session through the same link contract",
    linksSeamsIssuer,
  );
  it(
    "does not consume the challenge for a non-member",
    rejectsNonMemberWithoutConsumption,
  );
}

async function linksAlternateGoogleIssuer(): Promise<void> {
  const fixture = await createFixture({ issuer: "accounts.google.com" });
  const token = await issueLink(fixture, "U0IDENTITYGOOGLE");
  const completed = await completeLink(
    token,
    fixture.ownerSession,
    fixture.env,
  );
  expect(completed.status).toBe(200);
  await expect(completed.json()).resolves.toMatchObject({
    link: {
      verifiedBy: "google",
      userId: fixture.ownerUserId,
    },
  });
}

async function linksPasskeyIssuer(): Promise<void> {
  const fixture = await createFixture({ issuer: "urn:pantry:passkey" });
  const token = await issueLink(fixture, "U0IDENTITYPASSKEY");
  const completed = await completeLink(
    token,
    fixture.ownerSession,
    fixture.env,
  );
  expect(completed.status).toBe(200);
  await expect(completed.json()).resolves.toMatchObject({
    link: {
      verifiedBy: "passkey",
      userId: fixture.ownerUserId,
    },
  });
  await expect(
    readPersistedLink(fixture.db, "U0IDENTITYPASSKEY"),
  ).resolves.toMatchObject({
    verifiedBy: "passkey",
  });
}

async function linksSeamsIssuer(): Promise<void> {
  const fixture = await createFixture({ issuer: "urn:pantry:seams" });
  const token = await issueLink(fixture, "U0IDENTITYSEAMS");
  const completed = await completeLink(
    token,
    fixture.ownerSession,
    fixture.env,
  );
  expect(completed.status).toBe(200);
  await expect(completed.json()).resolves.toMatchObject({
    link: {
      verifiedBy: "seams",
      userId: fixture.ownerUserId,
    },
  });
  await expect(
    readPersistedLink(fixture.db, "U0IDENTITYSEAMS"),
  ).resolves.toMatchObject({
    verifiedBy: "seams",
  });
}

async function linksAuthenticatedMemberOnce(): Promise<void> {
  const fixture = await createFixture();
  const token = await issueLink(fixture, "U0IDENTITYLINK");
  const challenge = await readLink(token, fixture.env);

  expect(challenge).toMatchObject({
    ok: true,
    kind: "slack",
    workspaceId: WORKSPACE_ID,
    externalUserId: "U0IDENTITYLINK",
  });

  const completed = await completeLink(
    token,
    fixture.ownerSession,
    fixture.env,
  );
  expect(completed.status).toBe(200);
  await expect(completed.json()).resolves.toMatchObject({
    ok: true,
    link: {
      kind: "slack",
      organisationId: fixture.organisationId,
      workspaceId: WORKSPACE_ID,
      externalUserId: "U0IDENTITYLINK",
      userId: fixture.ownerUserId,
      verifiedBy: "google",
    },
  });

  await expect(
    readPersistedLink(fixture.db, "U0IDENTITYLINK"),
  ).resolves.toEqual({
    organisationId: fixture.organisationId,
    workspaceId: WORKSPACE_ID,
    externalUserId: "U0IDENTITYLINK",
    userId: fixture.ownerUserId,
    verifiedBy: "google",
  });
  await expect(
    readMembership(fixture.db, fixture.ownerUserId),
  ).resolves.toEqual({
    role: "owner",
    status: "active",
  });

  const replay = await completeLink(token, fixture.ownerSession, fixture.env);
  expect(replay.status).toBe(409);
  await expect(replay.json()).resolves.toMatchObject({
    error: { code: "link_consumed" },
  });
}

async function rejectsNonMemberWithoutConsumption(): Promise<void> {
  const fixture = await createFixture();
  const token = await issueLink(fixture, "U0IDENTITYOUTSIDER");
  const outsider = await upsertUser({
    db: fixture.db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "identity-link-outsider",
      email: "identity-link-outsider@example.com",
      displayName: "Identity Link Outsider",
      emailVerified: true,
    },
    now: fixture.now,
  });
  const outsiderSession = await issueControlSession({
    db: fixture.db,
    userId: outsider.userId,
    now: fixture.now,
    ttlMs: 60 * 60 * 1000,
  });

  const denied = await completeLink(token, outsiderSession, fixture.env);
  expect(denied.status).toBe(403);
  await expect(denied.json()).resolves.toMatchObject({
    error: { code: "organisation_membership_missing" },
  });

  const completed = await completeLink(
    token,
    fixture.ownerSession,
    fixture.env,
  );
  expect(completed.status).toBe(200);
}

type IdentityFixture = {
  readonly db: SingleDatabase;
  readonly env: UnitTestEnv;
  readonly now: number;
  readonly organisationId: OrganisationId;
  readonly ownerUserId: UserId;
  readonly ownerSession: Awaited<ReturnType<typeof issueControlSession>>;
};

async function createFixture(
  options: {
    readonly issuer?: string;
  } = {},
): Promise<IdentityFixture> {
  const db = createMigratedDatabase();
  const now = Date.now();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: options.issuer ?? "https://accounts.google.com",
      subject: "identity-link-owner",
      email: "identity-link-owner@example.com",
      displayName: "Identity Link Owner",
      emailVerified: true,
    },
    now,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Identity Link Organisation",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, now),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now,
  });
  const handle = parseVaultHandle(
    "vault:organisation:slack:identity-link:oauth",
  );
  if (!handle.ok) throw new Error(handle.error.code);
  const connected = await createConnectedIntegration(db, {
    organisationId: organisation.organisationId,
    provider: "slack",
    providerSubjectId: WORKSPACE_ID,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: handle.value,
    },
    grantedScopes: ["channels:read", "chat:write"],
    createdByUserId: owner.userId,
    providerAccountId: WORKSPACE_ID,
    accountKind: "workspace",
    displayName: "Identity Link Workspace",
    capabilities: ["conversation.ingress", "conversation.egress"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const activated = await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now,
  });
  if (!activated.ok) throw new Error(activated.error.code);
  await upsertSurfaceInstallation({
    db,
    account: activated.value,
    surfaceKind: "slack",
    workspaceId: WORKSPACE_ID,
    installModel: "unlisted",
    botTokenRef: handle.value,
    scopes: ["channels:read", "chat:write"],
    installedAt: now,
  });
  const ownerSession = await issueControlSession({
    db,
    userId: owner.userId,
    now,
    ttlMs: 60 * 60 * 1000,
  });
  return {
    db,
    env: platformEnv({
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      ORGANISATION_ADMIN_TOKEN: ADMIN_TOKEN,
      PANTRY_PUBLIC_ORIGIN: ORIGIN,
    }),
    now,
    organisationId: organisation.organisationId,
    ownerUserId: owner.userId,
    ownerSession,
  };
}

async function issueLink(
  fixture: IdentityFixture,
  externalUserId: string,
): Promise<string> {
  const response = await issueLinkResponse(fixture, externalUserId);
  expect(response.status).toBe(201);
  const body = await response.json<unknown>();
  if (!isRecord(body) || typeof body.browserUrl !== "string") {
    throw new Error("Identity link issue response is invalid");
  }
  const token = new URL(body.browserUrl).searchParams.get("token");
  if (token === null) throw new Error("Identity link token is missing");
  return token;
}

async function issueLinkResponse(
  fixture: IdentityFixture,
  externalUserId: string,
): Promise<Response> {
  return gateway.fetch(
    new Request(`${ORIGIN}/v1/admin/identity-links`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organisationId: fixture.organisationId,
        workspaceId: WORKSPACE_ID,
        externalUserId,
      }),
    }),
    fixture.env,
    executionContext(),
  );
}

async function readLink(token: string, env: UnitTestEnv): Promise<unknown> {
  const response = await gateway.fetch(
    new Request(`${ORIGIN}/v1/identity-links/${token}`),
    env,
    executionContext(),
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function completeLink(
  token: string,
  session: Awaited<ReturnType<typeof issueControlSession>>,
  env: UnitTestEnv,
): Promise<Response> {
  return gateway.fetch(
    new Request(`${ORIGIN}/v1/identity-links/${token}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
        "x-pantry-csrf": session.csrfToken,
      },
      body: "{}",
    }),
    env,
    executionContext(),
  );
}

async function readPersistedLink(
  db: SingleDatabase,
  externalUserId: string,
): Promise<{
  readonly organisationId: string;
  readonly workspaceId: string;
  readonly externalUserId: string;
  readonly userId: string;
  readonly verifiedBy: string;
} | null> {
  return db
    .prepare(
      `SELECT organisation_id AS organisationId, workspace_id AS workspaceId,
            external_user_id AS externalUserId,
            user_id AS userId, verified_by AS verifiedBy
     FROM external_identity_link WHERE external_user_id = ?`,
    )
    .bind(externalUserId)
    .first();
}

async function readMembership(
  db: SingleDatabase,
  userId: UserId,
): Promise<{
  readonly role: string;
  readonly status: string;
} | null> {
  return db
    .prepare(
      `SELECT role, status FROM service_role_grant WHERE user_id = ?`,
    )
    .bind(userId)
    .first();
}

function executionContext(): ExecutionContext {
  return testExecutionContext({ waitUntil: vi.fn() });
}
