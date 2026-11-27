// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import {
  TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
/// <reference types="@cloudflare/workers-types" />

import type {
  CapabilityMode,
  OrganisationCapabilityPolicy,
} from "@purin-labs/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";

const accessMocks = vi.hoisted(function createAccessMocks() {
  return {
    grants: vi.fn(),
    policies: vi.fn(),
    validateAuthority: vi.fn(),
    createSourceLabel: vi.fn(),
  };
});
const caseMocks = vi.hoisted(function createCaseMocks() {
  return { readActiveCaseOperations: vi.fn() };
});

vi.mock(
  "@purin-labs/authority/data/access-grants",
  async function mockAccessGrants(importOriginal) {
    return {
      ...(await importOriginal<
        typeof import("@purin-labs/authority/data/access-grants")
      >()),
      listAccessGrants: accessMocks.grants,
    };
  },
);
vi.mock(
  "@purin-labs/authority/data/capability-policy",
  async function mockCapabilityPolicy(importOriginal) {
    return {
      ...(await importOriginal<
        typeof import("@purin-labs/authority/data/capability-policy")
      >()),
      readOrganisationCapabilityPolicies: accessMocks.policies,
    };
  },
);
vi.mock(
  "@purin-labs/authority/request-authority/index",
  async function mockRequestAuthority(importOriginal) {
    return {
      ...(await importOriginal<
        typeof import("@purin-labs/authority/request-authority/index")
      >()),
      validateNativeRequestAuthority: accessMocks.validateAuthority,
    };
  },
);
vi.mock(
  "@purin-labs/authority/policy/information-flow/index",
  async function mockInformationFlow(importOriginal) {
    return {
      ...(await importOriginal<
        typeof import("@purin-labs/authority/policy/information-flow/index")
      >()),
      createCurrentSourceFlowLabel: accessMocks.createSourceLabel,
    };
  },
);
vi.mock(
  "@purin-labs/authority/policy-snapshot",
  async function mockPolicySnapshot(importOriginal) {
    const original =
      await importOriginal<
        typeof import("@purin-labs/authority/policy-snapshot")
      >();
    // The current organisation policy, with no capability rules.
    return {
      ...original,
      readCurrentOrganisationPolicySnapshot: async () => ({
        ok: true,
        value: original.defaultDenyPolicy({ now: 0 }),
      }),
    };
  },
);
vi.mock(
  "@purin-labs/authority/actors/case-operations",
  async function mockCaseOperations(importOriginal) {
    return {
      ...(await importOriginal<
        typeof import("@purin-labs/authority/actors/case-operations")
      >()),
      readActiveCaseOperations: caseMocks.readActiveCaseOperations,
    };
  },
);

import {
  explainAccessDecision,
  resolveGrantSubjectReference,
} from "@purin-labs/authority/access-control/decision-explanation";
import {
  opaqueAccessTargetReference,
  opaqueCaseReference,
  opaqueInformationSourceReference,
  opaqueSubjectReference,
} from "@purin-labs/authority/access-control/references";
import {
  parseCaseId,
  parsePersonId,
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  FlowLabel,
  evaluateFlowLabelSink,
} from "@purin-labs/authority/policy/information-flow/index";
import { buildSharedSlackAuthority } from "@purin-labs/authority/request-authority/index";
import { requireConnectorId, requireIntegrationAccountId } from "./test-ids";
import { resolveActiveCustomConnectorAccount } from "@purin-labs/area-integrations/server/custom-connectors/accounts";

const ORGANISATION_ID = requiredOrganisationId();
const GRANT = activeGrant();
let observedSubjectResolutionSql: string | null = null;

describe("access-control decision explanation", function decisionExplanationSuite() {
  beforeEach(resetMocks);

  it(
    "returns the canonical allowed decision for a current effective grant",
    testAllowed,
  );
  it(
    "returns approval-required from the current capability policy",
    testApprovalRequired,
  );
  it(
    "denies when canonical grant selection finds no effective grant",
    testDenied,
  );
  it("reports stale opaque targets as unavailable", testUnavailable);
  it(
    "projects the pure flow-sink result without exposing policy internals",
    testFlowSinkParity,
  );
  it("resolves an opaque current Case for context admission", testContextRead);
  it(
    "evaluates a tool effect through the same source and target gates",
    testToolEffect,
  );
  it(
    "keeps subject resolution within D1's compound-select bound",
    testSubjectResolutionSqlBound,
  );
});

