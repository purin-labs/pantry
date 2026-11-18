/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const controlMocks = vi.hoisted(() => ({
  authorizeOrganisationControl: vi.fn(),
  resolveUser: vi.fn(),
  resolveControlSession: vi.fn(),
  validateControlCsrf: vi.fn(),
}));
const grantMutationMocks = vi.hoisted(() => ({
  createVersionedAccessGrant: vi.fn(),
}));
const policyMocks = vi.hoisted(() => ({
  compilePublishAndActivateOrganisationPolicy: vi.fn(),
  requireActiveOrganisationActorAtPlacement: vi.fn(),
}));
const subjectMocks = vi.hoisted(() => ({
  resolveGrantSubjectReference: vi.fn(),
}));
const publishedCommerceMocks = vi.hoisted(() => ({
  resolvePublishedCommerceTarget: vi.fn(),
}));
const commerceAuthorityMocks = vi.hoisted(() => ({
  resolveOrganisationCommerceSystemAuthority: vi.fn(),
}));
const fileGrantMocks = vi.hoisted(() => ({
  validateFileGrantTarget: vi.fn(),
}));

vi.mock("../src/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-plane")>()),
  authorizeOrganisationControl: controlMocks.authorizeOrganisationControl,
  resolveUser: controlMocks.resolveUser,
  resolveControlSession: controlMocks.resolveControlSession,
  validateControlCsrf: controlMocks.validateControlCsrf,
}));
vi.mock("../src/access-control/grant-mutations", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/access-control/grant-mutations")
  >()),
  createVersionedAccessGrant: grantMutationMocks.createVersionedAccessGrant,
}));
vi.mock("../src/actors/actor-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actors/actor-router")>()),
  requireActiveOrganisationActorAtPlacement: policyMocks.requireActiveOrganisationActorAtPlacement,
}));
vi.mock("../src/policy-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/policy-snapshot")>()),
  compilePublishAndActivateOrganisationPolicy:
    policyMocks.compilePublishAndActivateOrganisationPolicy,
}));
vi.mock(
  "../src/access-control/decision-explanation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/access-control/decision-explanation")
    >()),
    resolveGrantSubjectReference: subjectMocks.resolveGrantSubjectReference,
  }),
);
vi.mock(
  "../src/commerce/entity-plane/published-resources",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/commerce/entity-plane/published-resources")
    >()),
    resolvePublishedCommerceTarget:
      publishedCommerceMocks.resolvePublishedCommerceTarget,
  }),
);
vi.mock("../src/data/organisation-commerce-system", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/organisation-commerce-system")
  >()),
  resolveOrganisationCommerceSystemAuthority:
    commerceAuthorityMocks.resolveOrganisationCommerceSystemAuthority,
}));
vi.mock("../src/context/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/context/files")>()),
  validateFileGrantTarget: fileGrantMocks.validateFileGrantTarget,
}));

import { handleControlRequest } from "../src/control-router";
import {
  parseUserId,
  parsePersonId,
  parseOrganisationId,
  type UserId,
  type PersonId,
  type OrganisationId,
} from "../src/ids";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID_RAW = "organisation_access_control_mutation_route";
const ORGANISATION_ID = requireOrganisationId();
const CONTROL_IDENTITY_ID = requireUserId();
const PERSON_ID = requirePersonId();
const SUBJECT_REF = "subject_0123456789abcdef0123456789abcdef";
const TARGET_REF = "target_0123456789abcdef0123456789abcdef";

describe("access-control mutation routes", function accessControlMutationRouteSuite() {
  beforeEach(prepareMocks);

  it("rejects invalid AI budget settings without writing", async function budgetValidation() {
    const env = routeEnv();
    const response = await handleControlRequest(
      mutationRequest("access-control/ai-budget", {
        expectedRevision: 1,
        limits: { maxTokens: 0, maxWallMs: 180000, maxToolCalls: 20 },
      }),
      env.value,
    );
    expect(response.status).toBe(422);
    expect(env.batch).not.toHaveBeenCalled();
  });

  it(
    "rejects unknown request fields before persistence",
    testExactCreateParser,
  );
  it(
    "creates separate patch and propose grants from one published target",
    testPublishedCommerceTargetGrant,
  );
});

