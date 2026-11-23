import {
  actorMachineCensus,
  type MachineCensus,
} from "@purin-labs/actor-runtime/actors/lifecycle/machine-census";
import { ACTOR_MACHINES } from "./actor-machines";
import { readWarmActorSlots } from "@purin-labs/actor-runtime/actors/warm-actor-slots";
import { invalidateEmailCaseContextCollectionProposals } from "@purin-labs/area-inbox/server/actors/email-case-context-collection-evidence";
import type { Env } from "@purin-labs/kernel/env";
import {
  actorExecutionAdmissionOpen,
  closeActorExecutionAdmission,
} from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import {
  permissionDecisionDeliveryId,
  permissionNoticeDeliveryId,
} from "../slack/permission-request-notice";
import {
  advanceActorActivationSchema,
  pinnedActorDatabase,
  type ActorActivationSchemaAdvance,
  type ActorActivationSchemaAdvanceError,
} from "@purin-labs/actor-runtime/actors/actor-activation";
import { type ActorExportError } from "@purin-labs/actor-runtime/actors/actor-export";
import type {
  ActorActivationRequest,
  ActorFenceToken,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { CONNECTOR_ACTOR_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import { readEmailRuntime } from "@purin-labs/area-inbox/server/actors/connector-email";
import {
  parseConnectorCaseWorkRecoveryRequest,
  parseConnectorCaseWorkRequest,
} from "@purin-labs/conversation/actors/connector-case-work";
import {
  acceptCaseWorkTransaction,
  acceptSlackFollowUpTransaction,
  parkSlackPermissionTransaction,
  parkSlackSideCaseTransaction,
  parseSlackFollowUpRequest,
  parseSlackPermissionParkRequest,
  parseSlackPermissionNotice,
  parseSlackPermissionRelease,
  parseSlackSideCaseParkRequest,
  readParkedSlackPermission,
  releaseSlackPermissionTransaction,
  SLACK_CASE_WORK,
  type SlackFollowUpAcceptance,
  type SlackPermissionParked,
  type SlackSideCaseParked,
} from "./connector-slack-case-work";
import {
  parseConnectorSlackIngressRequest,
  type ConnectorSlackIngressOutcome,
} from "./connector-slack-ingress";
import {
  parseSlackSideCaseProposalPost,
  parseSlackSideCaseStartRequest,
  postSlackSideCaseProposal,
  type SlackSideCaseStartOutcome,
} from "./connector-side-case";
import { buildAdmittedSlackCaseCommand } from "../slack/case-command";
import {
  authorizeSlackCaseIngressAtScope,
  startSlackCaseIngressRead,
} from "../slack/ingress-admission";
import { reopenWithheldConnectorSlackDelivery } from "./connector-slack-stream";
import { deliverSlackPermissionNotice } from "../slack/case-processing";
import type { Result } from "@purin-labs/kernel/result";
import { type PlacedActorExportSource } from "@purin-labs/actor-runtime/actors/lifecycle/placed-actor";
import { armAlarmBy } from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import { inspectConnector } from "@purin-labs/conversation/actors/connector/delivery";
import type { ConnectorChannels } from "@purin-labs/conversation/actors/connector/channel-adapter";
import { SlackConnectorChannel } from "./connector/slack-channel";
import {
  ensureConnectorIdentity,
  parseDeliveryRequest,
} from "@purin-labs/conversation/actors/connector/ingress-parsers";
import {
  invalid,
  scheduleAcceptedCaseWorkAlarm,
} from "@purin-labs/conversation/actors/connector/support";
import {
  type ConnectorDeliveryResult,
  type ConnectorResult,
  type ConnectorSnapshot,
} from "@purin-labs/conversation/actors/connector/types";
import {
  ConnectorEmail,
  type ConnectorEmailRpc,
} from "./connector/connector-email-actor";
import { ConnectorActorBase } from "@purin-labs/conversation/actors/connector/connector-actor-base";
import {
  ConnectorWhatsApp,
  type ConnectorWhatsAppRpc,
} from "@purin-labs/surface-whatsapp/server/actors/connector/connector-whatsapp-actor";
import {
  ConnectorEvals,
  type ConnectorEvalsRpc,
} from "@purin-labs/area-brain/server/actors/connector/connector-evals";

export class ConnectorDO
  extends ConnectorActorBase
  implements ConnectorEvalsRpc, ConnectorWhatsAppRpc, ConnectorEmailRpc
{
  private readonly slack = new SlackConnectorChannel(this.channelHost());

  /** The eval runs of this Connector. */
  protected readonly evals = new ConnectorEvals(this.moduleHost, {
    evalAgentActive: () => this.email.evalAgentActive(),
    runEvalTask: (...input) => this.email.runEvalTask(...input),
  });

  /** The WhatsApp channel of this Connector. */
  protected readonly whatsApp = new ConnectorWhatsApp(this.moduleHost);

  /** The email channel of this Connector: the mailboxes and their replies. */
  protected readonly email = new ConnectorEmail(this.moduleHost, this.evals);

  reconcileRelocationMailReceipt(
    ...input: Parameters<ConnectorEmail["reconcileRelocationMailReceipt"]>
  ) {
    return this.email.reconcileRelocationMailReceipt(...input);
  }

  mailAssistant(...input: Parameters<ConnectorEmail["mailAssistant"]>) {
    return this.email.mailAssistant(...input);
  }

  readMailOrganization(
    ...input: Parameters<ConnectorEmail["readMailOrganization"]>
  ) {
    return this.email.readMailOrganization(...input);
  }

  readMailClassifiedPage(
    ...input: Parameters<ConnectorEmail["readMailClassifiedPage"]>
  ) {
    return this.email.readMailClassifiedPage(...input);
  }

  readMailDecision(...input: Parameters<ConnectorEmail["readMailDecision"]>) {
    return this.email.readMailDecision(...input);
  }

  manageMailOrganization(
    ...input: Parameters<ConnectorEmail["manageMailOrganization"]>
  ) {
    return this.email.manageMailOrganization(...input);
  }

  acceptEmailChange(...input: Parameters<ConnectorEmail["acceptEmailChange"]>) {
    return this.email.acceptEmailChange(...input);
  }

  checkEmailChange(...input: Parameters<ConnectorEmail["checkEmailChange"]>) {
    return this.email.checkEmailChange(...input);
  }

  activateEmailProcessing(
    ...input: Parameters<ConnectorEmail["activateEmailProcessing"]>
  ) {
    return this.email.activateEmailProcessing(...input);
  }

  disableEmailProcessing(
    ...input: Parameters<ConnectorEmail["disableEmailProcessing"]>
  ) {
    return this.email.disableEmailProcessing(...input);
  }

  resumeEmailProcessing(
    ...input: Parameters<ConnectorEmail["resumeEmailProcessing"]>
  ) {
    return this.email.resumeEmailProcessing(...input);
  }

  reconnectEmailProcessing(
    ...input: Parameters<ConnectorEmail["reconnectEmailProcessing"]>
  ) {
    return this.email.reconnectEmailProcessing(...input);
  }

  renewEmailWatch(...input: Parameters<ConnectorEmail["renewEmailWatch"]>) {
    return this.email.renewEmailWatch(...input);
  }

  inspectEmailRuntime(
    ...input: Parameters<ConnectorEmail["inspectEmailRuntime"]>
  ) {
    return this.email.inspectEmailRuntime(...input);
  }

  searchEmailMailbox(
    ...input: Parameters<ConnectorEmail["searchEmailMailbox"]>
  ) {
    return this.email.searchEmailMailbox(...input);
  }

  createEmailReplyProposal(
    ...input: Parameters<ConnectorEmail["createEmailReplyProposal"]>
  ) {
    return this.email.createEmailReplyProposal(...input);
  }

  createEmailOperationalProposal(
    ...input: Parameters<ConnectorEmail["createEmailOperationalProposal"]>
  ) {
    return this.email.createEmailOperationalProposal(...input);
  }

  editEmailOperationalProposal(
    ...input: Parameters<ConnectorEmail["editEmailOperationalProposal"]>
  ) {
    return this.email.editEmailOperationalProposal(...input);
  }

  previewEmailOperationalProposal(
    ...input: Parameters<ConnectorEmail["previewEmailOperationalProposal"]>
  ) {
    return this.email.previewEmailOperationalProposal(...input);
  }

  dispatchEmailOperational(
    ...input: Parameters<ConnectorEmail["dispatchEmailOperational"]>
  ) {
    return this.email.dispatchEmailOperational(...input);
  }

  rejectEmailOperational(
    ...input: Parameters<ConnectorEmail["rejectEmailOperational"]>
  ) {
    return this.email.rejectEmailOperational(...input);
  }

  revokeEmailOperationalProposals(
    ...input: Parameters<ConnectorEmail["revokeEmailOperationalProposals"]>
  ) {
    return this.email.revokeEmailOperationalProposals(...input);
  }

  previewEmailProposal(
    ...input: Parameters<ConnectorEmail["previewEmailProposal"]>
  ) {
    return this.email.previewEmailProposal(...input);
  }

  authorizeEmailProposalDelivery(
    ...input: Parameters<ConnectorEmail["authorizeEmailProposalDelivery"]>
  ) {
    return this.email.authorizeEmailProposalDelivery(...input);
  }

  dispatchEmailReply(
    ...input: Parameters<ConnectorEmail["dispatchEmailReply"]>
  ) {
    return this.email.dispatchEmailReply(...input);
  }

  readEmailReplyProvenance(
    ...input: Parameters<ConnectorEmail["readEmailReplyProvenance"]>
  ) {
    return this.email.readEmailReplyProvenance(...input);
  }

  recordEmailReplyEditProvenance(
    ...input: Parameters<ConnectorEmail["recordEmailReplyEditProvenance"]>
  ) {
    return this.email.recordEmailReplyEditProvenance(...input);
  }

  editReviewedEmailReply(
    ...input: Parameters<ConnectorEmail["editReviewedEmailReply"]>
  ) {
    return this.email.editReviewedEmailReply(...input);
  }

  readEmailReplyCorrection(
    ...input: Parameters<ConnectorEmail["readEmailReplyCorrection"]>
  ) {
    return this.email.readEmailReplyCorrection(...input);
  }

  previewEmailRelationship(
    ...input: Parameters<ConnectorEmail["previewEmailRelationship"]>
  ) {
    return this.email.previewEmailRelationship(...input);
  }

  correctEmailRelationship(
    ...input: Parameters<ConnectorEmail["correctEmailRelationship"]>
  ) {
    return this.email.correctEmailRelationship(...input);
  }

  dispatchReviewedEmailReply(
    ...input: Parameters<ConnectorEmail["dispatchReviewedEmailReply"]>
  ) {
    return this.email.dispatchReviewedEmailReply(...input);
  }

  resolveEmailProposal(
    ...input: Parameters<ConnectorEmail["resolveEmailProposal"]>
  ) {
    return this.email.resolveEmailProposal(...input);
  }

  disposeEmailProposal(
    ...input: Parameters<ConnectorEmail["disposeEmailProposal"]>
  ) {
    return this.email.disposeEmailProposal(...input);
  }

  revokeEmailMailbox(
    ...input: Parameters<ConnectorEmail["revokeEmailMailbox"]>
  ) {
    return this.email.revokeEmailMailbox(...input);
  }

  acceptWhatsAppEvent(
    ...input: Parameters<ConnectorWhatsApp["acceptWhatsAppEvent"]>
  ) {
    return this.whatsApp.acceptWhatsAppEvent(...input);
  }

  activateWhatsAppProcessing(
    ...input: Parameters<ConnectorWhatsApp["activateWhatsAppProcessing"]>
  ) {
    return this.whatsApp.activateWhatsAppProcessing(...input);
  }

  disableWhatsAppProcessing(
    ...input: Parameters<ConnectorWhatsApp["disableWhatsAppProcessing"]>
  ) {
    return this.whatsApp.disableWhatsAppProcessing(...input);
  }

  resumeWhatsAppProcessing(
    ...input: Parameters<ConnectorWhatsApp["resumeWhatsAppProcessing"]>
  ) {
    return this.whatsApp.resumeWhatsAppProcessing(...input);
  }

  inspectWhatsAppRuntime(
    ...input: Parameters<ConnectorWhatsApp["inspectWhatsAppRuntime"]>
  ) {
    return this.whatsApp.inspectWhatsAppRuntime(...input);
  }

  readWhatsAppConversationHeads(
    ...input: Parameters<ConnectorWhatsApp["readWhatsAppConversationHeads"]>
  ) {
    return this.whatsApp.readWhatsAppConversationHeads(...input);
  }

  readWhatsAppCasePanel(
    ...input: Parameters<ConnectorWhatsApp["readWhatsAppCasePanel"]>
  ) {
    return this.whatsApp.readWhatsAppCasePanel(...input);
  }

  previewWhatsAppProposal(
    ...input: Parameters<ConnectorWhatsApp["previewWhatsAppProposal"]>
  ) {
    return this.whatsApp.previewWhatsAppProposal(...input);
  }

  editWhatsAppProposal(
    ...input: Parameters<ConnectorWhatsApp["editWhatsAppProposal"]>
  ) {
    return this.whatsApp.editWhatsAppProposal(...input);
  }

  dispatchWhatsAppReply(
    ...input: Parameters<ConnectorWhatsApp["dispatchWhatsAppReply"]>
  ) {
    return this.whatsApp.dispatchWhatsAppReply(...input);
  }

  disposeWhatsAppProposal(
    ...input: Parameters<ConnectorWhatsApp["disposeWhatsAppProposal"]>
  ) {
    return this.whatsApp.disposeWhatsAppProposal(...input);
  }

  resolveWhatsAppIndeterminateSend(
    ...input: Parameters<ConnectorWhatsApp["resolveWhatsAppIndeterminateSend"]>
  ) {
    return this.whatsApp.resolveWhatsAppIndeterminateSend(...input);
  }

  takeOverWhatsAppCase(
    ...input: Parameters<ConnectorWhatsApp["takeOverWhatsAppCase"]>
  ) {
    return this.whatsApp.takeOverWhatsAppCase(...input);
  }

  returnWhatsAppCaseToAgent(
    ...input: Parameters<ConnectorWhatsApp["returnWhatsAppCaseToAgent"]>
  ) {
    return this.whatsApp.returnWhatsAppCaseToAgent(...input);
  }

  composeWhatsAppHumanReply(
    ...input: Parameters<ConnectorWhatsApp["composeWhatsAppHumanReply"]>
  ) {
    return this.whatsApp.composeWhatsAppHumanReply(...input);
  }

  closeWhatsAppCase(
    ...input: Parameters<ConnectorWhatsApp["closeWhatsAppCase"]>
  ) {
    return this.whatsApp.closeWhatsAppCase(...input);
  }

  startEvalRun(...input: Parameters<ConnectorEvals["startEvalRun"]>) {
    return this.evals.startEvalRun(...input);
  }

  readEvalRunCommand(
    ...input: Parameters<ConnectorEvals["readEvalRunCommand"]>
  ) {
    return this.evals.readEvalRunCommand(...input);
  }

  cancelEvalRun(...input: Parameters<ConnectorEvals["cancelEvalRun"]>) {
    return this.evals.cancelEvalRun(...input);
  }

  readEvalRunProgress(
    ...input: Parameters<ConnectorEvals["readEvalRunProgress"]>
  ) {
    return this.evals.readEvalRunProgress(...input);
  }

  protected readonly channels: ConnectorChannels = {
    adapters: [
      this.slack,
      this.email.emailChannel(),
      this.whatsApp.whatsAppChannel(),
    ],
    caseWork: this.slack,
    delivery: this.slack,
  };

  /** State counts of this Actor's machines, for the census (Refactor 15, S5). */
  machineCensus(): Promise<readonly MachineCensus[]> {
    return actorMachineCensus(this.ctx.storage, ACTOR_MACHINES);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { executionBarrier: true });
    this.createSchema();
  }

  protected override async prepareErasure(): Promise<() => Promise<void>> {
    const slots = readWarmActorSlots(this.ctx.storage.sql);
    return this.eraseFormerWarmActorSlots.bind(this, slots);
  }

  protected acceptsActivation(input: ActorActivationRequest): boolean {
    return (
      input.schemaVersion === CONNECTOR_ACTOR_SCHEMA_VERSION &&
      input.identity.objectKind === "connector"
    );
  }

  async advanceActivationSchema(
    input: ActorActivationSchemaAdvance,
  ): Promise<
    import("@purin-labs/kernel/result").Result<
      { readonly kind: "advanced"; readonly stateVersion: number },
      ActorActivationSchemaAdvanceError
    >
  > {
    return this.ctx.storage.transactionSync(
      advanceActorActivationSchema.bind(null, this.ctx.storage.sql, input),
    );
  }

  protected quiesceForExport(expectedFenceToken: ActorFenceToken) {
    return this.quiesceExecution({ expectedFenceToken });
  }

  protected override async prepareExport(): Promise<
    Result<PlacedActorExportSource, ActorExportError>
  > {
    // A drained alarm may have consumed its wakeup while durable work remains.
    const armed = await this.armAlarm();
    if (!armed.ok)
      return {
        ok: false,
        error: { code: "export_write_failed", detail: armed.error.code },
      };
    return { ok: true, value: { referencedR2Keys: [] } };
  }

  async quiesceExecution(input: {
    readonly expectedFenceToken: ActorFenceToken;
  }): Promise<Result<null, ActorExportError>> {
    const closed = closeActorExecutionAdmission(
      this.ctx.storage.sql,
      input.expectedFenceToken,
    );
    if (!closed.ok) return closed;
    if (this.executionQuiescence === null)
      this.executionQuiescence = this.drainExecution();
    const result = await this.executionQuiescence;
    if (!result.ok) this.executionQuiescence = null;
    return result;
  }

  async acceptIngress(raw: unknown): Promise<
    ConnectorResult<{
      readonly kind: "accepted" | "duplicate";
      readonly caseId: string;
    }>
  > {
    return this.acceptAdmittedIngress(this.admitExecution.bind(this), raw);
  }

  async acceptCaseWork(raw: unknown): Promise<
    ConnectorResult<{
      readonly kind: "accepted" | "duplicate";
      readonly eventId: string;
    }>
  > {
    const input = parseConnectorCaseWorkRequest(SLACK_CASE_WORK, raw);
    if (input === null) return invalid("connector_case_work_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const accepted = this.ctx.storage.transactionSync(
      acceptCaseWorkTransaction.bind(null, this.ctx.storage.sql, input),
    );
    if (!accepted.ok) return accepted;
    this.ctx.waitUntil(
      scheduleAcceptedCaseWorkAlarm(
        this.ctx.storage,
        this.alarmDue(),
        input.command.requestId,
      ),
    );
    this.startCaseWorkDrain(scope);
    return accepted;
  }

  /**
   * Decide a verified Slack message here, beside the organisation's records,
   * and accept its Case work in the same call. An error means this Connector
   * is not serving the placement and decided nothing.
   */
  async admitSlackCaseWork(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorSlackIngressOutcome>> {
    const input = parseConnectorSlackIngressRequest(raw);
    if (input === null) return invalid("connector_slack_ingress_invalid");
    // The organisation's records are read from the database this Connector's
    // activation pins while the admission resolves the scope. Their statement
    // reads the regional fence, and the decision uses them only under the
    // admitted scope.
    const pinned = actorExecutionAdmissionOpen(this.ctx.storage.sql)
      ? pinnedActorDatabase(
          this.env,
          this.ctx.storage.sql,
          input.identity.organisationId,
        )
      : null;
    const started =
      pinned === null
        ? null
        : startSlackCaseIngressRead(pinned, input.event, input.route);
    const scope = await this.admitRecoveredIdentity(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const admission = await authorizeSlackCaseIngressAtScope({
      scope,
      event: input.event,
      route: input.route,
      started,
    });
    // A placement that froze while the decision waited leaves this Connector
    // serving nothing: the Worker then decides at the current placement.
    if (
      admission.kind === "retry" &&
      (!actorExecutionAdmissionOpen(this.ctx.storage.sql) ||
        !(await scope.isActive()))
    )
      return invalid("connector_placement_conflict");
    if (admission.kind !== "authorized") return { ok: true, value: admission };
    if (admission.value.connectorId !== input.identity.connectorId)
      return invalid("connector_slack_ingress_invalid");
    const command = buildAdmittedSlackCaseCommand({
      requestId: input.requestId,
      receivedAt: input.receivedAt,
      event: input.event,
      ingress: admission.value,
    });
    if (command === null) {
      return {
        ok: true,
        value: { kind: "rejected", reason: "command_not_permitted" },
      };
    }
    // Work is persisted in the boundary parser's form, whichever side admitted
    // it. Claims and receipts compare that form.
    const work = parseConnectorCaseWorkRequest(SLACK_CASE_WORK, {
      identity: input.identity,
      command,
    });
    if (work === null) return invalid("connector_case_work_invalid");
    // Admission waited on regional reads. The local barrier is observed again
    // with no wait before the write.
    if (!actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return invalid("connector_placement_conflict");
    const accepted = this.ctx.storage.transactionSync(
      acceptCaseWorkTransaction.bind(null, this.ctx.storage.sql, work),
    );
    if (!accepted.ok) return accepted;
    this.ctx.waitUntil(
      scheduleAcceptedCaseWorkAlarm(
        this.ctx.storage,
        this.alarmDue(),
        work.command.requestId,
      ),
    );
    this.startCaseWorkDrain(scope);
    return accepted;
  }

  async recoverCaseWork(
    raw: unknown,
  ): Promise<ConnectorResult<{ readonly kind: "scheduled" }>> {
    const input = parseConnectorCaseWorkRecoveryRequest(raw);
    if (input === null) return invalid("connector_case_work_recovery_invalid");
    if ((await this.admitExecution(input.identity)) === null)
      return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    this.ctx.waitUntil(
      scheduleAcceptedCaseWorkAlarm(
        this.ctx.storage,
        this.alarmDue(),
        input.requestId,
      ),
    );
    this.startCaseWorkDrain();
    return { ok: true, value: { kind: "scheduled" } };
  }

  /**
   * Queue the follow-up that the agent scheduled in a running Slack turn of
   * this Connector. It runs at its time as Case work, like a message.
   */
  async scheduleSlackFollowUp(
    raw: unknown,
  ): Promise<ConnectorResult<SlackFollowUpAcceptance>> {
    const input = parseSlackFollowUpRequest(raw);
    if (input === null) return invalid("connector_follow_up_invalid");
    if ((await this.admitExecution(input.identity)) === null)
      return invalid("connector_placement_conflict");
    const accepted = this.ctx.storage.transactionSync(
      acceptSlackFollowUpTransaction.bind(null, this.ctx.storage.sql, input),
    );
    if (!accepted.ok || accepted.value.kind !== "scheduled") return accepted;
    const armed = await this.armAlarm();
    return armed.ok ? accepted : armed;
  }

  /**
   * Keep the command of a running Slack turn that asks a person for a
   * permission, outside the work queue. A repeated call keeps the first one.
   * It returns the thread and requester of that command.
   */
  async parkSlackPermission(
    raw: unknown,
  ): Promise<ConnectorResult<SlackPermissionParked>> {
    const input = parseSlackPermissionParkRequest(raw);
    if (input === null) return invalid("connector_permission_invalid");
    if ((await this.admitExecution(input.identity)) === null)
      return invalid("connector_placement_conflict");
    const parked = this.ctx.storage.transactionSync(
      parkSlackPermissionTransaction.bind(
        null,
        this.ctx.storage.sql,
        input,
        Date.now(),
      ),
    );
    if (!parked.ok) return parked;
    const command = parked.value.command;
    return {
      ok: true,
      value: {
        caseId: command.target.caseId,
        workspaceId: command.event.workspaceId,
        channelId: command.event.channelId,
        threadTs: command.event.threadTs,
        requesterUserId: command.userId,
      },
    };
  }

  /** Post the request of a parked permission in its thread, one time. */
  async noticeSlackPermission(
    raw: unknown,
  ): Promise<ConnectorResult<{ readonly notice: "posted" | "not_posted" }>> {
    const input = parseSlackPermissionNotice(raw);
    if (input === null) return invalid("connector_permission_invalid");
    if ((await this.admitExecution(input.identity)) === null)
      return invalid("connector_placement_conflict");
    const command = readParkedSlackPermission(
      this.ctx.storage.sql,
      input.requestId,
    );
    if (command === null) return invalid("connector_permission_not_found");
    const notice = await deliverSlackPermissionNotice(
      command,
      input.identity,
      { deliver: this.deliver.bind(this) },
      input.card
        ? permissionNoticeDeliveryId(input.requestId)
        : `delivery_permission_${input.requestId}`,
      input.noticeText,
    );
    return {
      ok: true,
      value: { notice: notice.kind === "completed" ? "posted" : "not_posted" },
    };
  }

  /**
   * Settle a permission request that a person decided. Allow queues the turn
   * that continues the request, due now. Both decisions tell the thread once.
   */
  async releaseSlackPermission(
    raw: unknown,
  ): Promise<ConnectorResult<{ readonly kind: "allowed" | "denied" }>> {
    const input = parseSlackPermissionRelease(raw);
    if (input === null) return invalid("connector_permission_invalid");
    if ((await this.admitExecution(input.identity)) === null)
      return invalid("connector_placement_conflict");
    const released = this.ctx.storage.transactionSync(
      releaseSlackPermissionTransaction.bind(
        null,
        this.ctx.storage.sql,
        input,
        Date.now(),
      ),
    );
    if (!released.ok) return released;
    await deliverSlackPermissionNotice(
      released.value.command,
      input.identity,
      { deliver: this.deliver.bind(this) },
      input.card
        ? permissionDecisionDeliveryId(released.value.kind, input.requestId)
        : `delivery_permission_${released.value.kind}_${input.requestId}`,
      input.noticeText,
    );
    if (released.value.kind === "allowed") {
      const armed = await this.armAlarm();
      if (!armed.ok) return armed;
      this.startCaseWorkDrain();
    }
    return { ok: true, value: { kind: released.value.kind } };
  }

  /**
   * Keep the command of a running Slack turn that proposes a side Case
   * (Plan 74), outside the work queue. A repeated call keeps the first one.
   * It returns the thread and the requester of that command.
   */
  async parkSlackSideCase(
    raw: unknown,
  ): Promise<ConnectorResult<SlackSideCaseParked>> {
    const input = parseSlackSideCaseParkRequest(raw);
    if (input === null) return invalid("connector_side_case_invalid");
    if ((await this.admitExecution(input.identity)) === null)
      return invalid("connector_placement_conflict");
    const parked = this.ctx.storage.transactionSync(
      parkSlackSideCaseTransaction.bind(
        null,
        this.ctx.storage.sql,
        input,
        Date.now(),
      ),
    );
    if (!parked.ok) return parked;
    const command = parked.value;
    return {
      ok: true,
      value: {
        caseId: command.target.caseId,
        workspaceId: command.event.workspaceId,
        channelId: command.event.channelId,
        threadTs: command.event.threadTs,
        requesterPersonId: command.principalId,
      },
    };
  }

  /** Post a parked side Case proposal with its Start button, one time. */
  async postSlackSideCaseProposal(
    raw: unknown,
  ): Promise<ConnectorResult<{ readonly posted: boolean }>> {
    const input = parseSlackSideCaseProposalPost(raw);
    if (input === null) return invalid("connector_side_case_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const posted = await this.trackExecution(
      postSlackSideCaseProposal.bind(
        null,
        {
          env: this.env,
          storage: this.ctx.storage,
          scope,
          identity: input.identity,
        },
        input,
      ),
    );
    return { ok: true, value: { posted } };
  }

  /**
   * Start a side Case for the person who clicked its Start button: a new
   * thread in the proposal's channel, its pin, and its first work.
   */
  async startSlackSideCase(
    raw: unknown,
  ): Promise<ConnectorResult<SlackSideCaseStartOutcome>> {
    const input = parseSlackSideCaseStartRequest(raw);
    if (input === null) return invalid("connector_side_case_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const outcome = await this.slack.startSideCase(
      {
        env: this.env,
        storage: this.ctx.storage,
        scope,
        identity: input.identity,
      },
      input,
    );
    if (outcome.kind === "started") {
      const armed = await this.armAlarm();
      if (!armed.ok) return armed;
      this.startCaseWorkDrain();
    }
    return { ok: true, value: outcome };
  }

  async deliver(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorDeliveryResult>> {
    return this.trackExecution(
      this.deliverAdmittedOutput.bind(
        this,
        this.admitExecution.bind(this),
        null,
        raw,
      ),
    );
  }

  /**
   * Deliver an output that a person approved. A stream that stopped part way
   * opens again first, so the delivery can post the full answer.
   */
  async deliverApprovedOutput(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorDeliveryResult>> {
    const input = parseDeliveryRequest(raw);
    if (input === null) return invalid("connector_delivery_invalid");
    if ((await this.admitExecution(input.identity)) === null)
      return invalid("connector_placement_conflict");
    this.ctx.storage.transactionSync(
      reopenWithheldConnectorSlackDelivery.bind(
        null,
        this.ctx.storage.sql,
        input.delivery,
      ),
    );
    return this.deliver(raw);
  }

  /**
   * A call from the conversation residency Actor. It does no work: the call
   * itself keeps this object in memory between the turns of a conversation.
   */
  async keepResident(): Promise<void> {}

  async inspect(): Promise<ConnectorResult<ConnectorSnapshot>> {
    return inspectConnector(this.ctx.storage.sql);
  }

  async alarm(): Promise<void> {
    await this.trackExecution(this.runAlarm.bind(this));
  }

  async invalidateCaseContextCollectionEvidence(
    input: Readonly<{
      organisationId: string;
      caseContextCollectionId: string;
      caseContextCollectionRevision: number;
      policyRevision: number;
    }>,
  ) {
    const runtime = readEmailRuntime(this.ctx.storage.sql);
    if (runtime === null || runtime.organisationId !== input.organisationId)
      return invalid("case_context_collection_evidence_invalid");
    invalidateEmailCaseContextCollectionProposals(this.ctx.storage.sql, {
      caseContextCollectionId: input.caseContextCollectionId,
      caseContextCollectionRevision: input.caseContextCollectionRevision,
      policyRevision: input.policyRevision,
      now: Date.now(),
    });
    await armAlarmBy(this.ctx.storage, Date.now() + 1_000);
    return { ok: true as const, value: null };
  }
}

declare module "@purin-labs/kernel/env" {
  interface Env {
    CONNECTOR: DurableObjectNamespace<ConnectorDO>;
  }
}
