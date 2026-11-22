import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { CommerceCommandAuthorityContext } from "@purin-labs/commerce-contracts/relationship-authority";
import { pantryCommerceAccess } from "../contract/client";
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { decideCurrentAuthorityFlowSink } from "../../chat/information-flow";
import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  CommerceAuthorityScope,
  CommerceCommandResult,
  CommerceEntityAuthority,
  CommerceEntityPlaneEffect,
  CommerceEntityRef,
  CommerceEntityTypeId,
  CommerceMutationTarget,
  CommerceMutationReceiptV1,
} from "@purin-labs/commerce-contracts";
import {
  CommerceEntityPlaneClient,
  parseCommerceCommandId,
  parseCommerceMerchantId,
  parseCommercePrincipalId,
  parseRelationshipRevision,
  parseCommerceTimestamp,
  parseCommerceSnapshotRevision,
} from "@purin-labs/commerce-client";
import type { CommerceEntityPlaneFetch } from "@purin-labs/commerce-client";

import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type {
  ActionLedgerEntry,
  ExecutingActionLedgerEntry,
} from "../../actors/action-ledger";
import type {
  CaseResult,
  CommerceEntityPlaneCaseProposal,
} from "../../actors/case/types";
import type { OrganisationCommerce } from "../../actors/organisation/organisation-commerce";
import {
  authorizeCapabilityUse,
  selectActiveGrants,
} from "../../authorization/access-grants";
import { commerceCommandGrantMatchesTarget } from "./grant-authorities";
import type { ProviderCapabilityDefinition } from "../../authorization/access-grants/capability-key";
import { listAccessGrants } from "../../data/access-grants";
import { parseStoredRequestAuthority } from "../../request-authority";
import { readCurrentOrganisationPolicySnapshot } from "../../policy-snapshot";
import { flowBindingMatchesIdentity, FlowBinding } from "../../policy";
import {
  resolveCommerceMerchantBinding,
  type CommerceMerchantBinding,
} from "@purin-labs/connections/data/commerce-merchant-binding";
import { assertCommerceEntityPlaneCommandAuthorityWithLexicon } from "../commerce-wasm";
import {
  buildCommerceEntityPlaneEffect,
  commandFromCommerceEntityPlaneProposal,
} from "./proposals";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

type EntityPlaneAction = ActionLedgerEntry;
type ApprovedEntityPlaneAction = VariantBy<
  ActionLedgerEntry,
  "state",
  "signed" | "indeterminate"
>;

type EntityPlaneActionGatePermit = Readonly<{
  readonly action: ApprovedEntityPlaneAction;
  readonly merchantBinding: CommerceMerchantBinding;
}>;

type CommerceEntityPlaneCommandAuthorizationError = Readonly<{
  readonly code:
    | "commerce_entity_plane_command_invalid"
    | "commerce_entity_plane_command_policy_denied"
    | "commerce_entity_plane_command_grants_unavailable"
    | "commerce_entity_plane_command_not_granted";
}>;

export type CommerceEntityPlaneExecutionEnv = Readonly<{
  readonly COMMERCE: Readonly<{ readonly fetch: CommerceEntityPlaneFetch }>;
  readonly COMMERCE_BASE_URL?: string;
  readonly COMMERCE_SERVICE_TOKEN?: string;
}>;

type CommerceEntityPlaneExecutionError = Readonly<{
  readonly code:
    | "commerce_entity_plane_proposal_missing"
    | "commerce_entity_plane_proposal_conflict"
    | "commerce_entity_plane_authority_invalid"
    | "commerce_entity_plane_flow_binding_invalid"
    | "commerce_entity_plane_flow_denied"
    | "commerce_entity_plane_binding_missing"
    | "commerce_entity_plane_commerce_unavailable"
    | "commerce_entity_plane_command_invalid"
    | "commerce_entity_plane_command_rejected"
    | "commerce_entity_plane_receipt_invalid"
    | "commerce_entity_plane_action_failed";
  readonly evidence?: unknown;
}>;

