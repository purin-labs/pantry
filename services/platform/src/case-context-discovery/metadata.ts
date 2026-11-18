import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { CaseContextCollectionMetadataView } from "@seams/control-api";
import {
  requireActiveOrganisationActorAtPlacement,
  resolveActiveCaseActorAtPlacement,
} from "../actors/actor-router";
import { CAPABILITY_KEYS } from "../authorization/capability-catalogue";
import {
  authorizeCapabilityUse,
  compileTurnAuthority,
} from "../authorization/access-grants/turn-authority";
import {
  readChatControlAuthority,
  evaluateChatFlowLabelSink,
} from "../chat/information-flow";
import type { ConversationScope } from "../chat/store";
import type { Env } from "../env";
import { parseCaseId } from "../ids";
import { readCurrentOrganisationPolicySnapshot } from "../policy-snapshot";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  FlowLabel,
  joinFlowLabels,
} from "../policy/information-flow";
import type {
  CaseContextCollection,
  CaseContextCollectionSelection,
} from "./relationships";
import { resolveCaseContextCollectionSelectionVerification } from "./source";

export async function readCaseContextCollectionMetadata(
  env: Env,
  scope: ConversationScope,
  caseContextCollection: CaseContextCollection,
): Promise<CaseContextCollectionMetadataView | null> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    scope.organisationId,
  );
  if (!execution.ok) return null;
  const authority = await readChatControlAuthority(
    execution.value.database,
    scope,
  );
  const policy = await readCurrentOrganisationPolicySnapshot(
    execution.value.database,
    scope.organisationId,
  );
  if (authority === null || !policy.ok) return null;
  const compiled = await compileTurnAuthority({
    db: execution.value.database,
    accountAccess: execution.value.accountAccess,
    userAuthority: {
      kind: "disclosure_recipient",
      disclosureEvidenceId: JSON.stringify([
        caseContextCollection.caseContextCollectionId,
        caseContextCollection.revision,
      ]),
    },
    action: "disclose",
    organisationId: scope.organisationId,
    requestAuthority: authority,
    policy: policy.value,
  });
  if (!compiled.ok) return null;
  const capability = await authorizeCapabilityUse({
    db: execution.value.database,
    accountAccess: execution.value.accountAccess,
    userAuthority: {
      kind: "disclosure_recipient",
      disclosureEvidenceId: JSON.stringify([
        caseContextCollection.caseContextCollectionId,
        caseContextCollection.revision,
      ]),
    },
    action: "disclose",
    organisationId: scope.organisationId,
    authority,
    authorityPartition: compiled.value.authorityPartition,
    request: {
      capabilities: [
        {
          kind: "platform_capability",
          capabilityId: CAPABILITY_KEYS.caseContextCollectionMetadataRead,
          capabilityVersion: 1,
        },
      ],
    },
  });
  if (!capability.ok) return null;
  // An CaseContextCollection's issue and revision describe the whole relationship set.
  // Withhold the whole view when any contributing source is hidden.
  const selections = [
    caseContextCollection.anchorSelection,
    ...caseContextCollection.relationships.map(relationshipSelection),
  ];
  const sources: {
    selection: CaseContextCollectionSelection;
    label: FlowLabel;
  }[] = [];
  for (const selection of selections) {
    const caseId = parseCaseId(selection.caseId);
    if (!caseId.ok || selection.source !== "gmail") return null;
    const verified = await resolveCaseContextCollectionSelectionVerification(
      execution.value.database,
      scope.organisationId,
      selection,
    );
    if (!verified.ok) return null;
    const accountGrants =
      compiled.value.effectiveGrantSet.selectedGrants.filter(
        mailboxGrant.bind(null, selection),
      );
    const current = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: execution.value.database,
      organisationId: scope.organisationId,
      integrationAccountId: selection.integrationAccountId,
      capabilityId: CAPABILITY_KEYS.emailMailboxRead,
      resourceScope: "mailbox",
      grantIds: accountGrants.map(grantId),
    });
    if (!current.ok) return null;
    const actor = await resolveActiveCaseActorAtPlacement({
      env: env,
      namespace: env.CASE,
      organisationId: scope.organisationId,
      caseId: caseId.value,
      placement: execution.value.placement,
      now: Date.now(),
    });
    if (!actor.ok) return null;
    const source = await actor.value.readMetadata({
      organisationId: scope.organisationId,
      caseId: caseId.value,
      entryId: `trigger:trigger_email_${selection.reference}`,
    });
    if (!source.ok) return null;
    const original = await FlowLabel.restore(source.value.inputLabel);
    if (!original.ok) return null;
    const joined = await joinFlowLabels(original.value, current.value);
    if (!joined.ok) return null;
    const admission = await decideContextAdmission({
      subject: {
        kind: "authority_derived",
        requestAuthority: authority,
        caseId: caseId.value,
      },
      inputLabel: joined.value,
    });
    if (admission.kind !== "admit") return null;
    const delivery = await evaluateChatFlowLabelSink(
      execution.value.database,
      execution.value.accountAccess,
      joined.value,
      authority,
      { kind: "conversation_delivery", destinationAuthority: authority },
    );
    if (delivery.kind !== "allow") return null;
    sources.push({ selection, label: joined.value });
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId: scope.organisationId,
    placement: execution.value.placement,
    now: Date.now(),
  });
  const fresh = await organisation.readCaseContextCollection({
    organisationId: scope.organisationId,
    caseContextCollectionId: caseContextCollection.caseContextCollectionId,
  });
  if (!fresh.ok || fresh.value.revision !== caseContextCollection.revision)
    return null;
  const live = await authorizeCapabilityUse({
    db: execution.value.database,
    accountAccess: execution.value.accountAccess,
    userAuthority: {
      kind: "disclosure_recipient",
      disclosureEvidenceId: JSON.stringify([
        caseContextCollection.caseContextCollectionId,
        caseContextCollection.revision,
      ]),
    },
    action: "disclose",
    organisationId: scope.organisationId,
    authority,
    authorityPartition: compiled.value.authorityPartition,
    request: { capabilities: capability.value.claims.map(requestedCapability) },
  });
  if (!live.ok) return null;
  for (const source of sources) {
    const verified = await resolveCaseContextCollectionSelectionVerification(
      execution.value.database,
      scope.organisationId,
      source.selection,
    );
    if (!verified.ok) return null;
    const current = await evaluateChatFlowLabelSink(
      execution.value.database,
      execution.value.accountAccess,
      source.label,
      authority,
      {
        kind: "conversation_delivery",
        destinationAuthority: authority,
      },
    );
    if (current.kind !== "allow") return null;
  }
  return {
    caseContextCollectionId: caseContextCollection.caseContextCollectionId,
    revision: caseContextCollection.revision,
    lifecycle: caseContextCollection.lifecycle,
    issueKind: caseContextCollection.scope.issueKind,
    issueInstance: caseContextCollection.scope.issueInstance,
    anchorCaseId: caseContextCollection.anchorSelection.caseId,
    relationships: caseContextCollection.relationships.map(relationshipView),
  };
}

function relationshipSelection(
  relationship: CaseContextCollection["relationships"][number],
): CaseContextCollectionSelection {
  return relationship.selection;
}
function relationshipView(
  relationship: CaseContextCollection["relationships"][number],
): CaseContextCollectionMetadataView["relationships"][number] {
  return {
    relationshipId: relationship.relationshipId,
    caseId: relationship.selection.caseId,
    kind: relationship.kind,
  };
}
function mailboxGrant(
  selection: CaseContextCollectionSelection,
  grant: import("../authorization/access-grants/types").AccessGrant,
): boolean {
  return (
    grant.target.kind === "provider_resource" &&
    grant.target.capabilityId === CAPABILITY_KEYS.emailMailboxRead &&
    grant.target.integrationAccountId === selection.integrationAccountId
  );
}
function grantId(
  grant: import("../authorization/access-grants/types").AccessGrant,
): string {
  return grant.grantId;
}
function requestedCapability(
  claim: import("../authorization/access-grants/turn-authority").AuthorizedCapabilityClaim,
) {
  return claim.requested;
}
