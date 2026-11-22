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
const subjectMocks = vi.hoisted(() => ({
  resolveGrantSubjectReference: vi.fn(),
}));
const fileGrantMocks = vi.hoisted(() => ({
  validateFileGrantTarget: vi.fn(),
}));

vi.mock("@purin-labs/tenancy/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/tenancy/data/control-plane")>()),
  authorizeOrganisationControl: controlMocks.authorizeOrganisationControl,
  resolveUser: controlMocks.resolveUser,
  resolveControlSession: controlMocks.resolveControlSession,
  validateControlCsrf: controlMocks.validateControlCsrf,
}));
vi.mock("@purin-labs/authority/access-control/grant-mutations", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/authority/access-control/grant-mutations")
  >()),
  createVersionedAccessGrant: grantMutationMocks.createVersionedAccessGrant,
}));
vi.mock(
  "@purin-labs/authority/access-control/decision-explanation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@purin-labs/authority/access-control/decision-explanation")
    >()),
    resolveGrantSubjectReference: subjectMocks.resolveGrantSubjectReference,
  }),
);
vi.mock("@purin-labs/agent/context/files/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@purin-labs/agent/context/files/index")>()),
  validateFileGrantTarget: fileGrantMocks.validateFileGrantTarget,
}));

import { handleControlRequest } from "../src/control-router";
import {
  parsePersonId,
  parseOrganisationId,
  type PersonId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID_RAW = "organisation_access_control_mutation_route";
const ORGANISATION_ID = requireOrganisationId();
const CONTROL_IDENTITY_ID = requireUserId();
const PERSON_ID = requirePersonId();
const SUBJECT_REF = "subject_0123456789abcdef0123456789abcdef";

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
  subjectMocks.resolveGrantSubjectReference.mockResolvedValue({
    ok: true,
    value: { kind: "organisation_role", role: "admin" },
  });
  fileGrantMocks.validateFileGrantTarget.mockResolvedValue({
    ok: false,
    error: { code: "provider_resource_not_accessible" },
  });
}

function mutationRequest(suffix: string, body: unknown): Request {
  return new Request(
    `https://pantry.example/v1/control/organisations/${ORGANISATION_ID_RAW}/${suffix}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie:
          "pantry_session=access-mutation; pantry_csrf=csrf-token",
        "x-pantry-csrf": "csrf-token",
        origin: "https://pantry.example",
        "idempotency-key": "access-mutation-request-1",
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
      PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
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
