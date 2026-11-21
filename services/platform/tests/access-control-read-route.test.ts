import {
  TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessGrant } from "../src/authorization/access-grants/types";
import { CAPABILITY_CATALOGUE } from "../src/authorization/capability-catalogue";

const controlMocks = vi.hoisted(() => ({
  authorizeOrganisationControl: vi.fn(),
  listOrganisationMembers: vi.fn(),
  resolveControlSession: vi.fn(),
}));
const grantMocks = vi.hoisted(() => ({ listAccessGrants: vi.fn() }));
const policyMocks = vi.hoisted(() => ({
  readOrganisationCapabilityPolicies: vi.fn(),
}));
const integrationMocks = vi.hoisted(() => ({
  listIntegrationAccounts: vi.fn(),
}));
const commerceMocks = vi.hoisted(() => ({
  resolveOrganisationCommerceSystem: vi.fn(),
  resolveOrganisationCommerceSystemAuthority: vi.fn(),
}));
const flowMocks = vi.hoisted(() => ({ createCurrentSourceFlowLabel: vi.fn() }));
const caseMocks = vi.hoisted(() => ({ readActiveCaseOperations: vi.fn() }));

vi.mock("../src/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-plane")>()),
  authorizeOrganisationControl: controlMocks.authorizeOrganisationControl,
  listOrganisationMembers: controlMocks.listOrganisationMembers,
  resolveControlSession: controlMocks.resolveControlSession,
}));
vi.mock("../src/data/access-grants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/access-grants")>()),
  listAccessGrants: grantMocks.listAccessGrants,
}));
vi.mock("../src/data/capability-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/capability-policy")>()),
  readOrganisationCapabilityPolicies:
    policyMocks.readOrganisationCapabilityPolicies,
}));
vi.mock("../src/data/integration-account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/integration-account")>()),
  listIntegrationAccounts: integrationMocks.listIntegrationAccounts,
}));
vi.mock("../src/data/organisation-commerce-system", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/organisation-commerce-system")
  >()),
  resolveOrganisationCommerceSystem:
    commerceMocks.resolveOrganisationCommerceSystem,
  resolveOrganisationCommerceSystemAuthority:
    commerceMocks.resolveOrganisationCommerceSystemAuthority,
}));
vi.mock("../src/policy/information-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/policy/information-flow")>()),
  createCurrentSourceFlowLabel: flowMocks.createCurrentSourceFlowLabel,
}));
vi.mock("../src/actors/case-operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actors/case-operations")>()),
  readActiveCaseOperations: caseMocks.readActiveCaseOperations,
}));

import { handleControlRequest } from "../src/control-router";
import {
  parsePersonId,
  parseOrganisationId,
  type PersonId,
  type OrganisationId,
} from "../src/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import {
  createCurrentSourceFlowLabel,
  FlowLabel,
  integrationResourceScopeForGrant,
} from "../src/policy/information-flow";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID_RAW = "organisation_access_control_read";
const ORGANISATION_ID = requireOrganisationId();
const CONTROL_IDENTITY_ID = requireUserId();
const PERSON_ID = requirePersonId();
let observedSubjectOptionsSql: string | null = null;

describe("access-control read routes", () => {
  beforeEach(prepareMocks);

  it(
    "assembles the bounded aggregate for a viewer and enforces revisioned cursors",
    testAggregateRead,
  );
  it(
    "derives source cards through the trusted current-label builder",
    testTrustedSourceDerivation,
  );
  it(
    "returns at most 50 opaque subject options and rejects extra query keys",
    testSubjectOptions,
  );
  it("returns current Cases as opaque revisioned options", testCaseOptions);
});

