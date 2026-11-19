import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeUrl } from "node:url";

import type { RequestAuthority } from "@purin-labs/contracts";
import { describe, expect, it } from "vitest";

import {
  authorityPartitionKey,
  compileEffectiveGrantSet,
  type AccessGrant,
  type EffectiveGrantSet,
} from "../src/authorization/access-grants";
import { digestSelectedGrantSet } from "../src/authorization/access-grants/turn-authority";
import {
  buildDirectSlackAuthority,
  buildSharedSlackAuthority,
  buildWorkflowAuthority,
} from "../src/request-authority";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../src/ids";
import { isRecord } from "@purin-labs/std";

type Plan25AuthorityFixture = {
  readonly organisationId: OrganisationId;
  readonly membershipRevision: number;
  readonly role: string;
  readonly people: Readonly<{ personA: string; personB: string }>;
  readonly slack: Readonly<{
    integrationAccountId: IntegrationAccountId;
    connectorId: string;
    directConversationId: string;
    sharedConversationId: string;
  }>;
  readonly workflow: Readonly<{
    kind: "cue_subscription";
    id: string;
    revision: number;
  }>;
  readonly capabilities: Readonly<{
    roleRead: string;
    personRead: string;
    conversationRead: string;
    workflowRead: string;
  }>;
};

const fixture = readPlan25AuthorityFixture();

describe("Plan 25 authority and context walking scenario", () => {
  it("partitions direct, shared, and workflow authority and observes grant revocation", async () => {
    const organisation = parseOrganisationId(fixture.organisationId);
    if (!organisation.ok)
      throw new Error("Plan 25 fixture organisation is invalid");

    const direct = buildDirectSlackAuthority({
      organisationId: organisation.value,
      requesterPersonId: fixture.people.personA,
      membershipRevision: fixture.membershipRevision,
      role: fixture.role,
      connectorId: fixture.slack.connectorId,
      integrationAccountId: fixture.slack.integrationAccountId,
      conversationId: fixture.slack.directConversationId,
    }).requestAuthority;
    const sharedProjection = buildSharedSlackAuthority({
      organisationId: organisation.value,
      requesterPersonId: fixture.people.personA,
      membershipRevision: fixture.membershipRevision,
      role: fixture.role,
      connectorId: fixture.slack.connectorId,
      integrationAccountId: fixture.slack.integrationAccountId,
      conversationId: fixture.slack.sharedConversationId,
    });
    const workflow = buildWorkflowAuthority({
      organisationId: organisation.value,
      workflowId: fixture.workflow.id,
      workflowRevision: fixture.workflow.revision,
    }).requestAuthority;
    const grants = scenarioGrants(organisation.value);
    const allowedTools = grants.map((grant) => grant.target.capabilityId);

    const directCatalog = compileScenario(
      direct,
      grants,
      allowedTools,
      organisation.value,
    );
    const sharedCatalog = compileScenario(
      sharedProjection.requestAuthority,
      grants,
      allowedTools,
      organisation.value,
    );
    const workflowCatalog = compileScenario(
      workflow,
      grants,
      allowedTools,
      organisation.value,
    );
    expect(authorityPartitionKey(direct)).toEqual({
      kind: "direct_conversation",
      organisationId: organisation.value,
      requesterPersonId: fixture.people.personA,
      membershipRevision: fixture.membershipRevision,
      role: fixture.role,
      integrationAccountId: fixture.slack.integrationAccountId,
      conversationId: fixture.slack.directConversationId,
    });
    expect(authorityPartitionKey(sharedProjection.requestAuthority)).toEqual({
      kind: "shared_conversation",
      organisationId: organisation.value,
      membershipRevision: fixture.membershipRevision,
      role: fixture.role,
      integrationAccountId: fixture.slack.integrationAccountId,
      conversationId: fixture.slack.sharedConversationId,
    });
    expect(authorityPartitionKey(workflow)).toEqual({
      kind: "workflow",
      organisationId: organisation.value,
      workflowId: fixture.workflow.id,
      workflowRevision: fixture.workflow.revision,
    });
    expect(capabilityNames(directCatalog)).toEqual([
      fixture.capabilities.roleRead,
      fixture.capabilities.personRead,
    ]);
    expect(capabilityNames(sharedCatalog)).toEqual([
      fixture.capabilities.roleRead,
      fixture.capabilities.conversationRead,
    ]);
    expect(capabilityNames(workflowCatalog)).toEqual([
      fixture.capabilities.workflowRead,
    ]);

    const initialDigest = await digestSelectedGrantSet(
      directCatalog.selectedGrants,
    );
    const revoked = grants.map((grant) =>
      grant.grantId === "grant_role_catalog" ? revokeGrant(grant) : grant,
    );
    const changedCatalog = compileScenario(
      direct,
      revoked,
      allowedTools,
      organisation.value,
    );
    const changedDigest = await digestSelectedGrantSet(
      changedCatalog.selectedGrants,
    );
    expect(capabilityNames(changedCatalog)).toEqual([
      fixture.capabilities.personRead,
    ]);
    expect(changedDigest).not.toBe(initialDigest);
  });
});