async function testExactCreateParser(): Promise<void> {
  const response = await handleControlRequest(
    mutationRequest("access-control/grants", {
      expectedRevision: 7,
      subjectRef: { subjectRefId: SUBJECT_REF, revision: 1 },
      target: {
        kind: "platform",
        capabilityRef: {
          capabilityId: "context.case.read",
          capabilityVersion: 1,
        },
      },
      unexpected: true,
    }),
    routeEnv().value,
  );
  expect(response.status).toBe(422);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: "access_control_grant_create_invalid",
  });
  expect(grantMutationMocks.createVersionedAccessGrant).not.toHaveBeenCalled();
  const rawTarget = await handleControlRequest(
    mutationRequest("access-control/grants", {
      expectedRevision: 7,
      subjectRef: { subjectRefId: SUBJECT_REF, revision: 1 },
      target: {
        kind: "commerce_read",
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
        scope: { kind: "commerce_list", listId: "orders" },
      },
    }),
    routeEnv().value,
  );
  expect(rawTarget.status).toBe(422);
  const mixedFileScope = await handleControlRequest(
    mutationRequest("access-control/grants", {
      expectedRevision: 7,
      subjectRef: { subjectRefId: SUBJECT_REF, revision: 1 },
      target: {
        kind: "file_resource",
        capabilityRef: { capabilityId: "file.read", capabilityVersion: 1 },
        integrationRef: "integration:ia_dropbox",
        scope: {
          kind: "dropbox_folder",
          providerFolderId: "id:recipes",
          pathDisplay: "/Recipes",
          providerFileId: "mixed-branch",
        },
      },
    }),
    routeEnv().value,
  );
  expect(mixedFileScope.status).toBe(422);
  expect(fileGrantMocks.validateFileGrantTarget).not.toHaveBeenCalled();
}

async function testPublishedCommerceTargetGrant(): Promise<void> {
  const patchTarget = {
    kind: "commerce_command" as const,
    capabilityId: "commerce.list_entry.patch",
    capabilityVersion: 1,
    scope: {
      kind: "commerce_list_entry" as const,
      entry: {
        entryId: "entry_export_1",
        listId: "export_coordination",
        revision: 2,
      },
    },
    target: {
      kind: "commerce_list_entry" as const,
      entry: {
        entryId: "entry_export_1",
        listId: "export_coordination",
        revision: 2,
      },
      revision: 2,
    },
  };
  const providerTarget = {
    kind: "provider_resource" as const,
    capabilityId: "commerce.action.propose",
    capabilityVersion: 1,
    integrationAccountId: "integration_underclerk_bound",
    resourceScope: "commerce:list_entry:export_coordination:entry_export_1:2",
  };
  publishedCommerceMocks.resolvePublishedCommerceTarget.mockResolvedValue({
    ok: true,
    value: {
      kind: "list_entry",
      target: patchTarget,
      providerTarget,
      targetRef: { targetRefId: TARGET_REF, revision: 2 },
      label: "Export coordination · Shipment 1",
      detail: "Published commerce list entry",
    },
  });
  commerceAuthorityMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue(
    {
      ok: true,
      value: {
        commerceSystem: { kind: "satyr_commerce" },
        provider: "underclerk",
        integrationAccountId: providerTarget.integrationAccountId,
      },
    },
  );
  for (const [capabilityRef, expectedTarget, idempotencyKey] of [
    [
      { capabilityId: "commerce.list_entry.patch", capabilityVersion: 1 },
      patchTarget,
      "access-mutation-patch",
    ],
    [
      { capabilityId: "commerce.action.propose", capabilityVersion: 1 },
      providerTarget,
      "access-mutation-propose",
    ],
  ] as const) {
    grantMutationMocks.createVersionedAccessGrant.mockResolvedValue(
      successfulCreateResult(expectedTarget),
    );
    const response = await handleControlRequest(
      mutationRequest(
        "access-control/grants",
        {
          expectedRevision: 7,
          subjectRef: { subjectRefId: SUBJECT_REF, revision: 1 },
          target: {
            kind: "published_commerce_target",
            capabilityRef,
            targetRef: { targetRefId: TARGET_REF, revision: 2 },
          },
        },
        idempotencyKey,
      ),
      routeEnv().value,
    );
    expect(response.status).toBe(200);
    expect(
      grantMutationMocks.createVersionedAccessGrant,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: expectedTarget,
      }),
    );
  }
  expect(
    publishedCommerceMocks.resolvePublishedCommerceTarget,
  ).toHaveBeenCalledTimes(2);
}

