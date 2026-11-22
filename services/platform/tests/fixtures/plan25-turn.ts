import { createHash } from "node:crypto";
import type {
  AcceptedInputRef,
  AuthorityPartition,
  HarnessTurnLease,
  RequestAuthority,
} from "@purin-labs/contracts";

import type { CompiledTurnAuthority } from "../../src/authorization/access-grants/turn-authority";
import type { ContextAssemblyResult } from "../../src/context/assembly";
import type { SerializedFlowBinding } from "../../src/policy";
import {
  parseAssignmentId,
  parseCaseId,
  parseOrganisationId,
  type AssignmentId,
  type CaseId,
  type IntegrationAccountId,
  type SessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Variant } from "@purin-labs/type-utils";
import {
  createOrganisationAccess,
  acceptedExecutionAuthority,
} from "../../src/organisation-access/access";
import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { createMigratedDatabase } from "../sqlite-d1";

// Serialization and Case-state fixtures have no shared binding. Their real port
// denies live access. Composed E2E journeys supply the current account authority.
// The database opens on first use: Node SQLite is unavailable in the Workers pool.
let fixtureAccountDatabaseInstance: SingleDatabase | null = null;
function fixtureAccountDatabase(): SingleDatabase {
  fixtureAccountDatabaseInstance ??= createMigratedDatabase();
  return fixtureAccountDatabaseInstance;
}

const TEST_AUTHORITY_PARTITION_DIGEST = "b".repeat(64);
const TEST_CONTEXT_BUNDLE_DIGEST =
  "395d9d82260a48b6b7983fd4ee4666cedd417ccc8a6186069a592ca7387dcd44";
export function fixtureFlowBinding(
  input: Readonly<{
    readonly organisationId: string;
    readonly sessionId: string;
    readonly authorityPartitionDigest: string;
    readonly turnId?: string;
  }>,
): SerializedFlowBinding {
  return {
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    turnId: input.turnId ?? "turn_fixture",
    authorityPartitionDigest: input.authorityPartitionDigest,
    flowLabel: {
      policies: [],
      digest:
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    },
    informationFlowContextDigest: "b".repeat(64),
    observationSetDigest: "c".repeat(64),
    contextRevision: 0,
  };
}

export const TEST_ACCEPTED_INPUT_CONTEXT: Pick<
  AcceptedInputRef,
  "contextBundleDigest"
> = {
  contextBundleDigest: TEST_CONTEXT_BUNDLE_DIGEST,
};

export const TEST_HARNESS_LEASE_AUTHORITY: Pick<
  HarnessTurnLease,
  "requestAuthority" | "authorityPartitionDigest"
> = {
  requestAuthority: fixtureHarnessRequestAuthority(),
  authorityPartitionDigest: TEST_AUTHORITY_PARTITION_DIGEST,
};

function fixtureHarnessRequestAuthority(): Variant<
  RequestAuthority,
  "direct_conversation"
> {
  const organisationId = parseOrganisationId("organisation_fixture");
  if (!organisationId.ok)
    throw new Error("invalid harness authority fixture organisation");
  return fixtureRequestAuthority(organisationId.value, "connector_fixture");
}

export function fixtureTurnAuthority(
  organisationId: OrganisationId,
  connectorId: string,
): CompiledTurnAuthority {
  const requestAuthority = fixtureRequestAuthority(organisationId, connectorId);
  const grantSetDigest = fixtureWorkspaceGrantSetDigest(organisationId);
  const partitionWithoutDigest: Omit<AuthorityPartition, "digest"> = {
    key: {
      kind: "direct_conversation",
      organisationId,
      requesterPersonId: requestAuthority.requesterPersonId,
      membershipRevision: requestAuthority.membershipRevision,
      role: requestAuthority.role,
      integrationAccountId: requestAuthority.integrationAccountId,
      conversationId: requestAuthority.conversationId,
    },
    selectedGrantSetDigest: grantSetDigest,
    capabilityKeys: [
      "platform:context.case.read:1",
      "platform:workspace.query:1",
    ],
    policyVersion: "policy_1",
  };
  const authorityPartitionDigest = createHash("sha256")
    .update(JSON.stringify(partitionWithoutDigest))
    .digest("hex");
  return {
    accountAccess: createOrganisationAccess(
      { DB: fixtureAccountDatabase() },
      organisationId,
      fixtureAccountDatabase(),
      {
        placementEpoch: 1,
        placementCellId: "unconfigured-fixture",
        fenceToken: "unconfigured-fixture",
      },
    ),
    userAuthority: acceptedExecutionAuthority(
      "session_fixture",
      "turn_fixture",
    ),
    action: "execute",
    requestAuthority,
    authorityPartition: {
      digest: authorityPartitionDigest,
      ...partitionWithoutDigest,
    },
    effectiveGrantSet: {
      organisationId,
      authority: requestAuthority,
      selectedGrants: [],
      capabilities: [
        {
          definition: {
            kind: "platform_capability",
            capabilityId: "context.case.read",
            capabilityVersion: 1,
          },
          grantIds: ["grant_fixture_context_case_read"],
          grantRevisions: [1],
        },
        {
          definition: {
            kind: "platform_capability",
            capabilityId: "workspace.query",
            capabilityVersion: 1,
          },
          grantIds: ["grant_fixture_workspace_query"],
          grantRevisions: [1],
        },
      ],
    },
  };
}