function compileScenario(
  authority: RequestAuthority,
  grants: readonly AccessGrant[],
  allowedTools: readonly string[],
  organisationId: OrganisationId,
): EffectiveGrantSet {
  const compiled = compileEffectiveGrantSet({
    organisationId,
    authority,
    grants,
    organisationAllowedTools: allowedTools,
  });
  if (!compiled.ok) throw new Error(compiled.error.code);
  return compiled.value;
}

function capabilityNames(catalog: EffectiveGrantSet): readonly string[] {
  return catalog.capabilities.map(
    (capability) => capability.definition.capabilityId,
  );
}

function scenarioGrants(
  organisationId: OrganisationId,
): readonly AccessGrant[] {
  return [
    activeGrant(
      organisationId,
      "grant_role_catalog",
      { kind: "organisation_role", role: fixture.role },
      fixture.capabilities.roleRead,
    ),
    activeGrant(
      organisationId,
      "grant_person_orders",
      { kind: "person", personId: fixture.people.personA },
      fixture.capabilities.personRead,
    ),
    activeGrant(
      organisationId,
      "grant_shared_inventory",
      {
        kind: "conversation",
        integrationAccountId: fixture.slack.integrationAccountId,
        conversationId: fixture.slack.sharedConversationId,
      },
      fixture.capabilities.conversationRead,
    ),
    activeGrant(
      organisationId,
      "grant_workflow_inventory",
      {
        kind: "workflow",
        workflowKind: fixture.workflow.kind,
        workflowId: fixture.workflow.id,
        workflowRevision: fixture.workflow.revision,
      },
      fixture.capabilities.workflowRead,
    ),
  ];
}

function activeGrant(
  organisationId: OrganisationId,
  grantId: string,
  subject: AccessGrant["subject"],
  capabilityId: string,
): AccessGrant {
  return {
    grantId,
    organisationId,
    subject,
    target: { kind: "platform_capability", capabilityId, capabilityVersion: 1 },
    provenance: {
      kind: "cutover",
      migrationId: "plan25_fixture",
      originalChangedAt: 1,
    },
    lifecycle: { kind: "active", revision: 1, activatedAt: 1 },
  };
}

function revokeGrant(grant: AccessGrant): AccessGrant {
  return {
    ...grant,
    lifecycle: {
      kind: "revoked",
      revision: 2,
      revokedAt: 2,
      reason: "Plan 25 fixture revocation",
    },
  };
}

function readPlan25AuthorityFixture(): Plan25AuthorityFixture {
  const raw: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(
        new NodeUrl(
          "./fixtures/plan25-authority-context.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  const people = readRecord(raw, "people");
  const slack = readRecord(raw, "slack");
  const workflow = readRecord(raw, "workflow");
  const capabilities = readRecord(raw, "capabilities");
  const organisationId = parseOrganisationId(readString(raw, "organisationId"));
  const integrationAccountId = parseIntegrationAccountId(
    readString(slack, "integrationAccountId"),
  );
  if (!organisationId.ok || !integrationAccountId.ok)
    throw new Error("Plan 25 fixture identity is invalid");
  const workflowKind = readString(workflow, "kind");
  if (workflowKind !== "cue_subscription")
    throw new Error("Plan 25 workflow fixture kind is invalid");
  return {
    organisationId: organisationId.value,
    membershipRevision: readPositiveInteger(raw, "membershipRevision"),
    role: readString(raw, "role"),
    people: {
      personA: readString(people, "personA"),
      personB: readString(people, "personB"),
    },
    slack: {
      integrationAccountId: integrationAccountId.value,
      connectorId: readString(slack, "connectorId"),
      directConversationId: readString(slack, "directConversationId"),
      sharedConversationId: readString(slack, "sharedConversationId"),
    },
    workflow: {
      kind: workflowKind,
      id: readString(workflow, "id"),
      revision: readPositiveInteger(workflow, "revision"),
    },
    capabilities: {
      roleRead: readString(capabilities, "roleRead"),
      personRead: readString(capabilities, "personRead"),
      conversationRead: readString(capabilities, "conversationRead"),
      workflowRead: readString(capabilities, "workflowRead"),
    },
  };
}

function readRecord(raw: unknown, field: string): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw[field]))
    throw new Error(`Plan 25 fixture object missing: ${field}`);
  return raw[field];
}

function readString(raw: unknown, field: string): string {
  if (
    !isRecord(raw) ||
    typeof raw[field] !== "string" ||
    raw[field].length === 0
  ) {
    throw new Error(`Plan 25 fixture string missing: ${field}`);
  }
  return raw[field];
}

function readPositiveInteger(raw: unknown, field: string): number {
  if (
    !isRecord(raw) ||
    typeof raw[field] !== "number" ||
    !Number.isSafeInteger(raw[field]) ||
    raw[field] < 1
  ) {
    throw new Error(`Plan 25 fixture revision missing: ${field}`);
  }
  return raw[field];
}