export type CommerceEntityPlaneExecutionOutcome = Readonly<{
  readonly action: ActionLedgerEntry;
  readonly receipt: CommerceMutationReceiptV1 | null;
  readonly effect: CommerceEntityPlaneEffect | null;
}>;

type EntityPlaneExecutorOrganisation = Pick<
  OrganisationCommerce,
  | "beginActionExecution"
  | "retryIndeterminateActionExecution"
  | "completeActionExecution"
  | "recordCommerceEntityPlaneEffect"
>;

type EntityPlaneExecutorCase = Readonly<{
  readonly readAcceptedCommerceEntityPlaneProposal: (
    input: Readonly<{
      readonly proposalId: string;
    }>,
  ) => Promise<CaseResult<CommerceEntityPlaneCaseProposal | null>>;
}>;

export async function executeCommerceEntityPlaneAction(
  input: Readonly<{
    readonly env: CommerceEntityPlaneExecutionEnv;
    readonly execution: OrganisationExecutionScope;
    readonly organisation: EntityPlaneExecutorOrganisation;
    readonly caseActor: EntityPlaneExecutorCase;
    readonly action: EntityPlaneAction;
    readonly now: number;
  }>,
): Promise<
  Result<CommerceEntityPlaneExecutionOutcome, CommerceEntityPlaneExecutionError>