async function testSubjectResolutionSqlBound(): Promise<void> {
  const subjectRefId = await opaqueSubjectReference(ORGANISATION_ID, {
    kind: "organisation_role",
    firstId: "owner",
    secondId: null,
    revision: 1,
  });
  const resolved = await resolveGrantSubjectReference({
    db: decisionEnv().DB,
    organisationId: ORGANISATION_ID,
    subjectRef: { subjectRefId, revision: 1 },
  });
  expect(resolved).toEqual({
    ok: true,
    value: { kind: "organisation_role", role: "owner" },
  });
  if (observedSubjectResolutionSql === null)
    throw new Error("Subject-resolution SQL was not observed");
  expect(
    maximumCompoundSelectTerms(observedSubjectResolutionSql),
  ).toBeLessThanOrEqual(5);
}

async function testAllowed(): Promise<void> {
  const explanation = await explainAccessDecision(
    await explanationInput("enabled", [GRANT], 3),
  );
  expect(explanation).toEqual({
    kind: "allowed",
    effectiveGrants: [{ grantId: GRANT.grantId, revision: 3 }],
    policyMode: "enabled",
    flowReaders: [],
  });
}

async function testApprovalRequired(): Promise<void> {
  const explanation = await explainAccessDecision(
    await explanationInput("approval_required", [GRANT], 3),
  );
  expect(explanation).toEqual({
    kind: "approval_required",
    effectiveGrants: [{ grantId: GRANT.grantId, revision: 3 }],
    policyMode: "approval_required",
    reason: "This capability requires approval.",
  });
}

async function testDenied(): Promise<void> {
  const explanation = await explainAccessDecision(
    await explanationInput("enabled", [activeGrant("admin")], 3),
  );
  expect(explanation).toMatchObject({
    kind: "denied",
    stage: "grant_selection",
  });
}

async function testUnavailable(): Promise<void> {
  const explanation = await explainAccessDecision(
    await explanationInput("enabled", [GRANT], 4),
  );
  expect(explanation).toMatchObject({
    kind: "unavailable",
    stage: "resource_lifecycle",
  });
}

async function testFlowSinkParity(): Promise<void> {
  const grant = fileGrant();
  accessMocks.grants.mockResolvedValue({ ok: true, value: [grant] });
  const refs = await conversationQuestionRefs(grant);
  const destinationAuthority = buildSharedSlackAuthority({
    organisationId: ORGANISATION_ID,
    requesterPersonId: activeMembership().personId,
    membershipRevision: 2,
    role: "owner",
    connectorId: refs.connectorId,
    integrationAccountId: refs.integrationAccountId,
    conversationId: "channel_access_explain",
  }).requestAuthority;
  if (destinationAuthority.kind !== "shared_conversation") {
    throw new Error("invalid shared destination authority fixture");
  }
  const labels = await flowParityLabels(refs.integrationAccountId);
  for (const label of labels) {
    accessMocks.createSourceLabel.mockResolvedValueOnce({
      ok: true,
      value: label,
    });
    const pure = evaluateFlowLabelSink({
      organisationAuthz: null,
      flowLabel: label,
      sink: { kind: "conversation_delivery", destinationAuthority },
    });
    const env = decisionEnv();
    const explanation = await explainAccessDecision({
      customConnectorAccount: resolveActiveCustomConnectorAccount,
      env,
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      organisationId: ORGANISATION_ID,
      requesterMembership: activeMembership(),
      question: {
        kind: "conversation_delivery",
        authoritySubjectRef: {
          subjectRefId: refs.authoritySubjectRefId,
          revision: 1,
        },
        sourceRefs: [{ sourceRefId: refs.sourceRefId, revision: 3 }],
        destination: {
          kind: "conversation",
          conversationRefId: refs.destinationRefId,
          revision: 1,
        },
      },
      now: 1_000,
    });
    expect(explanation.kind).toBe(explanationKindForFlowDecision(pure.kind));
  }
}