function fixtureEmptyContext(
  input: Readonly<{
    organisationId: OrganisationId;
    caseId: CaseId;
    assignmentId: AssignmentId;
    sessionId: SessionId;
  }>,
): ContextAssemblyResult {
  const bundle: ContextAssemblyResult["bundle"] = {
    organisationId: input.organisationId,
    caseId: input.caseId,
    assignmentId: input.assignmentId,
    sessionId: input.sessionId,
    policyVersion: "policy_1",
    assemblyStrategyVersion: "context_assembly_v1",
    assembledAt: 1,
    items: [],
    usage: { items: 0, estimatedTokens: 0 },
    disposition: { kind: "complete" as const },
    memory: { kind: "none" as const },
  };
  return {
    bundle,
    bundleDigest: digestFixtureContextBundle(bundle),
    modelContext: {
      assemblyStrategyVersion: "context_assembly_v1",
      items: [],
      disposition: { kind: "complete" },
    },
  };
}

function digestFixtureContextBundle(
  bundle: ContextAssemblyResult["bundle"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organisationId: bundle.organisationId,
        caseId: bundle.caseId,
        assignmentId: bundle.assignmentId,
        sessionId: bundle.sessionId,
        policyVersion: bundle.policyVersion,
        assemblyStrategyVersion: bundle.assemblyStrategyVersion,
        assembledAt: bundle.assembledAt,
        items: [],
        usage: bundle.usage,
        disposition: bundle.disposition,
        memory: bundle.memory,
      }),
    )
    .digest("hex");
}

export function fixtureCaseTurnContext(
  input: Readonly<{
    organisationId: OrganisationId;
    caseId: string;
    assignmentId: string;
    sessionId: SessionId;
    connectorId: string;
  }>,
): Readonly<{
  turnAuthority: CompiledTurnAuthority;
  revalidateTurnAuthority: () => Promise<
    Readonly<{ ok: true; value: CompiledTurnAuthority }>
  >;
  context: ContextAssemblyResult;
}> {
  const caseId = parseCaseId(input.caseId);
  const assignmentId = parseAssignmentId(input.assignmentId);
  if (!caseId.ok || !assignmentId.ok)
    throw new Error("invalid Plan 25 Case context fixture identity");
  const turnAuthority = fixtureTurnAuthority(
    input.organisationId,
    input.connectorId,
  );
  return {
    turnAuthority,
    revalidateTurnAuthority: revalidateFixtureTurnAuthority.bind(
      null,
      turnAuthority,
    ),
    context: fixtureEmptyContext({
      organisationId: input.organisationId,
      caseId: caseId.value,
      assignmentId: assignmentId.value,
      sessionId: input.sessionId,
    }),
  };
}

export function fixtureDirectTwoSessionContext(
  input: Readonly<{
    organisationId: OrganisationId;
    caseId: string;
    connectorId: string;
    participants: readonly [
      Readonly<{ assignmentId: string; sessionId: SessionId }>,
      Readonly<{ assignmentId: string; sessionId: SessionId }>,
    ];
  }>,
): Readonly<{
  turnAuthority: CompiledTurnAuthority;
  revalidateTurnAuthority: () => Promise<
    Readonly<{ ok: true; value: CompiledTurnAuthority }>
  >;
  contexts: readonly [ContextAssemblyResult, ContextAssemblyResult];
}> {
  const caseId = parseCaseId(input.caseId);
  const firstAssignmentId = parseAssignmentId(
    input.participants[0].assignmentId,
  );
  const secondAssignmentId = parseAssignmentId(
    input.participants[1].assignmentId,
  );
  if (!caseId.ok || !firstAssignmentId.ok || !secondAssignmentId.ok) {
    throw new Error("invalid Plan 25 two-session context fixture identity");
  }
  const turnAuthority = fixtureTurnAuthority(
    input.organisationId,
    input.connectorId,
  );
  return {
    turnAuthority,
    revalidateTurnAuthority: revalidateFixtureTurnAuthority.bind(
      null,
      turnAuthority,
    ),
    contexts: [
      fixtureEmptyContext({
        organisationId: input.organisationId,
        caseId: caseId.value,
        assignmentId: firstAssignmentId.value,
        sessionId: input.participants[0].sessionId,
      }),
      fixtureEmptyContext({
        organisationId: input.organisationId,
        caseId: caseId.value,
        assignmentId: secondAssignmentId.value,
        sessionId: input.participants[1].sessionId,
      }),
    ],
  };
}