> {
  if (
    input.execution.organisationId !== input.action.action.organisationId ||
    !(await input.execution.isActive())
  ) {
    return executionFailure("commerce_entity_plane_authority_invalid");
  }
  const proposal =
    await input.caseActor.readAcceptedCommerceEntityPlaneProposal({
      proposalId: input.action.proposalId,
    });
  if (!proposal.ok)
    return executionFailure(
      "commerce_entity_plane_proposal_missing",
      proposal.error,
    );
  if (
    proposal.value === null ||
    proposal.value.caseId !== input.action.caseId
  ) {
    return executionFailure("commerce_entity_plane_proposal_missing");
  }
  if (
    proposal.value.requestAuthority.organisationId !==
    input.action.action.organisationId
  ) {
    return executionFailure("commerce_entity_plane_proposal_conflict");
  }

  if (input.action.state === "confirmed") {
    if (
      input.action.commerceEffect === null ||
      input.action.commerceEffect.receipt.commandId !==
        input.action.idempotencyKey
    ) {
      return executionFailure("commerce_entity_plane_receipt_invalid");
    }
    return {
      ok: true,
      value: {
        action: input.action,
        receipt: input.action.commerceEffect.receipt,
        effect: input.action.commerceEffect,
      },
    };
  }
  if (input.action.state === "failed") {
    return {
      ok: true,
      value: { action: input.action, receipt: null, effect: null },
    };
  }

  const gate = await authorizeEntityPlaneAction({
    execution: input.execution,
    action: input.action,
    proposal: proposal.value,
  });
  if (!gate.ok) return gate;
  const action = gate.value.action;

  const command = commandFromCommerceEntityPlaneProposal(
    proposal.value.proposal,
  );

  const client = createEntityPlaneClient(
    input.env,
    String(input.action.action.organisationId),
  );
  if (client === null)
    return executionFailure("commerce_entity_plane_commerce_unavailable");

  const snapshot = await client.changes(
    String(gate.value.merchantBinding.merchantId),
    parseCommerceSnapshotRevision(0),
    1,
  );
  if (!snapshot.ok)
    return executionFailure(
      "commerce_entity_plane_commerce_unavailable",
      snapshot.error,
    );

  const begun =
    action.state === "indeterminate"
      ? await input.organisation.retryIndeterminateActionExecution({
          organisationId: action.action.organisationId,
          nonce: action.action.nonce.value,
          now: input.now,
          evidence: {
            kind: "provider_idempotent_replay",
            integrationAccountId: action.action.integrationAccountId,
            idempotencyKey: action.idempotencyKey,
            observedAt: input.now,
          },
        })
      : await input.organisation.beginActionExecution({
          organisationId: action.action.organisationId,
          nonce: action.action.nonce.value,
          now: input.now,
        });
  if (!begun.ok || begun.value.state !== "executing") {
    return executionFailure(
      "commerce_entity_plane_action_failed",
      begun.ok ? begun.value : begun.error,
    );
  }

  let commandRequest: Parameters<CommerceEntityPlaneClient["command"]>[0];
  try {
    const commandAuthority = commandAuthorityForExecution({
      proposal: proposal.value.proposal,
      requestAuthority: proposal.value.requestAuthority,
      merchantId: String(gate.value.merchantBinding.merchantId),
      commandId: action.idempotencyKey,
      expiresAt: action.action.exp,
    });
    const commandId = parseCommerceCommandId(action.idempotencyKey);
    const now = new Date(input.now).toISOString();
    assertCommerceEntityPlaneCommandAuthorityWithLexicon({
      organisationId: String(action.action.organisationId),
      merchantId: String(gate.value.merchantBinding.merchantId),
      commandId,
      authority: commandAuthority,
      command,
      now,
    });
    commandRequest = {
      organisationId: String(action.action.organisationId),
      merchantId: String(gate.value.merchantBinding.merchantId),
      commandId,
      expectedMerchantRevision: snapshot.value.merchantRevision,
      authority: commandAuthority,
      command,
    };
  } catch (error) {
    return settleEntityPlaneFailure(
      input.organisation,
      begun.value,
      input.now,
      {
        code: "commerce_entity_plane_command_invalid",
        detail: errorEvidence(error),
      },
      "commerce_entity_plane_command_invalid",
    );
  }
  const commandResult = await executeEntityPlaneCommand({
    client,
    request: commandRequest,
  });
  if (!commandResult.ok) {
    return settleEntityPlaneIndeterminate(
      input.organisation,
      begun.value,
      input.now,
      commandResult.error.evidence,
    );
  }
  if (commandResult.value.status === "rejected") {
    const evidence = {
      code: "commerce_entity_plane_command_rejected",
      error: commandResult.value.error,
    } as const;
    return settleEntityPlaneFailure(
      input.organisation,
      begun.value,
      input.now,
      evidence,
    );
  }

  const effect = buildCommerceEntityPlaneEffect(
    proposal.value.proposal,
    commandResult.value.receipt,
  );
  if (
    commandResult.value.receipt.commandId !== action.idempotencyKey ||
    effect === null
  ) {
    return settleEntityPlaneFailure(
      input.organisation,
      begun.value,
      input.now,
      {
        code: "commerce_entity_plane_receipt_invalid",
      },
      "commerce_entity_plane_receipt_invalid",
    );
  }

  const completed = await input.organisation.completeActionExecution({
    organisationId: action.action.organisationId,
    nonce: action.action.nonce.value,
    now: input.now,
    executionLeaseId: begun.value.executionLease.leaseId,
    outcome: "confirmed",
    providerResult: JSON.stringify(commandResult.value.receipt),
  });
  if (!completed.ok)
    return executionFailure(
      "commerce_entity_plane_action_failed",
      completed.error,
    );

  const recorded = await input.organisation.recordCommerceEntityPlaneEffect({
    organisationId: action.action.organisationId,
    nonce: action.action.nonce.value,
    now: input.now,
    effect,
  });
  if (!recorded.ok)
    return executionFailure(
      "commerce_entity_plane_action_failed",
      recorded.error,
    );
  return {
    ok: true,
    value: {
      action: recorded.value,
      receipt: commandResult.value.receipt,
      effect,
    },
  };
}