async function testAggregateRead(): Promise<void> {
  grantMocks.listAccessGrants.mockResolvedValue({
    ok: true,
    value: accessGrants(101),
  });
  const first = await handleControlRequest(
    authenticatedRequest("access-control"),
    routeEnv(),
  );
  expect(first.status).toBe(200);
  const firstBody = await readRecord(first);
  const accessControl = readRecordField(firstBody, "accessControl");
  const organisation = readRecordField(accessControl, "organisation");
  const grants = readRecordField(accessControl, "grants");
  expect(organisation.requesterRole).toBe("viewer");
  expect(organisation.actions).toEqual({ kind: "read_only" });
  expect(readArrayField(grants, "items")).toHaveLength(100);
  expect(grants.nextCursor).toBe("access_grants_7_100");

  const next = await handleControlRequest(
    authenticatedRequest("access-control?grants_cursor=access_grants_7_100"),
    routeEnv(),
  );
  expect(next.status).toBe(200);
  const nextAccessControl = readRecordField(
    await readRecord(next),
    "accessControl",
  );
  expect(
    readArrayField(readRecordField(nextAccessControl, "grants"), "items"),
  ).toHaveLength(1);

  const stale = await handleControlRequest(
    authenticatedRequest("access-control?grants_cursor=access_grants_6_100"),
    routeEnv(),
  );
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toEqual({
    ok: false,
    error: "access_control_cursor_stale",
  });
}

async function testSubjectOptions(): Promise<void> {
  const response = await handleControlRequest(
    authenticatedRequest("access-control/options?kind=subjects"),
    routeEnv(subjectOptionRows(51)),
  );
  expect(response.status).toBe(200);
  const options = readRecordField(await readRecord(response), "options");
  const items = readArrayField(options, "items");
  expect(items).toHaveLength(50);
  if (observedSubjectOptionsSql === null)
    throw new Error("Subject-options SQL was not observed");
  expect(
    maximumCompoundSelectTerms(observedSubjectOptionsSql),
  ).toBeLessThanOrEqual(5);
  expect(options.nextCursor).toMatch(
    /^access_options_subjects_7_50_[a-f0-9]{16}$/u,
  );
  expect(JSON.stringify(items)).not.toContain("person_option_0");
  expect(items[0]).toEqual(
    expect.objectContaining({
      kind: "person",
      refId: expect.stringMatching(/^subject_[a-f0-9]{32}$/u),
      label: "Member 0",
      detail: "Workspace member",
      availability: "available",
    }),
  );

  const extra = await handleControlRequest(
    authenticatedRequest("access-control/options?kind=subjects&extra=true"),
    routeEnv(),
  );
  expect(extra.status).toBe(422);
  await expect(extra.json()).resolves.toEqual({
    ok: false,
    error: "access_control_options_invalid",
  });
}

async function testCaseOptions(): Promise<void> {
  caseMocks.readActiveCaseOperations.mockResolvedValue({
    ok: true,
    value: [
      {
        caseId: "case_access_control_current",
        purpose: "Resolve wholesale order",
        revision: 4,
        lifecycle: "active",
        assignments: [],
        outputs: { pending: 0, settled: 0 },
      },
    ],
  });
  const response = await handleControlRequest(
    authenticatedRequest("access-control/options?kind=cases"),
    routeEnv(),
  );
  expect(response.status).toBe(200);
  const options = readRecordField(await readRecord(response), "options");
  expect(readArrayField(options, "items")).toEqual([
    expect.objectContaining({
      kind: "case",
      refId: expect.stringMatching(/^case_[a-f0-9]{32}$/u),
      revision: 4,
      label: expect.stringMatching(/^Current Case [A-F0-9]{6}$/u),
      availability: "available",
    }),
  ]);
  expect(JSON.stringify(options)).not.toContain("case_access_control_current");
  expect(JSON.stringify(options)).not.toContain("Resolve wholesale order");
}

async function testTrustedSourceDerivation(): Promise<void> {
  const grant = fileReadGrant();
  const resourceScope = integrationResourceScopeForGrant(grant);
  if (resourceScope === null) throw new Error("File grant scope is missing");
  grantMocks.listAccessGrants.mockResolvedValue({ ok: true, value: [grant] });
  integrationMocks.listIntegrationAccounts.mockResolvedValue([
    integrationAccount(),
  ]);
  flowMocks.createCurrentSourceFlowLabel.mockImplementation(
    createAvailableSourceLabel,
  );
  const response = await handleControlRequest(
    authenticatedRequest("access-control"),
    routeEnv(),
  );
  expect(response.status).toBe(200);
  const accessControl = readRecordField(
    await readRecord(response),
    "accessControl",
  );
  const sourcePolicies = readRecordField(accessControl, "sourceFlowPolicies");
  const items = readArrayField(sourcePolicies, "items");
  expect(items).toHaveLength(1);
  expect(items[0]).toEqual(
    expect.objectContaining({
      availability: { kind: "available" },
      resourceLabel: "Kitchen Drive · Read connected files",
      readers: [
        expect.objectContaining({
          kind: "organisation_role",
          label: "Viewers",
        }),
      ],
    }),
  );
  expect(JSON.stringify(items)).not.toContain(resourceScope);
  expect(JSON.stringify(items)).not.toContain("digest");
  expect(JSON.stringify(accessControl)).not.toContain("drive-file-1");
  expect(JSON.stringify(accessControl)).not.toContain("resourceScope");
}

