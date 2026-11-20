import {
  armAlarmAfterFailedSteps,
  runAlarmSteps,
  runAlarmStepsTogether,
} from "../lifecycle/actor-alarm";
import { runtimeFetch } from "../../runtime-fetch";
import {
  createWarmActorSlotSchema,
  eraseWarmActorSlots,
  type WarmActorSlot,
} from "../warm-actor-slots";
import type { ConnectorIdentity } from "@purin-labs/contracts";
import { readWhatsAppIngressPolicy } from "../../data/whatsapp";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "../../ids";
import { traceWarn } from "../../observability";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import {
  actorExecutionAdmissionOpen,
  createActorExecutionBarrierSchema,
  isActorExecutionActive,
  settleActorExecution,
} from "../actor-execution-quiescence";
import {
  createActorActivationSchema,
  admitActorRecovery,
} from "../actor-activation";
import {
  createActorImportSchema,
  readActivationExportSource,
  type ActorExportError,
} from "../actor-export";
import {
  createConnectorCaseWorkSchema,
  renewRunningConnectorCaseWorkLeases,
} from "../connector-case-work";
import type { Result } from "../../result";
import {
  claimDueWhatsAppCase,
  completeWhatsAppProcessing,
  createConnectorWhatsAppSchema,
  expireWhatsAppProposals,
  sweepWhatsAppDeadlines,
  readWhatsAppCase,
  rearmWhatsAppDebounce,
  recordWhatsAppOperatorNotice,
  settleWhatsAppTurn,
  undeliveredWhatsAppNoticeKeys,
  readWhatsAppRuntime,
  type WhatsAppRuntimeSnapshot,
} from "../connector-whatsapp";
import {
  dispatchWhatsAppReplyFor,
  previewWhatsAppProposalFor,
} from "../connector-whatsapp-rpc";
import { processWhatsAppCaseTurn } from "../whatsapp-case-processing";
import { notifyOperator } from "../connector-whatsapp-rpc";
import { fenceAbandonedWhatsAppSends } from "../connector-whatsapp-proposal";
import { createWhatsAppContentCipher } from "../whatsapp-active-content";
import { PlacedActor } from "../lifecycle/placed-actor";
import { armConnectorAlarm } from "./alarm";
import {
  acceptIngress,
  claimDelivery,
  createConnectorSchema,
  finalizeDelivery,
} from "./delivery";
import {
  ignoreUnusedCredentialRoute,
  parseDeliveryRequest,
  parseIngressRequest,
} from "./ingress-parsers";
import { type ConnectorAdmission, invalid } from "./support";
import {
  type ConnectorDeliveryRequest,
  type ConnectorDeliveryResult,
  type ConnectorIngressAcceptance,
  type ConnectorResult,
  WHATSAPP_TURN_RETRY_MS,
} from "./types";
import { ConnectorCaseWorkDrain } from "./case-work-drain";
import type {
  ChannelAdapter,
  ChannelAlarmDue,
  ChannelAlarmStep,
  ConnectorChannelHost,
  ConnectorChannels,
} from "./channel-adapter";

function channelAlarmDue(channel: ChannelAdapter): readonly ChannelAlarmDue[] {
  return channel.alarmDue === undefined ? [] : [channel.alarmDue];
}

/**
 * The Connector actor's state, its alarm and its shared Case work helpers (Refactor 10, step 2.6). The layers above add WhatsApp, evals and email; `ConnectorDO` adds the Slack ingress and delivery RPC methods, and it gives the channels.
 */
export abstract class ConnectorActorBase extends PlacedActor<null> {
  /** The channels of this Connector. `ConnectorDO` gives them. */
  protected abstract readonly channels: ConnectorChannels;

  protected activeCaseWorkDrain: Promise<void> | null = null;

  protected caseWorkDrain: ConnectorCaseWorkDrain | null = null;

  protected readonly executions = new Set<
    Promise<Result<null, ActorExportError>>
  >();

  protected executionQuiescence: Promise<
    Result<null, ActorExportError>
  > | null = null;