function commandAuthorityForExecution(
  input: Readonly<{
    proposal: CommerceEntityPlaneCaseProposal["proposal"];
    requestAuthority: RequestAuthority;
    merchantId: string;
    commandId: string;
    expiresAt: number;
  }>,
): CommerceEntityAuthority {
  const context = commandExecutionContext(input);
  switch (input.proposal.kind) {
    case "patch_custom_entity":
      return {
        kind: "entity_command",
        context,
        scope: { kind: "entity", entityRef: input.proposal.entityRef },
        target: {
          entityRef: input.proposal.entityRef,
          expectedRevision: input.proposal.expectedRevision,
        },
      };
    case "create_custom_relationship":
      return {
        kind: "relationship_create",
        context,
        scope: {
          kind: "relationship_definition",
          relationshipDefinition: input.proposal.definition,
        },
        target: {
          relationshipId: input.proposal.relationshipId,
          definition: input.proposal.definition,
          source: input.proposal.source,
          target: input.proposal.target,
        },
      };
    case "delete_custom_relationship":
      return {
        kind: "relationship_command",
        context,
        scope: {
          kind: "relationship",
          relationship: input.proposal.relationship,
        },
        target: { relationship: input.proposal.relationship },
      };
    case "replace_custom_relationship":
      return {
        kind: "relationship_replacement",
        context,
        scope: {
          kind: "relationship",
          relationship: input.proposal.relationship,
        },
        target: {
          relationship: input.proposal.relationship,
          replacementTarget: input.proposal.replacementTarget,
        },
      };
    case "add_commerce_list_entry":
      return {
        kind: "commerce_list_entry_create",
        context,
        scope: { kind: "commerce_list", listId: input.proposal.listId },
        target: {
          entry: {
            entryId: input.proposal.entryId,
            listId: input.proposal.listId,
            revision: input.proposal.revision,
          },
          listRevision: input.proposal.expectedListRevision,
          entityTypeId: entityTypeIdForReference(input.proposal.entityRef),
          entityRef: input.proposal.entityRef,
        },
      };
    case "patch_commerce_list_entry":
    case "remove_commerce_list_entry":
      return {
        kind: "commerce_list_entry_command",
        context,
        scope: {
          kind: "commerce_list_entry",
          entry: input.proposal.entry.entry,
        },
        target: {
          entry: input.proposal.entry.entry,
          expectedRevision: input.proposal.entry.entry.revision,
        },
      };
    default:
      return assertNever(
        input.proposal,
        "Unhandled commerce entity-plane proposal",
      );
  }
}

function entityTypeIdForReference(
  reference: CommerceEntityRef,
): CommerceEntityTypeId {
  switch (reference.origin) {
    case "system":
      return { origin: reference.origin, typeId: reference.typeId };
    case "custom":
      return { origin: reference.origin, typeId: reference.typeId };
    default:
      return assertNever(reference, "Unhandled commerce entity reference");
  }
}

function commandExecutionContext(
  input: Readonly<{
    requestAuthority: RequestAuthority;
    merchantId: string;
    commandId: string;
    expiresAt: number;
  }>,
): CommerceCommandAuthorityContext {
  return {
    organisationId: input.requestAuthority.organisationId,
    merchantId: parseCommerceMerchantId(input.merchantId),
    principalId: parseCommercePrincipalId(
      commandPrincipalId(input.requestAuthority),
    ),
    sensitivityCeiling: "restricted",
    expiresAt: parseCommerceTimestamp(new Date(input.expiresAt).toISOString()),
    causation: {
      kind: "command",
      commandId: parseCommerceCommandId(input.commandId),
    },
  };
}

function commandPrincipalId(authority: RequestAuthority): string {
  switch (authority.kind) {
    case "direct_conversation":
    case "shared_conversation":
    case "control":
      return authority.requesterPersonId;
    case "workflow":
      return authority.workflowId;
    case "agent_mailbox":
      return authority.mailboxBindingId;
    case "whatsapp_support":
      return authority.supportBindingId;
    default:
      return assertNever(authority, "Unhandled request authority");
  }
}

async function authorizeEntityPlaneAction(
  input: Readonly<{
    readonly execution: OrganisationExecutionScope;
    readonly action: EntityPlaneAction;
    readonly proposal: CommerceEntityPlaneCaseProposal;
  }>,
): Promise<
  Result<EntityPlaneActionGatePermit, CommerceEntityPlaneExecutionError>