function prepareMocks(): void {
  vi.clearAllMocks();
  observedSubjectOptionsSql = null;
  controlMocks.resolveControlSession.mockResolvedValue({
    ok: true,
    value: {
      kind: "active",
      controlSessionId: "control_session_access_control_read",
      userId: CONTROL_IDENTITY_ID,
      rotationGeneration: 1,
      createdAt: 1,
      rotatedAt: 1,
      expiresAt: Date.now() + 60_000,
    },
  });
  controlMocks.authorizeOrganisationControl.mockResolvedValue({
    ok: true,
    value: {
      membership: {
        kind: "active",
        organisationId: ORGANISATION_ID,
        userId: CONTROL_IDENTITY_ID,
        personId: PERSON_ID,
        role: "viewer",
        createdAt: 1,
      },
    },
  });
  controlMocks.listOrganisationMembers.mockResolvedValue([
    {
      kind: "active",
      organisationId: ORGANISATION_ID,
      userId: CONTROL_IDENTITY_ID,
      personId: PERSON_ID,
      role: "viewer",
      createdAt: 1,
      email: "viewer@example.invalid",
      displayName: "Viewer",
    },
  ]);
  grantMocks.listAccessGrants.mockResolvedValue({ ok: true, value: [] });
  policyMocks.readOrganisationCapabilityPolicies.mockResolvedValue({
    ok: true,
    value: capabilityPolicies(),
  });
  integrationMocks.listIntegrationAccounts.mockResolvedValue([]);
  commerceMocks.resolveOrganisationCommerceSystem.mockResolvedValue({
    ok: false,
    error: { code: "commerce_system_not_found" },
  });
  commerceMocks.resolveOrganisationCommerceSystemAuthority.mockResolvedValue({
    ok: false,
    error: { code: "commerce_system_not_found" },
  });
  flowMocks.createCurrentSourceFlowLabel.mockRejectedValue(
    new Error("Unexpected source label request"),
  );
  caseMocks.readActiveCaseOperations.mockResolvedValue({ ok: true, value: [] });
}

function capabilityPolicies(): readonly Record<string, unknown>[] {
  const policies: Record<string, unknown>[] = [];
  for (const definition of CAPABILITY_CATALOGUE) {
    policies.push({
      organisationId: ORGANISATION_ID,
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
      mode: "disabled",
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "receipt_access_control_read",
      },
      revision: 1,
      changedAt: 1,
    });
  }
  return policies;
}

function accessGrants(count: number): readonly AccessGrant[] {
  const grants: AccessGrant[] = [];
  for (let index = 0; index < count; index += 1) {
    grants.push({
      grantId: `grant_access_control_${String(index).padStart(3, "0")}`,
      organisationId: ORGANISATION_ID,
      subject: { kind: "organisation_role", role: "viewer" },
      target: {
        kind: "platform_capability",
        capabilityId: "context.case.read",
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "receipt_access_control_read",
      },
      lifecycle: { kind: "active", revision: 1, activatedAt: 1 },
    });
  }
  return grants;
}

function fileReadGrant(): AccessGrant {
  return {
    grantId: "grant_access_control_file",
    organisationId: ORGANISATION_ID,
    subject: { kind: "organisation_role", role: "viewer" },
    target: {
      kind: "file_resource",
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: "integration_google_drive",
      scope: {
        kind: "gdrive_file",
        providerFileId: "drive-file-1",
        name: "Recipes",
      },
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_access_control_read",
    },
    lifecycle: { kind: "active", revision: 2, activatedAt: 1 },
  };
}