function prepareMocks(): void {
  vi.clearAllMocks();
  controlMocks.resolveControlSession.mockResolvedValue({
    ok: true,
    value: {
      kind: "active",
      controlSessionId: "control_session_access_mutation",
      userId: CONTROL_IDENTITY_ID,
      rotationGeneration: 1,
      createdAt: 1,
      rotatedAt: 1,
      expiresAt: Date.now() + 60_000,
    },
  });
  controlMocks.validateControlCsrf.mockResolvedValue({ ok: true, value: true });
  controlMocks.authorizeOrganisationControl.mockResolvedValue({
    ok: true,
    value: {
      membership: {
        kind: "active",
        organisationId: ORGANISATION_ID,
        userId: CONTROL_IDENTITY_ID,
        personId: PERSON_ID,
        role: "admin",
        createdAt: 1,
      },
    },
  });
  controlMocks.resolveUser.mockResolvedValue({
    userId: CONTROL_IDENTITY_ID,
    issuer: "https://issuer.example",
    subject: "access-admin",
    email: "admin@example.invalid",
    displayName: "Access Admin",
    emailVerified: true,
    createdAt: 1,
    lastAuthenticatedAt: 1,
  });
  policyMocks.requireActiveOrganisationActorAtPlacement.mockResolvedValue({
    activatePolicy: vi.fn(),
  });
  policyMocks.compilePublishAndActivateOrganisationPolicy.mockResolvedValue({
    ok: true,
    value: {},
  });
  subjectMocks.resolveGrantSubjectReference.mockResolvedValue({
    ok: true,
    value: { kind: "organisation_role", role: "admin" },
  });
  fileGrantMocks.validateFileGrantTarget.mockResolvedValue({
    ok: false,
    error: { code: "provider_resource_not_accessible" },
  });
}

function successfulCreateResult(target: Record<string, unknown>) {
  return {
    ok: true as const,
    value: {
      grant: {
        grantId: "grant_created",
        organisationId: ORGANISATION_ID,
        subject: { kind: "organisation_role" as const, role: "admin" },
        target,
        provenance: {
          kind: "operator" as const,
          userId: CONTROL_IDENTITY_ID,
          mutationReceiptId: "receipt_access_fixture",
        },
        lifecycle: { kind: "active" as const, revision: 1, activatedAt: 10 },
      },
      environment: "production" as const,
      configurationVersion: 4,
      projectionRevision: 8,
      recovered: false,
    },
  };
}

function mutationRequest(
  suffix: string,
  body: unknown,
  idempotencyKey = "access-mutation-request-1",
): Request {
  return new Request(
    `https://satyr.example/v1/control/organisations/${ORGANISATION_ID_RAW}/${suffix}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie:
          "satyr_control_session=access-mutation; satyr_control_csrf=csrf-token",
        "x-satyr-csrf": "csrf-token",
        origin: "https://satyr.example",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
}

function routeEnv(): Readonly<{
  value: UnitTestEnv;
  batch: ReturnType<typeof vi.fn>;
}> {
  const batch = vi.fn(async () => []);
  const db = {
    prepare: vi.fn((sql: string) => ({
      sql,
      values: [] as readonly unknown[],
      bind(...values: readonly unknown[]) {
        return {
          sql,
          values,
          first: vi.fn(readRouteRow.bind(null, sql)),
        };
      },
    })),
    withSession: vi.fn(() => ({
      prepare: db.prepare,
      batch,
    })),
  };
  return {
    value: platformEnv({
      DB: db,
      POLICY_KV: {},
      SATYR_PUBLIC_ORIGIN: "https://satyr.example",
      SATYR_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
 databaseBinding: "DB",
        kind: "affinity",
        placementCellId: "grant-route",
        locationHint: "wnam",
      }),
    }),
    batch,
  };
}

function requireOrganisationId(): OrganisationId {
  const parsed = parseOrganisationId(ORGANISATION_ID_RAW);
  if (!parsed.ok) throw new Error("Test organisation ID is invalid");
  return parsed.value;
}

function requireUserId(): UserId {
  const parsed = parseUserId("user_6b526fe6-48cd-5d6c-9be3-f6ff86ac4dae");
  if (!parsed.ok) throw new Error("Test control identity ID is invalid");
  return parsed.value;
}

function requirePersonId(): PersonId {
  const parsed = parsePersonId("person_access_mutation_route");
  if (!parsed.ok) throw new Error("Test person ID is invalid");
  return parsed.value;
}

async function readRouteRow(sql: string) {
  if (!sql.includes("FROM organisation_placement")) return null;
  return {
    placementKind: "affinity",
    placementEpoch: 1,
    placementCellId: "grant-route",
    locationHint: "wnam",
    residencyJurisdiction: null,
    fenceToken: "fence_grant_route",
    status: "active",
    createdAt: 1,
    activatedAt: 1,
    frozenAt: null,
    abandonedAt: null,
    retiredAt: null,
  };
}