> {
  const storedAuthority = parseStoredRequestAuthority(
    input.action.action.requestAuthority,
  );
  if (
    !storedAuthority.ok ||
    storedAuthority.value.requestAuthority.organisationId !==
      input.action.action.organisationId ||
    JSON.stringify(storedAuthority.value.requestAuthority) !==
      JSON.stringify(input.proposal.requestAuthority)
  ) {
    return executionFailure(
      "commerce_entity_plane_authority_invalid",
      storedAuthority.ok ? undefined : storedAuthority.error,
    );
  }
  const capability: ProviderCapabilityDefinition = {
    kind: "provider_resource",
    capabilityId: "commerce.action.propose",
    capabilityVersion: 1,
    integrationAccountId: input.action.action.integrationAccountId,
    resourceScope: input.action.action.resourceKey,
  };
  const granted = await authorizeCapabilityUse({
    db: input.execution.database,
    accountAccess: input.execution.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      input.action.action.sessionId,
      input.action.action.nonce.value,
    ),
    action: "execute",
    organisationId: input.action.action.organisationId,
    authority: input.action.action.requestAuthority,
    authorityPartition: input.action.action.authorityPartition,
    request: { capabilities: [capability] },
  });
  if (!granted.ok)
    return executionFailure(
      "commerce_entity_plane_authority_invalid",
      granted.error,
    );
  const commandAuthorization = await authorizeCommerceEntityPlaneCommand({
    db: input.execution.database,
    organisationId: input.action.action.organisationId,
    authority: storedAuthority.value.requestAuthority,
    proposal: input.proposal.proposal,
  });
  if (!commandAuthorization.ok) {
    return executionFailure(
      "commerce_entity_plane_authority_invalid",
      commandAuthorization.error,
    );
  }
  const merchantBinding = await resolveCommerceMerchantBinding({
    db: input.execution.database,
    organisationId: input.action.action.organisationId,
    integrationAccountId: input.action.action.integrationAccountId,
  });
  if (!merchantBinding.ok) {
    return executionFailure(
      "commerce_entity_plane_binding_missing",
      merchantBinding.error,
    );
  }
  const flowBinding = await FlowBinding.restore(
    input.action.action.flowBinding,
  );
  if (
    !flowBinding.ok ||
    !flowBindingMatchesIdentity(flowBinding.value, {
      organisationId: input.action.action.organisationId,
      sessionId: input.action.action.sessionId,
      authorityPartitionDigest: input.action.action.authorityPartition.digest,
    })
  ) {
    return executionFailure("commerce_entity_plane_flow_binding_invalid");
  }
  const approved =
    input.action.state === "signed" || input.action.state === "indeterminate";
  const flowDecision = await decideCurrentAuthorityFlowSink(
    input.execution.database,
    input.execution.accountAccess,
    {
      binding: flowBinding.value,
      sink: {
        kind: "tool_effect",
        destinationAuthority: input.action.action.requestAuthority,
        capabilityId: "commerce.action.propose",
        integrationAccountId: input.action.action.integrationAccountId,
        resourceScope: input.action.action.resourceKey,
        approvalSatisfied: approved,
      },
    },
  );
  if (flowDecision.kind !== "allow") {
    return executionFailure("commerce_entity_plane_flow_denied", flowDecision);
  }
  if (!approved) {
    return executionFailure("commerce_entity_plane_action_failed", {
      code: "commerce_entity_plane_action_requires_signed_approval",
    });
  }
  return {
    ok: true,
    value: {
      action: input.action,
      merchantBinding: merchantBinding.value,
    },
  };
}

