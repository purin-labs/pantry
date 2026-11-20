import { prepareWorkflowProposal } from "../../commerce/bakery/workflow-proposals";
import { readDevice } from "../../devices/store";
import { acceptedExecutionAuthority } from "../../organisation-access/access";
import { sessionActionMutationExecution } from "../action-mutation-execution";
import { ToolRequestError } from "../../agent-tools/errors";
import type { ToolServiceRequest } from "../../agent-tools/registry";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { JevFeatureCommand } from "@purin-labs/control-api/portal/jev-features";
import { parseCaseId, parseSessionId } from "../../ids";
import {
  requireActiveOrganisationActor,
  requireActiveOrganisationActorAtPlacement,
} from "../actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../session-execution-admission";
import { sessionObservedCommerceEntity } from "../agent-session-information-flow";
import { resolveCurrentOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import { authorizeCapabilityUse } from "../../authorization/access-grants/turn-authority";
import {
  buildCustomConnectorWriteAuthority,
  type CustomConnectorWriteCatalogEntry,
} from "../../custom-connectors";
import { readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding } from "../agent-session-information-flow";
import {
  listOrganisationMembers,
  parseControlRole,
  roleMayConfigure,
  roleMayOperate,
} from "../../data/control-plane";
import { proposeCampaignBrief } from "../../data/campaign-brief";
import { createOperatorConfigurationDraft } from "../../data/operator-configuration-draft";
import {
  presentConfigurationCommand,
  previewCode,
} from "../../slack/configuration-presentation";
import { sha256Hex } from "@purin-labs/std";
import { liveDeviceMember } from "../../agent-tools/session-support";
import { bindAllowanceReference } from "./model-route";
import { OPERATOR_DRAFT_TTL_MS } from "./support";
import { SessionActorBase } from "./session-actor-base";

/**
 * Proposal staging for the embedded harness: configuration drafts, campaign briefs, recipe workflows, devices and custom connector writes.
 */
export abstract class SessionProposalStaging extends SessionActorBase {
  /**
   * Stages one campaign brief for a person to decide on.
   *
   * The brief names commerce records, so every one it names must be a record
   * this Case actually read, at the revision it read. Without that check a
   * plausible-looking identifier the model invented would enter a brief that
   * an operator then approves on the strength of its detail.
   */
  protected async proposeCampaignBriefForEmbeddedHarness(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    request: ToolServiceRequest<"commerce", "proposeCampaignBrief">,
  ): Promise<unknown> {
    const staging = await this.beginProposalStaging(input, "campaign brief");
    // A brief spends a merchant's budget against a merchant's catalogue; with
    // no merchant bound there is nothing for it to be a brief about.
    if (staging.merchantId === null) {
      throw new Error("campaign brief has no bound merchant");
    }
    for (const target of request.targets) {
      if (
        !sessionObservedCommerceEntity({
          sql: this.ctx.storage.sql,
          organisationId: String(input.execution.scope.organisationId),
          sessionId: String(input.assignment.sessionId),
          entityType: target.entityType,
          entityId: target.entityId,
          revision: target.revision,
        })
      ) {
        throw new Error("campaign brief target was not observed in this Case");
      }
    }
    const digest = await sha256Hex(JSON.stringify(request));
    const briefId = `brief_agent_${input.assignment.assignmentId}_${digest.slice(0, 24)}`;
    const proposed = await proposeCampaignBrief({
      scope: input.execution.scope,
      authorizeCommit: requireSessionExecution.bind(
        null,
        input.execution,
        input.lease,
      ),
      briefId,
      merchantId: staging.merchantId,
      caseId: staging.caseId,
      objective: request.objective,
      targets: request.targets,
      channel: request.channel,
      audienceDescription: request.audienceDescription,
      messageVariants: request.messageVariants,
      requestedBudgetMinor: request.requestedBudgetMinor,
      currency: request.currency,
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
      disclosures: request.disclosures,
      supportingEvidence: request.supportingEvidence,
      expiresAt: staging.now + OPERATOR_DRAFT_TTL_MS,
      now: staging.now,
    });
    if (!proposed.ok)
      throw new Error(`campaign brief refused: ${proposed.error.code}`);
    await requireSessionExecution(input.execution, input.lease);
    return { kind: "campaign_brief_drafted", briefId, caseId: staging.caseId };
  }

  /**
   * Stages one setup change for a person to confirm.
   *
   * The command body goes through the same parse a Portal form submission
   * uses, so this cannot express a change the Portal could not.
   */
  protected async proposeConfigurationForEmbeddedHarness(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    request: ToolServiceRequest<"commerce", "proposeConfiguration">,
  ): Promise<unknown> {
    const staging = await this.beginProposalStaging(
      input,
      "configuration proposal",
      { portalChat: true },
    );
    return this.stageConfigurationDraft(input, staging, request.command, {});
  }

  /**
   * Plan 84: stores a proposed change to a recipe, for the person who asked to approve.
   * The result must pass the engine's admission. The words come from this chat, which
   * is private, so nobody else reads the proposal until that person approves it.
   */
  protected async proposeRecipeWorkflowForEmbeddedHarness(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    request: ToolServiceRequest<"kitchen", "proposeRecipeWorkflow">,
    operationId: string,
  ): Promise<unknown> {
    const { scope } = input.execution;
    const { lease } = input;
    const refuse = (message: string): ToolRequestError =>
      new ToolRequestError(`${message} Nothing was stored.`);
    if (lease.requestAuthority.kind !== "control")
      throw refuse("A person proposes a recipe change from the Portal chat.");
    const member = await liveDeviceMember(
      scope.database,
      scope.organisationId,
      lease,
    );
    if (member === null || !roleMayConfigure(member.role))
      throw refuse(
        "Only an owner or administrator approves a recipe change, and this person cannot. Tell the person to ask one of them.",
      );
    const staging = await this.beginProposalStaging(
      input,
      "recipe workflow proposal",
      { portalChat: true },
    );
    const prepared = await prepareWorkflowProposal(this.env, scope, {
      ...request,
      sessionId: String(lease.session.sessionId),
      turnId: String(lease.turn.turnId),
      operationId,
    });
    await requireSessionExecution(input.execution, lease);
    if (prepared.kind === "refused") throw refuse(prepared.message);
    const staged = await this.stageConfigurationDraft(
      input,
      staging,
      { family: "workflow_change", change: prepared.command },
      {
        approval:
          "The words of this chat are private, so only the person who asked sees this proposal. They approve it on the card in this chat or on the recipe's Workflow page, which runs the comparison.",
      },
    );
    // An open page reads the proposal. A lost signal waits for the next read.
    const organisation = await requireActiveOrganisationActor({
      env: this.env,
      organisationId: scope.organisationId,
      now: Date.now(),
    });
    organisation.bakeryWorkflowApplied(request.workflowId);
    return staged;
  }

  /**
   * Stages a restriction or a resume of one device, for the person who asked
   * to confirm on a card. Only a person changes a device's access.
   */
  protected async proposeDeviceForEmbeddedHarness(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    request: ToolServiceRequest<"devices", "proposeDevice">,
  ): Promise<unknown> {
    const member = await liveDeviceMember(
      input.execution.scope.database,
      input.execution.scope.organisationId,
      input.lease,
    );
    if (member === null || !roleMayOperate(member.role))
      throw new ToolRequestError(
        "A change to a device needs a person with the staff role or higher, and the person who asked does not have it now. Nothing changed. Tell the person.",
      );
    const device = await readDevice(
      input.execution.scope.database,
      input.execution.scope.organisationId,
      request.deviceId,
    );
    if (device === null)
      throw new ToolRequestError(
        "That device does not exist. Nothing changed. Call device_read for the list.",
      );
    const staging = await this.beginProposalStaging(input, "device proposal", {
      portalChat: true,
    });
    return this.stageConfigurationDraft(
      input,
      staging,
      {
        family: "device_command",
        command:
          request.action === "restrict"
            ? {
                kind: "device_restrict",
                deviceId: device.deviceId,
                deviceName: device.name,
                reason: request.reason,
              }
            : {
                kind: "device_resume",
                deviceId: device.deviceId,
                deviceName: device.name,
              },
      },
      {},
    );
  }

  /**
   * Plan 88: stages a change to one Jev switch, for the admin who asked to
   * approve on a card. Turning a switch on sends new data to TypeSafe, so a
   * person approves each change, and only an admin may, as on Settings › Jev.
   */
  protected async proposeJevFeatureForEmbeddedHarness(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    request: JevFeatureCommand,
  ): Promise<unknown> {
    const member = await liveDeviceMember(
      input.execution.scope.database,
      input.execution.scope.organisationId,
      input.lease,
    );
    if (member === null || !roleMayConfigure(member.role))
      throw new ToolRequestError(
        "Only an owner or admin can change a Jev switch, and the person who asked cannot. Nothing changed. Tell the person to ask an owner or admin. Do not ask for a permission or retry.",
      );
    const staging = await this.beginProposalStaging(
      input,
      "Jev switch proposal",
      { portalChat: true },
    );
    return this.stageConfigurationDraft(
      input,
      staging,
      { family: "jev_feature", command: request },
      {},
    );
  }

  /**
   * Plan 24 S1: stages a bake stock level, for the admin who asked to confirm
   * on a card. An admin or the owner sets a level on the Bakes page, so only
   * such a person may ask for one.
   */
  protected async proposeBakeStockLevelForEmbeddedHarness(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    request: ToolServiceRequest<"kitchen", "proposeBakeStockLevel">,
  ): Promise<unknown> {
    const member = await liveDeviceMember(
      input.execution.scope.database,
      input.execution.scope.organisationId,
      input.lease,
    );
    if (member === null || !roleMayConfigure(member.role))
      throw new ToolRequestError(
        "Only an admin or the owner sets a stock level, and the person who asked cannot. Nothing changed. Tell the person to ask an admin.",
      );
    const staging = await this.beginProposalStaging(
      input,
      "bake stock level proposal",
      { portalChat: true },
    );
    return this.stageConfigurationDraft(
      input,
      staging,
      { family: "bake_stock_level", level: request },
      {},
    );
  }

  /**
   * The identity and lease checks every proposal shares.
   *
   * Proposing is a write, so it needs a live turn lease and a requester the
   * organisation currently recognises — not the identity the Case was opened with.
   */
  protected async beginProposalStaging(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    label: string,
    surfaces: Readonly<{ portalChat: boolean }> = { portalChat: false },
  ): Promise<
    Readonly<{
      caseId: string;
      merchantId: string | null;
      actorPersonId: string;
      actorUserId: string;
      now: number;
    }>
  > {
    await requireSessionExecution(input.execution, input.lease);
    const now = Date.now();
    if (
      String(input.assignment.sessionId) !==
      String(input.lease.session.sessionId)
    ) {
      throw new Error(`${label} session identity is invalid`);
    }
    const authority = input.lease.requestAuthority;
    if (
      authority.kind !== "direct_conversation" &&
      authority.kind !== "shared_conversation" &&
      (authority.kind !== "control" || !surfaces.portalChat)
    ) {
      throw new Error(`${label} requester is not a person`);
    }
    // Staging a change an admin will be shown is itself an operator act; the
    // rank that may confirm it is checked again at confirmation.
    if (!parseControlRole(authority.role).ok) {
      throw new Error(`${label} requester role is unrecognised`);
    }
    const members = await listOrganisationMembers({
      db: input.execution.scope.database,
      organisationId: input.execution.scope.organisationId,
    });
    const member = members.find(
      (candidate) =>
        candidate.personId === authority.requesterPersonId &&
        candidate.role === authority.role,
    );
    if (member === undefined)
      throw new Error(`${label} requester is not a current member`);
    const binding = await resolveCurrentOrganisationCommerceMerchantBinding({
      db: input.execution.scope.database,
      organisationId: input.execution.scope.organisationId,
    });
    await requireSessionExecution(input.execution, input.lease);
    return {
      caseId: String(input.assignment.caseId),
      merchantId: binding.ok ? String(binding.value.merchantId) : null,
      actorPersonId: authority.requesterPersonId,
      actorUserId: member.userId,
      now,
    };
  }

  /**
   * Writes one draft and returns the exact words that will confirm it.
   *
   * The reply matcher accepts only "<action label> <code>", so the model has
   * to be told both; returning a summary the operator could paraphrase would
   * produce a confirmation that never settles.
   */
  protected async stageConfigurationDraft(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    staging: Readonly<{
      caseId: string;
      actorPersonId: string;
      actorUserId: string;
      now: number;
    }>,
    rawCommandInput: unknown,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    // A price allowance is measured from a reference price. Capturing the
    // Offer's revision and price at staging binds the preview to what the
    // operator is shown; confirmation then refuses if the price has moved
    // since, instead of silently measuring the band from a price nobody
    // approved.
    await requireSessionExecution(input.execution, input.lease);
    const rawCommand = await bindAllowanceReference(
      this.env,
      input.execution,
      input.lease,
      rawCommandInput,
    );
    const digest = await sha256Hex(JSON.stringify(rawCommand));
    // The id carries the attempt, not only the content: a change staged again
    // after an earlier draft of it was decided must get a fresh row, and the
    // store returns the pending twin itself when one is still open.
    const draftId = `draft_agent_${input.assignment.assignmentId}_${digest.slice(0, 16)}_${staging.now.toString(36)}`;
    const created = await createOperatorConfigurationDraft({
      scope: input.execution.scope,
      authorizeCommit: requireSessionExecution.bind(
        null,
        input.execution,
        input.lease,
      ),
      draftId,
      caseId: staging.caseId,
      actorUserId: staging.actorUserId,
      actorPersonId: staging.actorPersonId,
      rawCommand,
      mutationId: `mutation_${draftId}`,
      now: staging.now,
      expiresAt: staging.now + OPERATOR_DRAFT_TTL_MS,
    });
    if (!created.ok) {
      throw new Error(`configuration draft refused: ${created.error.code}`);
    }
    await requireSessionExecution(input.execution, input.lease);
    const presented = presentConfigurationCommand(created.value.command);
    // A Portal chat has a card for this draft; Slack has only the reply.
    const confirmation =
      input.lease.requestAuthority.kind === "control"
        ? {
            confirmOn:
              "The person who asked confirms this on the card in this chat. Nothing has changed yet.",
          }
        : {
            confirmWith: `${presented.actionLabel} ${previewCode(created.value.commandDigest)}`,
          };
    return {
      kind: "configuration_drafted",
      draftId,
      summary: presented.summary,
      ...confirmation,
      ...extra,
    };
  }

  protected async proposeCustomConnectorWriteForEmbeddedHarness(
    input: {
      readonly execution: SessionExecutionAdmission;
      readonly lease: HarnessTurnLease;
      readonly assignment: CaseAssignment;
    },
    entry: CustomConnectorWriteCatalogEntry,
    rawArguments: unknown,
    operationId: string,
  ): Promise<unknown> {
    await requireSessionExecution(input.execution, input.lease);
    const requiredCapability = {
      kind: "custom_connector_operation" as const,
      capabilityId: "custom_connector.write",
      capabilityVersion: 1,
      integrationAccountId: entry.integrationAccountId,
      connectorId: entry.connectorId,
      definitionRevision: entry.definitionRevision,
      definitionDigest: entry.definitionDigest,
      operationId: entry.operation.id,
    };
    const capability = await authorizeCapabilityUse({
      db: input.execution.scope.database,
      accountAccess: input.execution.scope.accountAccess,
      userAuthority: acceptedExecutionAuthority(
        input.lease.session.sessionId,
        input.lease.turn.turnId,
      ),
      action: "execute",
      organisationId: input.execution.scope.organisationId,
      authority: input.lease.requestAuthority,
      authorityPartition: input.assignment.authorityPartition,
      request: { capabilities: [requiredCapability] },
    });
    if (!capability.ok) {
      throw new Error(
        `custom connector proposal authority rejected: ${capability.error.code}`,
      );
    }
    const informationFlow = await readPersistedSessionTurnFlowBinding(
      this.ctx.storage.sql,
      {
        organisationId: String(input.execution.scope.organisationId),
        sessionId: String(input.assignment.sessionId),
        turnId: String(input.lease.turn.turnId),
      },
    );
    if (
      !informationFlow.ok ||
      informationFlow.value === null ||
      informationFlow.value.authorityPartitionDigest !==
        input.lease.authorityPartitionDigest
    ) {
      throw new Error(
        "custom connector proposal information-flow binding unavailable",
      );
    }
    const providerEffectId = [
      "effect",
      input.assignment.assignmentId,
      operationId,
    ].join("_");
    const authority = await buildCustomConnectorWriteAuthority({
      entry,
      rawArguments,
      providerEffectId,
    });
    if (!authority.ok) {
      throw new Error(
        `custom connector proposal invalid: ${authority.error.code}`,
      );
    }
    const caseId = parseCaseId(String(input.assignment.caseId));
    const sessionId = parseSessionId(String(input.assignment.sessionId));
    if (!caseId.ok || !sessionId.ok) {
      throw new Error("custom connector proposal identity is invalid");
    }
    const organisation = await requireActiveOrganisationActorAtPlacement({
      env: this.env,
      organisationId: input.execution.scope.organisationId,
      placement: input.execution.scope.placement,
      now: Date.now(),
    });
    const proposalDigest = await sha256Hex(
      JSON.stringify({
        capabilityKey: entry.capabilityKey,
        providerEffectId,
        canonicalInputDigest: authority.value.canonicalInputDigest,
      }),
    );
    const proposalId = `proposal_custom_${proposalDigest.slice(0, 32)}`;
    const now = Date.now();
    const resourceKey =
      authority.value.resourceIdentity.kind === "existing_record"
        ? `custom_connector:${entry.connectorId}:${entry.operation.id}:${authority.value.resourceIdentity.value}`
        : `custom_connector:${entry.connectorId}:${entry.operation.id}:${providerEffectId}`;
    await requireSessionExecution(input.execution, input.lease);
    const proposed = await organisation.proposeAction({
      execution: sessionActionMutationExecution(
        input.execution.scope,
        input.lease,
      ),
      organisationId: input.execution.scope.organisationId,
      integrationAccountId: entry.integrationAccountId,
      requestAuthority: input.lease.requestAuthority,
      authorityPartition: input.assignment.authorityPartition,
      authority: authority.value,
      caseId: caseId.value,
      proposalId,
      sessionId: sessionId.value,
      threadId: String(input.assignment.caseId),
      draft: {
        host: new URL(entry.origin).host,
        verb: `custom_connector.${entry.operation.effect.kind}`,
        path:
          entry.operation.transport.kind === "mcp"
            ? entry.operation.transport.endpointPath
            : entry.operation.transport.pathTemplate,
        argsHash: authority.value.canonicalInputDigest,
        amount: null,
        resourceKey,
      },
      flowBinding: informationFlow.value.binding.toJSON(),
      exp: now + 15 * 60_000,
      now,
    });
    if (!proposed.ok) {
      throw new Error(
        `custom connector proposal ledger rejected: ${proposed.error.code}`,
      );
    }
    await requireSessionExecution(input.execution, input.lease);
    const requested = await organisation.requestActionApproval({
      execution: sessionActionMutationExecution(
        input.execution.scope,
        input.lease,
      ),
      organisationId: input.execution.scope.organisationId,
      nonce: proposed.value.action.nonce.value,
      now,
    });
    if (!requested.ok) {
      throw new Error(
        `custom connector approval request rejected: ${requested.error.code}`,
      );
    }
    await requireSessionExecution(input.execution, input.lease);
    return {
      kind: "custom_connector_write_proposed",
      nonce: requested.value.action.nonce.value,
      state: requested.value.state,
      connectorId: entry.connectorId,
      operationId: entry.operation.id,
      effect: entry.operation.effect.kind,
      providerEffectId,
      requiresHumanApproval: true,
      reviewQuery: `?customConnector=${encodeURIComponent(entry.connectorId)}&customAction=${encodeURIComponent(requested.value.action.nonce.value)}`,
    };
  }
}