async function revalidateFixtureTurnAuthority(
  turnAuthority: CompiledTurnAuthority,
): Promise<Readonly<{ ok: true; value: CompiledTurnAuthority }>> {
  return { ok: true, value: turnAuthority };
}

function fixtureWorkspaceGrantSetDigest(
  organisationId: OrganisationId,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        {
          grantId: "grant_fixture_context_case_read",
          organisationId,
          subject: { kind: "organisation_role", role: "operator" },
          target: {
            kind: "platform_capability",
            capabilityId: "context.case.read",
            capabilityVersion: 1,
          },
          lifecycle: { kind: "active", revision: 1, activatedAt: 1 },
        },
        {
          grantId: "grant_fixture_workspace_query",
          organisationId,
          subject: { kind: "organisation_role", role: "operator" },
          target: {
            kind: "platform_capability",
            capabilityId: "workspace.query",
            capabilityVersion: 1,
          },
          lifecycle: { kind: "active", revision: 1, activatedAt: 1 },
        },
      ]),
    )
    .digest("hex");
}

export function fixtureRequestAuthority(
  organisationId: OrganisationId,
  connectorId: string,
): Variant<RequestAuthority, "direct_conversation"> {
  return {
    kind: "direct_conversation",
    organisationId,
    requesterPersonId: "person_fixture",
    membershipRevision: 1,
    role: "operator",
    connectorId,
    integrationAccountId: "account_fixture",
    conversationId: "conversation_fixture",
  };
}

export function fixtureControlRequestAuthority(
  input: Readonly<{
    organisationId: OrganisationId;
    requesterPersonId: string;
    userId: string;
    role: "owner" | "admin" | "operator";
  }>,
): Variant<RequestAuthority, "control"> {
  return {
    kind: "control",
    organisationId: input.organisationId,
    requesterPersonId: input.requesterPersonId,
    userId: input.userId,
    membershipRevision: 1,
    role: input.role,
  };
}

export function fixtureProviderActionAuthority(
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    providerResourceScope: string;
    connectorId?: string;
  }>,
): Readonly<{
  requestAuthority: RequestAuthority;
  authorityPartition: AuthorityPartition;
}> {
  const baseAuthority = fixtureRequestAuthority(
    input.organisationId,
    input.connectorId ?? `connector_slack_${input.integrationAccountId}`,
  );
  const requestAuthority = {
    ...baseAuthority,
    connectorId:
      input.connectorId ?? `connector_slack_${input.integrationAccountId}`,
    integrationAccountId: input.integrationAccountId,
  } satisfies Variant<RequestAuthority, "direct_conversation">;
  const grantSetDigest = fixtureProviderGrantSetDigest({
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  const partition: Omit<AuthorityPartition, "digest"> = {
    key: {
      kind: "direct_conversation",
      organisationId: input.organisationId,
      requesterPersonId: requestAuthority.requesterPersonId,
      membershipRevision: requestAuthority.membershipRevision,
      role: requestAuthority.role,
      integrationAccountId: requestAuthority.integrationAccountId,
      conversationId: requestAuthority.conversationId,
    },
    selectedGrantSetDigest: grantSetDigest,
    capabilityKeys: [
      `provider:commerce.action.propose:1:${input.integrationAccountId}:*`,
    ],
    policyVersion: "policy_1",
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(partition))
    .digest("hex");
  return {
    requestAuthority,
    authorityPartition: { digest, ...partition },
  };
}

export function fixtureCustomConnectorActionAuthority(
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    connectorId: string;
    definitionRevision: number;
    definitionDigest: string;
    operationId: string;
  }>,
): Readonly<{
  requestAuthority: RequestAuthority;
  authorityPartition: AuthorityPartition;
}> {
  const base = fixtureProviderActionAuthority({
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    providerResourceScope: "*",
  });
  const partition: Omit<AuthorityPartition, "digest"> = {
    ...base.authorityPartition,
    capabilityKeys: [
      [
        "custom_connector",
        "custom_connector.write",
        "1",
        input.integrationAccountId,
        input.connectorId,
        String(input.definitionRevision),
        input.definitionDigest,
        input.operationId,
      ].join(":"),
    ],
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(partition))
    .digest("hex");
  return {
    requestAuthority: base.requestAuthority,
    authorityPartition: { digest, ...partition },
  };
}

function fixtureProviderGrantSetDigest(
  input: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
  }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        {
          grantId: `grant_provider_action_${input.integrationAccountId}`,
          organisationId: input.organisationId,
          subject: { kind: "organisation_role", role: "operator" },
          target: {
            kind: "provider_resource",
            capabilityId: "commerce.action.propose",
            capabilityVersion: 1,
            integrationAccountId: input.integrationAccountId,
            resourceScope: "*",
          },
          lifecycle: { kind: "active", revision: 1, activatedAt: 1 },
        },
      ]),
    )
    .digest("hex");
}
