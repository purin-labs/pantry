import {
  actorMachineCensus,
  type MachineCensus,
} from "./lifecycle/machine-census";
import { readWarmActorSlots } from "./warm-actor-slots";
import { invalidateEmailCaseContextCollectionProposals } from "./email-case-context-collection-evidence";
import type { Env } from "../env";
import {
  actorExecutionAdmissionOpen,
  closeActorExecutionAdmission,
} from "./actor-execution-quiescence";
import {
  permissionDecisionDeliveryId,
  permissionNoticeDeliveryId,
} from "../slack/permission-request-notice";
import {
  advanceActorActivationSchema,
  pinnedActorDatabase,
  type ActorActivationSchemaAdvance,
  type ActorActivationSchemaAdvanceError,
} from "./actor-activation";
import { type ActorExportError } from "./actor-export";
import type { ActorActivationRequest, ActorFenceToken } from "./actor-registry";
import { CONNECTOR_ACTOR_SCHEMA_VERSION } from "./actor-schema-versions";
import { readEmailRuntime } from "./connector-email";
import {
  parseConnectorCaseWorkRecoveryRequest,
  parseConnectorCaseWorkRequest,
} from "./connector-case-work";
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
import type { Result } from "../result";
import {
  canErasePurgedConnector,
  type PurgedConnectorErasureError,
  type PurgedConnectorErasureRequest,
} from "./organisation-archive-cleanup";
import { type PlacedActorExportSource } from "./lifecycle/placed-actor";
import { armAlarmBy } from "./lifecycle/actor-alarm";
import { armConnectorAlarm } from "./connector/alarm";
import { inspectConnector } from "./connector/delivery";
import type { ConnectorChannels } from "./connector/channel-adapter";
import { SlackConnectorChannel } from "./connector/slack-channel";
import {
  ensureConnectorIdentity,
  holdsConnectorIdentity,
  parseDeliveryRequest,
} from "./connector/ingress-parsers";
import { invalid, scheduleAcceptedCaseWorkAlarm } from "./connector/support";
import {
  type ConnectorDeliveryResult,
  type ConnectorResult,
  type ConnectorSnapshot,
} from "./connector/types";
import { ConnectorEmail } from "./connector/connector-email-actor";

export class ConnectorDO extends ConnectorEmail {
  private readonly slack = new SlackConnectorChannel(this.channelHost());

  protected readonly channels: ConnectorChannels = {
    adapters: [this.slack],
    caseWork: this.slack,
    delivery: this.slack,
  };

  /** State counts of this Actor's machines, for the census (Refactor 15, S5). */
  machineCensus(): Promise<readonly MachineCensus[]> {
    return actorMachineCensus(this.ctx.storage);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { executionBarrier: true });
    this.createSchema();
  }

  protected override async prepareErasure(): Promise<() => Promise<void>> {
    const slots = readWarmActorSlots(this.ctx.storage.sql);
    return this.eraseFormerWarmActorSlots.bind(this, slots);
  }

  /**
   * Empties this Actor for an Organisation whose purge is due or done. The
   * purge empties a Connector through the Connector's own tables; an operator
   * uses this for one whose storage the purge cannot read.
   */
  async erasePurgedOrganisationState(
    request: PurgedConnectorErasureRequest,
  ): Promise<Result<null, PurgedConnectorErasureError>> {
    if (!(await canErasePurgedConnector(this.env, request, Date.now())))
      return { ok: false, error: { code: "organisation_purge_not_due" } };
    if (!holdsConnectorIdentity(this.ctx.storage.sql, request))
      return { ok: false, error: { code: "connector_identity_conflict" } };
    const slots = readWarmActorSlots(this.ctx.storage.sql);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // The instance outlives the erasure, so its tables are created again.
    this.createSchema();
    await this.eraseFormerWarmActorSlots(slots);
    return { ok: true, value: null };
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
    import("../result").Result<
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
    const armed = await armConnectorAlarm(this.ctx.storage);
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
      scheduleAcceptedCaseWorkAlarm(this.ctx.storage, input.command.requestId),
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
      scheduleAcceptedCaseWorkAlarm(this.ctx.storage, work.command.requestId),
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
      scheduleAcceptedCaseWorkAlarm(this.ctx.storage, input.requestId),
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
    const armed = await armConnectorAlarm(this.ctx.storage);
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
      const armed = await armConnectorAlarm(this.ctx.storage);
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
      const armed = await armConnectorAlarm(this.ctx.storage);
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

declare module "../env" {
  interface Env {
    CONNECTOR: DurableObjectNamespace<ConnectorDO>;
  }
}