async function testContextRead(): Promise<void> {
  const grant = fileGrant();
  accessMocks.grants.mockResolvedValue({ ok: true, value: [grant] });
  accessMocks.policies.mockResolvedValue({
    ok: true,
    value: [fileCapabilityPolicy()],
  });
  accessMocks.createSourceLabel.mockResolvedValue(
    await ownerReadableSourceLabel(),
  );
  const refs = await conversationQuestionRefs(grant);
  const caseId = requiredCaseId();
  caseMocks.readActiveCaseOperations.mockResolvedValue({
    ok: true,
    value: [
      {
        caseId,
        purpose: "Review private source",
        revision: 5,
        lifecycle: "open",
        assignments: [],
        outputs: { pending: 0, settled: 0 },
      },
    ],
  });
  const env = decisionEnv();
  const explanation = await explainAccessDecision({
    customConnectorAccount: resolveActiveCustomConnectorAccount,
    env,
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    organisationId: ORGANISATION_ID,
    requesterMembership: activeMembership(),
    question: {
      kind: "context_read",
      authoritySubjectRef: {
        subjectRefId: refs.authoritySubjectRefId,
        revision: 1,
      },
      caseRef: {
        caseRefId: await opaqueCaseReference(ORGANISATION_ID, caseId),
        revision: 5,
      },
      sourceRef: { sourceRefId: refs.sourceRefId, revision: 3 },
    },
    now: 1_000,
  });
  expect(explanation).toMatchObject({ kind: "allowed", policyMode: "enabled" });
}

async function testToolEffect(): Promise<void> {
  const sourceGrant = fileGrant();
  accessMocks.grants.mockResolvedValue({
    ok: true,
    value: [GRANT, sourceGrant],
  });
  accessMocks.policies.mockResolvedValue({
    ok: true,
    value: [capabilityPolicy("enabled"), fileCapabilityPolicy()],
  });
  accessMocks.createSourceLabel.mockResolvedValue(
    await ownerReadableSourceLabel(),
  );
  const refs = await conversationQuestionRefs(sourceGrant);
  const env = decisionEnv();
  const explanation = await explainAccessDecision({
    customConnectorAccount: resolveActiveCustomConnectorAccount,
    env,
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    organisationId: ORGANISATION_ID,
    requesterMembership: activeMembership(),
    question: {
      kind: "tool_effect",
      authoritySubjectRef: {
        subjectRefId: refs.authoritySubjectRefId,
        revision: 1,
      },
      sourceRefs: [{ sourceRefId: refs.sourceRefId, revision: 3 }],
      capabilityRef: {
        capabilityId: "context.case.read",
        capabilityVersion: 1,
      },
      targetRef: {
        targetRefId: await opaqueAccessTargetReference(
          ORGANISATION_ID,
          GRANT.target,
        ),
        revision: 3,
      },
      approvalState: { kind: "not_required" },
    },
    now: 1_000,
  });
  expect(explanation).toMatchObject({ kind: "allowed", policyMode: "enabled" });
}

async function explanationInput(
  mode: CapabilityMode,
  grants: readonly AccessGrant[],
  targetRevision: number,
) {
  accessMocks.grants.mockResolvedValue({ ok: true, value: grants });
  accessMocks.policies.mockResolvedValue({
    ok: true,
    value: [capabilityPolicy(mode)],
  });
  const subjectRefId = await opaqueSubjectReference(ORGANISATION_ID, {
    kind: "organisation_role",
    firstId: "owner",
    secondId: null,
    revision: 1,
  });
  const targetRefId = await opaqueAccessTargetReference(
    ORGANISATION_ID,
    GRANT.target,
  );
  const env = decisionEnv();
  return {
    customConnectorAccount: resolveActiveCustomConnectorAccount,
    env,
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    organisationId: ORGANISATION_ID,
    requesterMembership: activeMembership(),
    question: {
      kind: "capability" as const,
      authoritySubjectRef: { subjectRefId, revision: 1 },
      capabilityRef: {
        capabilityId: "context.case.read",
        capabilityVersion: 1,
      },
      targetRef: { targetRefId, revision: targetRevision },
    },
    now: 1_000,
  };
}