export async function authorizeCommerceEntityPlaneCommand(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly authority: RequestAuthority;
    readonly proposal: CommerceEntityPlaneCaseProposal["proposal"];
  }>,
): Promise<Result<null, CommerceEntityPlaneCommandAuthorizationError>> {
  const commandAuthority = commandAuthorityForProposal(input.proposal);
  if (commandAuthority === null) {
    return {
      ok: false,
      error: { code: "commerce_entity_plane_command_invalid" },
    };
  }
  const grants = await listAccessGrants({
    db: input.db,
    organisationId: input.organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) {
    return {
      ok: false,
      error: { code: "commerce_entity_plane_command_grants_unavailable" },
    };
  }
  const selected = selectActiveGrants({
    organisationId: input.organisationId,
    authority: input.authority,
    grants: grants.value,
  });
  if (!selected.ok) {
    return {
      ok: false,
      error: { code: "commerce_entity_plane_command_grants_unavailable" },
    };
  }
  const policy = await readCurrentOrganisationPolicySnapshot(
    input.db,
    input.organisationId,
  );
  if (
    !policy.ok ||
    !policy.value.authz.allowedTools.includes(commandAuthority.capabilityId) ||
    policy.value.authz.deniedTools.includes(commandAuthority.capabilityId)
  ) {
    return {
      ok: false,
      error: { code: "commerce_entity_plane_command_policy_denied" },
    };
  }
  const commandGranted = selected.value.some((grant) =>
    commerceCommandGrantMatchesTarget({
      grant,
      capabilityId: commandAuthority.capabilityId,
      capabilityVersion: 1,
      scope: commandAuthority.scope,
      target: commandAuthority.target,
    }),
  );
  return commandGranted
    ? { ok: true, value: null }
    : {
        ok: false,
        error: { code: "commerce_entity_plane_command_not_granted" },
      };
}

function commandAuthorityForProposal(
  proposal: CommerceEntityPlaneCaseProposal["proposal"],
): Readonly<{
  readonly capabilityId: string;
  readonly scope: CommerceAuthorityScope;
  readonly target: CommerceMutationTarget;
}> | null {
  switch (proposal.kind) {
    case "patch_custom_entity":
      return {
        capabilityId: "commerce.entity.patch",
        scope: { kind: "entity", entityRef: proposal.entityRef },
        target: {
          kind: "custom_entity",
          entityRef: proposal.entityRef,
          revision: proposal.expectedRevision,
        },
      };
    case "create_custom_relationship": {
      let relationship: CommerceMutationTarget["relationship"];
      try {
        const command = commandFromCommerceEntityPlaneProposal(proposal);
        if (command.kind !== "create_custom_relationship") return null;
        relationship = {
          origin: "custom",
          relationshipId: command.command.target.relationshipId,
          definition: command.command.target.definition,
          revision: parseRelationshipRevision(1),
        };
      } catch {
        return null;
      }
      return {
        capabilityId: "commerce.relationship.create",
        scope: {
          kind: "relationship_definition",
          relationshipDefinition: proposal.definition,
        },
        target: { kind: "custom_relationship", relationship },
      };
    }
    case "delete_custom_relationship":
      return {
        capabilityId: "commerce.relationship.delete",
        scope: { kind: "relationship", relationship: proposal.relationship },
        target: {
          kind: "custom_relationship",
          relationship: proposal.relationship,
        },
      };
    case "replace_custom_relationship":
      return {
        capabilityId: "commerce.relationship.replace",
        scope: { kind: "relationship", relationship: proposal.relationship },
        target: {
          kind: "custom_relationship",
          relationship: proposal.relationship,
        },
      };
    case "add_commerce_list_entry":
      return {
        capabilityId: "commerce.list_entry.add",
        scope: { kind: "commerce_list", listId: proposal.listId },
        target: {
          kind: "commerce_list_entry",
          entry: {
            entryId: proposal.entryId,
            listId: proposal.listId,
            revision: proposal.revision,
          },
          revision: proposal.revision,
        },
      };
    case "patch_commerce_list_entry":
      return {
        capabilityId: "commerce.list_entry.patch",
        scope: { kind: "commerce_list_entry", entry: proposal.entry.entry },
        target: {
          kind: "commerce_list_entry",
          entry: proposal.entry.entry,
          revision: proposal.entry.entry.revision,
        },
      };
    case "remove_commerce_list_entry":
      return {
        capabilityId: "commerce.list_entry.remove",
        scope: { kind: "commerce_list_entry", entry: proposal.entry.entry },
        target: {
          kind: "commerce_list_entry",
          entry: proposal.entry.entry,
          revision: proposal.entry.entry.revision,
        },
      };
    default:
      return null;
  }
}

type EntityPlaneCommandCallError = Readonly<{
  readonly code: "commerce_entity_plane_commerce_unavailable";
  readonly evidence: unknown;
}>;

async function executeEntityPlaneCommand(
  input: Readonly<{
    readonly client: CommerceEntityPlaneClient;
    readonly request: Parameters<CommerceEntityPlaneClient["command"]>[0];
  }>,
): Promise<Result<CommerceCommandResult, EntityPlaneCommandCallError>> {
  try {
    const result = await input.client.command(input.request);
    return result.ok
      ? { ok: true, value: result.value }
      : {
          ok: false,
          error: {
            code: "commerce_entity_plane_commerce_unavailable",
            evidence: result.error,
          },
        };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "commerce_entity_plane_commerce_unavailable",
        evidence: errorEvidence(error),
      },
    };
  }
}