  protected createSchema(): void {
    createActorActivationSchema(this.ctx.storage.sql);
    createActorImportSchema(this.ctx.storage.sql);
    createActorExecutionBarrierSchema(this.ctx.storage.sql);
    createConnectorSchema(this.ctx.storage.sql);
    this.ctx.storage.transactionSync(
      createConnectorCaseWorkSchema.bind(null, this.ctx.storage.sql),
    );
    for (const channel of this.channels.adapters)
      channel.createSchema(this.ctx.storage);
    createConnectorWhatsAppSchema(
      this.ctx.storage.sql,
      this.ctx.storage.transactionSync.bind(this.ctx.storage),
    );
    createWarmActorSlotSchema(this.ctx.storage.sql);
  }

  /**
   * Empties the warm slots this Connector held before its own storage was
   * emptied. The residency Actor calls no slot of a Connector that the
   * registry does not list as active, so no call starts one again.
   */
  protected async eraseFormerWarmActorSlots(
    slots: readonly WarmActorSlot[],
  ): Promise<void> {
    await eraseWarmActorSlots(this.env, slots);
  }

  protected async drainExecution(): Promise<Result<null, ActorExportError>> {
    const executions = [...this.executions];
    const caseWork = this.activeCaseWorkDrain;
    if (caseWork !== null) {
      const settled = await settleActorExecution(caseWork);
      if (!settled.ok) return settled;
    }
    for (const execution of executions) {
      const settled = await execution;
      if (!settled.ok) return settled;
    }
    return { ok: true, value: null };
  }

  protected async trackExecution<Value>(
    start: () => Promise<Value>,
  ): Promise<Value> {
    const work = start();
    const settlement = settleActorExecution(work);
    this.executions.add(settlement);
    try {
      return await work;
    } finally {
      this.executions.delete(settlement);
    }
  }

  /**
   * Admit one call. The recovery admission reads the regional fence beside the
   * directory, so the scope it returns was active when that read ran. Only the
   * local export barrier can have closed since; it is read again with no wait.
   */
  protected async admitExecution(
    identity: ConnectorIdentity,
  ): Promise<OrganisationExecutionScope | null> {
    const scope = await this.admitRecoveredIdentity(identity);
    return scope !== null && actorExecutionAdmissionOpen(this.ctx.storage.sql)
      ? scope
      : null;
  }

  /** The scope when it is active and this Connector is the named one. */
  protected async admitAtScope(
    scope: OrganisationExecutionScope,
    identity: ConnectorIdentity,
  ): Promise<OrganisationExecutionScope | null> {
    const activation = readActivationExportSource(this.ctx.storage.sql);
    if (
      !activation.ok ||
      activation.value.identity.objectKind !== "connector" ||
      activation.value.identity.organisationId !== identity.organisationId ||
      activation.value.identity.logicalObjectId !== identity.connectorId ||
      scope.organisationId !== identity.organisationId
    )
      return null;
    return (await isActorExecutionActive(this.ctx.storage.sql, scope))
      ? scope
      : null;
  }

  /**
   * Resolve this Connector's execution scope for the named identity. The
   * caller must observe the local barrier, and the regional fence after any
   * further read, immediately before any effect.
   */
  protected async admitRecoveredIdentity(
    identity: ConnectorIdentity,
  ): Promise<OrganisationExecutionScope | null> {
    if (!actorExecutionAdmissionOpen(this.ctx.storage.sql)) return null;
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (admission.kind !== "admitted") return null;
    const activation = readActivationExportSource(this.ctx.storage.sql);
    if (
      !activation.ok ||
      activation.value.identity.objectKind !== "connector" ||
      activation.value.identity.organisationId !== identity.organisationId ||
      activation.value.identity.logicalObjectId !== identity.connectorId
    )
      return null;
    return admission.scope;
  }

  protected acceptIngressAtScope(
    scope: OrganisationExecutionScope,
    raw: unknown,
  ): Promise<ConnectorIngressAcceptance> {
    return this.acceptAdmittedIngress(this.admitAtScope.bind(this, scope), raw);
  }

  protected async acceptAdmittedIngress(
    admit: ConnectorAdmission,
    raw: unknown,
  ): Promise<ConnectorIngressAcceptance> {
    const input = parseIngressRequest(raw);
    if (input === null) return invalid("connector_ingress_invalid");
    if ((await admit(input.identity)) === null)
      return invalid("connector_placement_conflict");
    return this.ctx.storage.transactionSync(
      acceptIngress.bind(null, this.ctx.storage.sql, input),
    );
  }