function resetMocks(): void {
  observedSubjectResolutionSql = null;
  accessMocks.grants.mockReset();
  accessMocks.policies.mockReset();
  accessMocks.validateAuthority.mockReset();
  accessMocks.createSourceLabel.mockReset();
  caseMocks.readActiveCaseOperations.mockReset();
  accessMocks.validateAuthority.mockResolvedValue({ ok: true, value: null });
  caseMocks.readActiveCaseOperations.mockResolvedValue({ ok: true, value: [] });
}

function decisionEnv(): UnitTestEnv {
  const db = {
    prepare: prepareDecisionQuery,
    withSession: fixtureDatabaseSession,
  };
  return platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
}

function prepareDecisionQuery(sql: string): D1PreparedStatement {
  const statement = {
    bind: bindDecisionQuery.bind(null, sql),
  };
  return statement as D1PreparedStatement;
}

function bindDecisionQuery(sql: string): D1PreparedStatement {
  if (sql.includes("FROM organisation_placement")) {
    return { first: readFixturePlacement } as D1PreparedStatement;
  }
  if (sql.includes("WITH subject_options")) {
    observedSubjectResolutionSql = sql;
    return {
      all: readSubjectRows,
    } as D1PreparedStatement;
  }
  if (sql.includes("FROM service_role_grant AS membership")) {
    return {
      first: readMembershipRow,
    } as D1PreparedStatement;
  }
  if (
    sql.includes(
      "SELECT configuration_version AS revision FROM organisation_onboarding",
    )
  ) {
    return {
      first: readConfigurationRevision,
    } as D1PreparedStatement;
  }
  throw new Error(`unexpected explanation query: ${sql}`);
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

function readSubjectRows(): Promise<D1Result<Record<string, unknown>>> {
  return Promise.resolve({
    success: true,
    results: [
      {
        kind: "organisation_role",
        firstId: "owner",
        secondId: null,
        revision: 1,
      },
      {
        kind: "conversation",
        firstId: "integration_access_explain_slack",
        secondId: "channel_access_explain",
        revision: 1,
      },
    ],
    meta: {
      served_by: "test",
      duration: 0,
      changes: 0,
      last_row_id: 0,
      changed_db: false,
      size_after: 0,
      rows_read: 2,
      rows_written: 0,
    },
  });
}

function readConfigurationRevision(): Promise<{ revision: number }> {
  return Promise.resolve({ revision: 2 });
}

function readMembershipRow(): Promise<Record<string, unknown> | null> {
  return Promise.resolve({
    personId: "person_access_explain_owner",
    userId: "user_26b4cc0c-5de9-50a2-afc4-9deba9e0d717",
    membershipRevision: 2,
  });
}

function activeMembership() {
  const personId = parsePersonId("person_access_explain_owner");
  const userId = parseUserId("user_26b4cc0c-5de9-50a2-afc4-9deba9e0d717");
  if (!personId.ok || !userId.ok)
    throw new Error("invalid access explanation membership fixture");
  return {
    kind: "active" as const,
    organisationId: ORGANISATION_ID,
    personId: personId.value,
    userId: userId.value,
    role: "owner" as const,
    createdAt: 1,
  };
}

function activeGrant(role = "owner"): AccessGrant {
  return {
    grantId: "grant_access_explain_context",
    organisationId: ORGANISATION_ID,
    subject: { kind: "organisation_role", role },
    target: {
      kind: "platform_capability",
      capabilityId: "context.case.read",
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_access_explain",
    },
    lifecycle: { kind: "active", revision: 3, activatedAt: 1 },
  };
}

function fileGrant(): AccessGrant {
  return {
    grantId: "grant_access_explain_file",
    organisationId: ORGANISATION_ID,
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "file_resource",
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: "integration_access_explain_drive",
      scope: {
        kind: "gdrive_file",
        providerFileId: "provider_file_access_explain",
        name: "Access explanation file",
      },
    },
    provenance: {
      kind: "operator",
      userId: "user_26b4cc0c-5de9-50a2-afc4-9deba9e0d717",
      mutationReceiptId: "receipt_access_explain_file",
    },
    lifecycle: { kind: "active", revision: 3, activatedAt: 1 },
  };
}