async function settleEntityPlaneIndeterminate(
  organisation: EntityPlaneExecutorOrganisation,
  begun: ExecutingActionLedgerEntry,
  now: number,
  evidence: unknown,
): Promise<
  Result<CommerceEntityPlaneExecutionOutcome, CommerceEntityPlaneExecutionError>
> {
  const completed = await organisation.completeActionExecution({
    organisationId: begun.action.organisationId,
    nonce: begun.action.nonce.value,
    now,
    executionLeaseId: begun.executionLease.leaseId,
    outcome: "indeterminate",
    providerResult: JSON.stringify(evidence),
  });
  return completed.ok
    ? executionFailure("commerce_entity_plane_commerce_unavailable", evidence)
    : executionFailure("commerce_entity_plane_action_failed", completed.error);
}

async function settleEntityPlaneFailure(
  organisation: EntityPlaneExecutorOrganisation,
  begun: ExecutingActionLedgerEntry,
  now: number,
  evidence: unknown,
  failureCode:
    | "commerce_entity_plane_command_invalid"
    | "commerce_entity_plane_command_rejected"
    | "commerce_entity_plane_receipt_invalid" = "commerce_entity_plane_command_rejected",
): Promise<
  Result<CommerceEntityPlaneExecutionOutcome, CommerceEntityPlaneExecutionError>
> {
  const completed = await organisation.completeActionExecution({
    organisationId: begun.action.organisationId,
    nonce: begun.action.nonce.value,
    now,
    executionLeaseId: begun.executionLease.leaseId,
    outcome: "failed",
    providerResult: JSON.stringify(evidence),
  });
  return completed.ok
    ? {
        ok: false,
        error: { code: failureCode, evidence },
      }
    : executionFailure("commerce_entity_plane_action_failed", completed.error);
}

function createEntityPlaneClient(
  env: CommerceEntityPlaneExecutionEnv,
  organisationId: string,
): CommerceEntityPlaneClient | null {
  if (
    env.COMMERCE_BASE_URL === undefined ||
    env.COMMERCE_SERVICE_TOKEN === undefined
  )
    return null;
  try {
    return new CommerceEntityPlaneClient({
      baseUrl: env.COMMERCE_BASE_URL,
      ...pantryCommerceAccess(
        env.COMMERCE_SERVICE_TOKEN,
        organisationId,
        env.COMMERCE.fetch.bind(env.COMMERCE),
      ),
    });
  } catch {
    return null;
  }
}

function executionFailure<T extends CommerceEntityPlaneExecutionError["code"]>(
  code: T,
  evidence?: unknown,
): Result<never, CommerceEntityPlaneExecutionError> {
  return {
    ok: false,
    error: evidence === undefined ? { code } : { code, evidence },
  };
}

function errorEvidence(error: unknown): Readonly<{ readonly message: string }> {
  return { message: error instanceof Error ? error.message : String(error) };
}