  protected deliverAtScope(
    scope: OrganisationExecutionScope,
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorDeliveryResult>> {
    return this.trackExecution(
      this.deliverAdmittedOutput.bind(
        this,
        this.admitAtScope.bind(this, scope),
        scope,
        raw,
      ),
    );
  }

  /**
   * `heldScope` is the scope the drain holds for this item, or null when the
   * admission resolves the scope.
   */
  protected async deliverAdmittedOutput(
    admit: ConnectorAdmission,
    heldScope: OrganisationExecutionScope | null,
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorDeliveryResult>> {
    const input = parseDeliveryRequest(raw);
    if (input === null) return invalid("connector_delivery_invalid");
    const channel = this.channels.delivery;
    // A read that the send needs, such as the route of a bot credential,
    // decides nothing and reads no fence. Under a held scope it starts beside
    // the admission. The send uses it only for the delivery it was read for.
    // The send's last reads follow the claim, beside the fence read of the
    // send.
    const startedRead =
      heldScope !== null &&
      heldScope.organisationId === input.identity.organisationId
        ? channel.startRead(input)
        : null;
    void startedRead?.catch(ignoreUnusedCredentialRoute);
    const scope = await admit(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const claim = this.ctx.storage.transactionSync(
      claimDelivery.bind(null, this.ctx.storage.sql, input),
    );
    if (!claim.ok) return claim;
    if (claim.value.kind !== "claimed") return { ok: true, value: claim.value };
    const claimedInput: ConnectorDeliveryRequest = {
      identity: input.identity,
      delivery: claim.value.delivery,
      requestedAt: input.requestedAt,
    };
    const delivered = await channel.send(
      claimedInput,
      scope,
      scope === heldScope &&
        JSON.stringify(claimedInput.delivery.address) ===
          JSON.stringify(input.delivery.address)
        ? startedRead
        : null,
    );
    return this.ctx.storage.transactionSync(
      finalizeDelivery.bind(
        null,
        this.ctx.storage.sql,
        claimedInput,
        claim.value.attempt,
        delivered,
        channel,
      ),
    );
  }

  protected async runAlarm(): Promise<void> {
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      !(await isActorExecutionActive(this.ctx.storage.sql, admission.scope))
    )
      return;
    if (this.activeCaseWorkDrain !== null) {
      this.ctx.storage.transactionSync(
        renewRunningConnectorCaseWorkLeases.bind(
          null,
          this.ctx.storage.sql,
          Date.now(),
        ),
      );
    }
    for (const channel of this.channels.adapters)
      await channel.beforeCaseWork?.(admission.scope);
    const active = () =>
      isActorExecutionActive(this.ctx.storage.sql, admission.scope);
    if (!(await active())) return;
    this.startCaseWorkDrain();
    // Each step runs on its own (Refactor 15, S3): a failed step does not
    // stop the others, and the alarm comes back for it after a backoff. A
    // step does nothing once the Actor no longer serves the Organisation.
    const whenActive = (step: ChannelAlarmStep): ChannelAlarmStep => ({
      name: step.name,
      run: async (): Promise<void> => {
        if (await active()) await step.run();
      },
    });
    const together: ChannelAlarmStep[] = [];
    const inOrder: ChannelAlarmStep[] = [];
    for (const channel of this.channels.adapters) {
      const steps = channel.alarmSteps?.(admission.scope);
      if (steps === undefined) continue;
      together.push(...steps.together.map(whenActive));
      inOrder.push(...steps.inOrder.map(whenActive));
    }
    together.push(
      whenActive({
        name: "whatsapp_turns",
        run: () => this.runDueWhatsAppTurns(admission.scope),
      }),
    );
    const failed = [
      ...(await runAlarmStepsTogether("connector", together)),
      ...(await runAlarmSteps("connector", inOrder)),
    ];
    if (!(await active())) return;
    await this.armAlarm();
    await armAlarmAfterFailedSteps(this.ctx.storage, this.alarmRetries, failed);
  }

  /** Runs in a row with a failed alarm step; the backoff grows with it. */
  private readonly alarmRetries = { failures: 0 };

  /**
   * Runs every WhatsApp Case whose burst debounce has gone quiet. Expired
   * proposals are swept first so an approval queue never shows a body that
   * can no longer be sent inside the service window.
   */
  protected async runDueWhatsAppTurns(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    try {
      const now = Date.now();
      // Time-driven cleanup first: a Case whose service window has passed can
      // no longer be replied to, so its envelope and drafts go before any new
      // turn is claimed.
      const swept = this.ctx.storage.transactionSync(
        sweepWhatsAppDeadlines.bind(null, this.ctx.storage.sql, now),
      );
      if (swept.recoveredProcessing) {
        traceWarn("connector.whatsapp_processing_recovered", {
          requestId: newRequestId(),
          reason: "turn_lease_expired",
        });
      }
      const expired = this.ctx.storage.transactionSync(
        expireWhatsAppProposals.bind(null, this.ctx.storage.sql, now),
      );
      // An attempt that stopped with an earlier instance of this Actor ends
      // as `send_indeterminate` and fences the account before any new turn.
      const fenced = this.ctx.storage.transactionSync(
        fenceAbandonedWhatsAppSends.bind(null, this.ctx.storage.sql, now),
      );
      const pendingNoticeKeys = [
        ...fenced,
        ...expired.map((entry) => entry.noticeKey).filter(isPresentNoticeKey),
        ...undeliveredWhatsAppNoticeKeys(this.ctx.storage.sql, now),
      ];
      for (;;) {
        if (!(await isActorExecutionActive(this.ctx.storage.sql, scope))) break;
        const claim = this.ctx.storage.transactionSync(
          claimDueWhatsAppCase.bind(null, this.ctx.storage.sql, Date.now()),
        );
        if (claim.kind === "idle") break;
        const pendingNotice = await this.runWhatsAppCaseTurn(
          scope,
          claim.caseId,
        );
        pendingNoticeKeys.push(...pendingNotice);
        this.ctx.storage.transactionSync(
          completeWhatsAppProcessing.bind(null, this.ctx.storage.sql),
        );
      }
      // Notices are durable and remain retryable. Deliver them only after
      // customer work so a slow Slack destination cannot block a due Case.
      await this.notifyWhatsAppOperator(scope, pendingNoticeKeys, Date.now());
    } catch (error) {
      // A throw leaves the claimed Case with no debounce. Re-arm it inside the
      // same recovery as the processing release, or the admitted message would
      // wait for a customer to send another one.
      const claimed = readWhatsAppRuntime(this.ctx.storage.sql)?.processing;
      this.ctx.storage.transactionSync(() => {
        if (claimed?.kind === "processing") {
          rearmWhatsAppDebounce(this.ctx.storage.sql, {
            caseId: claimed.caseId,
            retryAt: Date.now() + WHATSAPP_TURN_RETRY_MS,
          });
        }
        completeWhatsAppProcessing(this.ctx.storage.sql);
      });
      traceWarn("connector.whatsapp_turn_failed", {
        requestId: newRequestId(),
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  /**
   * Delivers already-recorded operator notices. Notices are durable before
   * delivery, so a failed post stays queued and is retried by the sweep at the
   * top of the alarm rather than lost.
   */
  protected async notifyWhatsAppOperator(
    scope: OrganisationExecutionScope,
    noticeKeys: readonly string[],
    now: number,
  ): Promise<void> {
    if (noticeKeys.length === 0) return;
    const runtime = readWhatsAppRuntime(this.ctx.storage.sql);
    if (runtime === null) return;
    for (const noticeKey of noticeKeys) {
      await notifyOperator(
        { storage: this.ctx.storage, env: this.env, scope },
        runtime,
        noticeKey,
        now,
      );
    }
  }

  protected async runWhatsAppCaseTurn(
    scope: OrganisationExecutionScope,
    caseId: string,
  ): Promise<readonly string[]> {
    const runtime = readWhatsAppRuntime(this.ctx.storage.sql);
    const supportCase = readWhatsAppCase(this.ctx.storage.sql, caseId);
    if (runtime === null || runtime.disabledAt !== null || supportCase === null)
      return [];
    const organisationId = parseOrganisationId(runtime.organisationId);
    const integrationAccountId = parseIntegrationAccountId(
      runtime.integrationAccountId,
    );
    if (!organisationId.ok || !integrationAccountId.ok) {
      return this.rearmWhatsAppCase(
        runtime,
        caseId,
        "whatsapp_cue_policy_identity_invalid",
      );
    }
    const policy = await readWhatsAppIngressPolicy({
      db: scope.database,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      connectedAt: Date.now(),
    });
    if (
      policy.kind !== "enabled" ||
      policy.policyVersion !== runtime.policyVersion
    ) {
      return this.rearmWhatsAppCase(
        runtime,
        caseId,
        "whatsapp_cue_policy_unavailable",
      );
    }
    const account = await scope.database
      .prepare(
        `SELECT display_phone_number AS displayPhoneNumber
         FROM whatsapp_phone_number_account
        WHERE integration_account_id = ? AND organisation_id = ?`,
      )
      .bind(runtime.integrationAccountId, runtime.organisationId)
      .first<{ readonly displayPhoneNumber: string }>();
    if (account === null) return [];
    const cipher = await createWhatsAppContentCipher({
      root: this.env.DATA_ENCRYPTION_ROOT,
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
    });
    if (!cipher.ok) return [];
    const turn = await processWhatsAppCaseTurn(this.env, {
      scope,
      connectorSql: this.ctx.storage.sql,
      cipher: cipher.value,
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
      caseId,
      customerWaId: supportCase.customerWaId,
      businessDisplayPhoneNumber: account.displayPhoneNumber,
      supportBindingId: runtime.supportBindingId,
      bindingRevision: runtime.bindingRevision,
      policyVersion: runtime.policyVersion,
      cuePolicy: {
        relevantMessageTopics: policy.relevantMessageTopics,
        automaticAcknowledgementText: policy.automaticAcknowledgementText,
        agentMode: policy.agentMode,
        alwaysWaitTopics: policy.alwaysWaitTopics,
      },
      limits: runtime.limits,
      credentialGeneration: runtime.credentialGeneration,
      serviceWindowExpiresAt: supportCase.serviceWindowExpiresAt,
      now: Date.now(),
    });
    if (!turn.ok) {
      traceWarn("connector.whatsapp_turn_failed", {
        requestId: newRequestId(),
        reason: turn.error.code,
      });
      return this.rearmWhatsAppCase(runtime, caseId, turn.error.code);
    }
    if (turn.value.kind === "skipped" && turn.value.pendingNoticeKey !== null) {
      return [turn.value.pendingNoticeKey];
    }
    if (turn.value.kind === "skipped") {
      // `service_window_closing` is terminal — the reply could not be sent in
      // time and retrying cannot change that. Everything else is transient.
      return turn.value.reason === "service_window_closing"
        ? []
        : this.rearmWhatsAppCase(runtime, caseId, turn.value.reason);
    }
    // Plan 83: a held reply waits for a person. The Inbox shows it.
    if (turn.value.kind === "proposed" && !turn.value.hold) {
      return this.sendAutomaticWhatsAppProposal(
        scope,
        runtime,
        caseId,
        turn.value,
      );
    }
    this.ctx.storage.transactionSync(
      settleWhatsAppTurn.bind(null, this.ctx.storage.sql, caseId),
    );
    return [];
  }

  protected async sendAutomaticWhatsAppProposal(
    scope: OrganisationExecutionScope,
    runtime: WhatsAppRuntimeSnapshot,
    caseId: string,
    proposal: Readonly<{ proposalId: string; version: number }>,
  ): Promise<readonly string[]> {
    const now = Date.now();
    const preview = await previewWhatsAppProposalFor(
      { storage: this.ctx.storage, env: this.env, scope },
      proposal.proposalId,
      now,
    );
    if (!preview.ok || preview.value.kind !== "current") {
      return this.rearmWhatsAppCase(
        runtime,
        caseId,
        preview.ok
          ? `whatsapp_automatic_send_${preview.value.kind}`
          : preview.error.code,
      );
    }
    const sent = await dispatchWhatsAppReplyFor(
      {
        storage: this.ctx.storage,
        env: this.env,
        scope,
        origin: { kind: "automatic" },
        armAlarm: this.armAlarm.bind(this),
      },
      {
        proposalId: proposal.proposalId,
        approvedVersion: proposal.version,
        approvedBodyDigest: preview.value.preview.bodyDigest,
        approvedBy: "system:whatsapp_cue_engine",
        now,
        fetcher: runtimeFetch,
      },
    );
    if (!sent.ok)
      return this.rearmWhatsAppCase(runtime, caseId, sent.error.code);
    if (
      sent.value.kind === "sent" ||
      sent.value.kind === "send_indeterminate"
    ) {
      this.ctx.storage.transactionSync(
        settleWhatsAppTurn.bind(null, this.ctx.storage.sql, caseId),
      );
      return [];
    }
    if (
      sent.value.kind === "expired" ||
      sent.value.kind === "service_window_closed"
    ) {
      return [];
    }
    return this.rearmWhatsAppCase(
      runtime,
      caseId,
      `whatsapp_automatic_send_${sent.value.kind}`,
    );
  }

  /**
   * Puts a Case back on the clock after a turn that produced no outcome, and
   * escalates to an operator once the bounded retries are spent.
   */
  protected rearmWhatsAppCase(
    runtime: WhatsAppRuntimeSnapshot,
    caseId: string,
    reason: string,
  ): readonly string[] {
    const rearmed = this.ctx.storage.transactionSync(() =>
      rearmWhatsAppDebounce(this.ctx.storage.sql, {
        caseId,
        retryAt: Date.now() + WHATSAPP_TURN_RETRY_MS,
      }),
    );
    if (rearmed.kind !== "exhausted") return [];
    traceWarn("connector.whatsapp_turn_exhausted", {
      requestId: newRequestId(),
      reason,
    });
    const noticeKey = this.ctx.storage.transactionSync(() =>
      recordWhatsAppOperatorNotice(this.ctx.storage.sql, {
        reason: {
          kind: "service_window_expired",
          caseId,
          expiredAt: Date.now(),
        },
        policyVersion: runtime.policyVersion,
        now: Date.now(),
      }),
    );
    return noticeKey === null ? [] : [noticeKey];
  }

  /**
   * Hand accepted work to the drain, starting one unless one runs. A call that
   * was admitted, read the regional fence and has not waited since may hand its
   * scope over; its work is then claimed at once. Without one the drain admits
   * itself.
   */
  protected startCaseWorkDrain(
    admitted: OrganisationExecutionScope | null = null,
  ): void {
    if (!actorExecutionAdmissionOpen(this.ctx.storage.sql)) return;
    if (this.caseWorkDrain !== null && this.caseWorkDrain.accept(admitted))
      return;
    const drain = new ConnectorCaseWorkDrain({
      storage: this.ctx.storage,
      env: this.env,
      channel: this.channels.caseWork,
      alarmDue: this.alarmDue(),
    });
    this.caseWorkDrain = drain;
    this.activeCaseWorkDrain = this.runCaseWorkDrain(drain, admitted);
    this.ctx.waitUntil(this.activeCaseWorkDrain);
  }

  /** The due times of the alarm work of each channel. */
  protected alarmDue(): readonly ChannelAlarmDue[] {
    return this.channels.adapters.flatMap(channelAlarmDue);
  }

  /** Sets the alarm to the earliest due work of the Connector. */
  protected armAlarm(): Promise<ConnectorResult<null>> {
    return armConnectorAlarm(this.ctx.storage, this.alarmDue());
  }

  /** What this Connector gives to a channel. */
  protected channelHost(): ConnectorChannelHost {
    return {
      storage: this.ctx.storage,
      env: this.env,
      trackExecution: this.trackExecution.bind(this),
      admitAtScope: this.admitAtScope.bind(this),
      acceptIngressAtScope: this.acceptIngressAtScope.bind(this),
      deliverAtScope: this.deliverAtScope.bind(this),
      wakeCaseWorkDrain: this.wakeCaseWorkDrain.bind(this),
    };
  }

  /** A reply that waits for its Case may steer the Case's turn now. */
  protected wakeCaseWorkDrain(): void {
    this.caseWorkDrain?.accept(null);
  }

  protected async runCaseWorkDrain(
    drain: ConnectorCaseWorkDrain,
    admitted: OrganisationExecutionScope | null,
  ): Promise<void> {
    try {
      await drain.run(admitted);
    } finally {
      if (this.caseWorkDrain === drain) {
        this.caseWorkDrain = null;
        this.activeCaseWorkDrain = null;
      }
    }
  }
}

function isPresentNoticeKey(value: string | null): value is string {
  return value !== null;
}