function integrationAccount(): Record<string, unknown> {
  return {
    integrationAccountId: "integration_google_drive",
    organisationId: ORGANISATION_ID,
    providerConnectionId: "connection_google_drive",
    provider: "google_drive",
    environment: "production",
    providerAccountId: "provider-account",
    accountKind: "drive",
    displayName: "Kitchen Drive",
    lifecycle: { kind: "active" },
    isDefaultForProvider: true,
    capabilities: ["file.read"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    createdAt: 1,
    updatedAt: 2,
  };
}

async function createAvailableSourceLabel(
  input: Parameters<typeof createCurrentSourceFlowLabel>[0],
): ReturnType<typeof createCurrentSourceFlowLabel> {
  if (input.kind !== "integration_resource") {
    throw new Error("Expected an integration-resource source label");
  }
  return FlowLabel.create([
    {
      owner: {
        kind: "integration_resource",
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        resourceScope: input.resourceScope,
      },
      readers: [{ kind: "organisation_role", role: "viewer" }],
    },
  ]);
}

function subjectOptionRows(count: number): readonly Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      kind: "person",
      firstId: `person_option_${index}`,
      secondId: null,
      revision: 1,
      label: `Member ${index}`,
    });
  }
  return rows;
}

function authenticatedRequest(suffix: string): Request {
  return new Request(
    `https://pantry.example/v1/control/organisations/${ORGANISATION_ID_RAW}/${suffix}`,
    {
      headers: { cookie: "satyr_control_session=access-control-read" },
    },
  );
}

function routeEnv(
  subjectRows: readonly Record<string, unknown>[] = [],
): UnitTestEnv {
  const prepare = vi.fn((sql: string) => {
    if (sql.includes("WITH subject_options")) observedSubjectOptionsSql = sql;
    return {
      bind: vi.fn(() => ({
        first: vi.fn(async () =>
          sql.includes("organisation_placement")
            ? TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW
            : sql.includes("FROM organisation\n")
              ? {
                  organisationId: ORGANISATION_ID_RAW,
                  name: "Access Control Café",
                  lifecycle: "active",
                  configurationVersion: 3,
                  projectionRevision: 7,
                }
              : null,
        ),
        all: vi.fn(async () => ({
          results: sql.includes("WITH subject_options") ? subjectRows : [],
        })),
      })),
    };
  });
  return platformEnv({
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DB: { prepare, withSession: vi.fn().mockReturnThis() },
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
  });
}

function maximumCompoundSelectTerms(sql: string): number {
  const compoundTerms = [1];
  let maximum = 1;
  for (const token of sql.matchAll(/\(|\)|UNION\s+ALL/giu)) {
    if (token[0] === "(") {
      compoundTerms.push(1);
      continue;
    }
    if (token[0] === ")") {
      const completed = compoundTerms.pop();
      if (completed !== undefined) maximum = Math.max(maximum, completed);
      continue;
    }
    const current = compoundTerms.length - 1;
    compoundTerms[current] = (compoundTerms[current] ?? 1) + 1;
  }
  return Math.max(maximum, ...compoundTerms);
}

async function readRecord(
  response: Response,
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Response is not a JSON object");
  }
  return value as Record<string, unknown>;
}

function readRecordField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = record[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function readArrayField(
  record: Record<string, unknown>,
  field: string,
): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`${field} is not an array`);
  return value;
}

function requireOrganisationId(): OrganisationId {
  const parsed = parseOrganisationId(ORGANISATION_ID_RAW);
  if (!parsed.ok) throw new Error("Test organisation ID is invalid");
  return parsed.value;
}

function requireUserId(): UserId {
  const parsed = parseUserId("user_8fa3d512-0d20-5c21-ba1f-a3c6c6926d8b");
  if (!parsed.ok) throw new Error("Test control identity ID is invalid");
  return parsed.value;
}

function requirePersonId(): PersonId {
  const parsed = parsePersonId("person_access_control_read");
  if (!parsed.ok) throw new Error("Test person ID is invalid");
  return parsed.value;
}