async function conversationQuestionRefs(grant: AccessGrant) {
  const integrationAccountId = "integration_access_explain_slack";
  const connectorId = requireConnectorId(
    `connector_slack_${integrationAccountId}`,
  );
  return {
    integrationAccountId: requireIntegrationAccountId(integrationAccountId),
    connectorId,
    authoritySubjectRefId: await opaqueSubjectReference(ORGANISATION_ID, {
      kind: "organisation_role",
      firstId: "owner",
      secondId: null,
      revision: 1,
    }),
    destinationRefId: await opaqueSubjectReference(ORGANISATION_ID, {
      kind: "conversation",
      firstId: integrationAccountId,
      secondId: "channel_access_explain",
      revision: 1,
    }),
    sourceRefId: await opaqueInformationSourceReference(ORGANISATION_ID, {
      integrationAccountId: "integration_access_explain_drive",
      capabilityId: grant.target.capabilityId,
      capabilityVersion: grant.target.capabilityVersion,
      resourceScope: "gdrive_file:provider_file_access_explain",
    }),
  };
}

async function flowParityLabels(
  integrationAccountId: ReturnType<typeof requireIntegrationAccountId>,
) {
  const owner = {
    kind: "integration_resource" as const,
    organisationId: ORGANISATION_ID,
    integrationAccountId: "integration_access_explain_drive",
    resourceScope: "gdrive_file:provider_file_access_explain",
  };
  const reader = {
    kind: "conversation" as const,
    integrationAccountId,
    conversationId: "channel_access_explain",
  };
  const allowed = await FlowLabel.create([{ owner, readers: [reader] }]);
  const denied = await FlowLabel.create([
    {
      owner,
      readers: [{ kind: "person", personId: "person_other" }],
    },
  ]);
  if (!allowed.ok || !denied.ok) throw new Error("invalid flow parity fixture");
  return [allowed.value, denied.value];
}

async function ownerReadableSourceLabel() {
  const label = await FlowLabel.create([
    {
      owner: {
        kind: "integration_resource" as const,
        organisationId: ORGANISATION_ID,
        integrationAccountId: "integration_access_explain_drive",
        resourceScope: "gdrive_file:provider_file_access_explain",
      },
      readers: [{ kind: "organisation_role" as const, role: "owner" }],
    },
  ]);
  if (!label.ok) throw new Error("invalid owner-readable source fixture");
  return { ok: true as const, value: label.value };
}

function explanationKindForFlowDecision(
  kind: "allow" | "approval_required" | "deny",
) {
  switch (kind) {
    case "allow":
      return "allowed";
    case "approval_required":
      return "approval_required";
    case "deny":
      return "denied";
  }
}

function capabilityPolicy(mode: CapabilityMode): OrganisationCapabilityPolicy {
  return {
    organisationId: ORGANISATION_ID,
    capabilityId: "context.case.read",
    capabilityVersion: 1,
    mode,
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_access_explain",
    },
    revision: 2,
    changedAt: 2,
  };
}

function fileCapabilityPolicy(): OrganisationCapabilityPolicy {
  return {
    ...capabilityPolicy("enabled"),
    capabilityId: "file.read",
  };
}

function requiredCaseId() {
  const parsed = parseCaseId("case_access_explain_current");
  if (!parsed.ok) throw new Error("invalid Case fixture");
  return parsed.value;
}

function requiredOrganisationId(): OrganisationId {
  const parsed = parseOrganisationId("organisation_access_explain");
  if (!parsed.ok)
    throw new Error("invalid access explanation organisation fixture");
  return parsed.value;
}

function fixtureDatabaseSession(this: SingleDatabase) {
  return this;
}
async function readFixturePlacement() {
  return TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW;
}
