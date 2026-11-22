import { admitNamedConnector } from "@purin-labs/conversation/actors/connector/module-admission";
import type { ConnectorModuleHost } from "@purin-labs/conversation/actors/connector/channel-adapter";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { isActorExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { admitActorRecovery } from "@purin-labs/actor-runtime/actors/actor-activation";
import { readWhatsAppIngressPolicy } from "../../data/whatsapp";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  activateWhatsAppRuntime,
  claimDueWhatsAppCase,
  completeWhatsAppProcessing,
  createWhatsAppChannelSchema,
  disableWhatsAppRuntime,
  expireWhatsAppProposals,
  nextWhatsAppSweepAt,
  readWhatsAppCase,
  readWhatsAppRuntime,
  rearmWhatsAppDebounce,
  recordWhatsAppOperatorNotice,
  resumeWhatsAppRuntime,
  settleWhatsAppTurn,
  sweepWhatsAppDeadlines,
  undeliveredWhatsAppNoticeKeys,
  updateWhatsAppRuntimePolicy,
  whatsAppAlarmDue,
  type WhatsAppRuntimeSnapshot,
} from "../connector-whatsapp";
import { processWhatsAppCaseTurn } from "../whatsapp-case-processing";
import { createWhatsAppContentCipher } from "../whatsapp-active-content";
import { fenceAbandonedWhatsAppSends } from "../connector-whatsapp-proposal";
import type {
  ChannelAdapter,
  ChannelAlarmSteps,
} from "@purin-labs/conversation/actors/connector/channel-adapter";
import {
  acceptWhatsAppEvent,
  closeWhatsAppSupportCase,
  composeWhatsAppHumanReplyFor,
  dispatchWhatsAppReplyFor,
  disposeWhatsAppProposalFor,
  editWhatsAppProposalFor,
  inspectWhatsAppRuntime,
  notifyOperator,
  previewWhatsAppProposalFor,
  readWhatsAppCasePanel,
  readWhatsAppConversationHeads,
  type WhatsAppConversationHead,
  resolveWhatsAppIndeterminateFor,
  returnWhatsAppCaseToAgent,
  takeOverWhatsAppCase,
  type WhatsAppAdmissionResult,
  type WhatsAppCasePanel,
  type WhatsAppCloseResult,
  type WhatsAppDisposalResult,
  type WhatsAppHumanReplyResult,
  type WhatsAppProposalEditResult,
  type WhatsAppResolutionResult,
  type WhatsAppReturnResult,
  type WhatsAppRuntimeStatus,
  type WhatsAppTakeoverResult,
} from "../connector-whatsapp-rpc";
import type {
  WhatsAppDispatchOutcome,
  WhatsAppProposalPreviewOutcome,
} from "../connector-whatsapp-proposal";
import { ensureConnectorIdentity } from "@purin-labs/conversation/actors/connector/ingress-parsers";
import { invalid } from "@purin-labs/conversation/actors/connector/support";
import { type ConnectorResult } from "@purin-labs/conversation/actors/connector/types";
import {
  parseWhatsAppActivationRequest,
  parseWhatsAppCaseRequest,
  parseWhatsAppConversationHeadsRequest,
  parseWhatsAppDispatchRequest,
  parseWhatsAppDisposalRequest,
  parseWhatsAppEditRequest,
  parseWhatsAppEventRequest,
  parseWhatsAppHumanReplyRequest,
  parseWhatsAppIdentityRequest,
  parseWhatsAppProposalRequest,
  parseWhatsAppResolutionRequest,
  parseWhatsAppResumeRequest,
  parseWhatsAppTakeoverRequest,
} from "./whatsapp-parsers";

/** How long a Case waits before a turn that produced no outcome is retried. */
const WHATSAPP_TURN_RETRY_MS = 60_000;

/**
 * WhatsApp runtime, turns, proposals and human replies for the Connector.
 */
export class ConnectorWhatsApp {
  constructor(private readonly host: ConnectorModuleHost) {}

  /**
   * Durable admission for one parsed WhatsApp webhook event. The Worker only
   * acknowledges Meta after this returns, so a failure here becomes a Meta
   * retry rather than a lost customer message.
   */
  async acceptWhatsAppEvent(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppAdmissionResult>> {
    return this.host.trackExecution(
      this.acceptAdmittedWhatsAppEvent.bind(this, raw),
    );
  }

  private async acceptAdmittedWhatsAppEvent(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppAdmissionResult>> {
    const input = parseWhatsAppEventRequest(raw);
    if (input === null) return invalid("connector_whatsapp_event_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const accepted = await acceptWhatsAppEvent(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
      input.event,
      input.now,
    );
    if (!accepted.ok) return invalid(accepted.error.code);
    const armed = await this.host.armAlarm();
    if (!armed.ok) return invalid(armed.error.code);
    return accepted;
  }

  async activateWhatsAppProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppRuntimeSnapshot>> {
    const input = parseWhatsAppActivationRequest(raw);
    if (input === null) return invalid("connector_whatsapp_activation_invalid");
    const activated = this.host.ctx.storage.transactionSync(() => {
      const identity = ensureConnectorIdentity(
        this.host.ctx.storage.sql,
        input.identity,
      );
      if (!identity.ok) return identity;
      const current = readWhatsAppRuntime(this.host.ctx.storage.sql);
      return current !== null && current.disabledAt === null
        ? updateWhatsAppRuntimePolicy(this.host.ctx.storage.sql, input)
        : activateWhatsAppRuntime(this.host.ctx.storage.sql, {
            ...input,
            organisationId: input.identity.organisationId,
            integrationAccountId: input.integrationAccountId,
          });
    });
    if (!activated.ok) return invalid(activated.error.code);
    this.host.ctx.waitUntil(this.host.armAlarm());
    return activated;
  }

  async disableWhatsAppProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<null>> {
    const input = parseWhatsAppIdentityRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const disabled = this.host.ctx.storage.transactionSync(() => {
      const identity = ensureConnectorIdentity(
        this.host.ctx.storage.sql,
        input.identity,
      );
      if (!identity.ok) return identity;
      return disableWhatsAppRuntime(this.host.ctx.storage.sql, {
        now: input.now,
      });
    });
    if (!disabled.ok) return invalid(disabled.error.code);
    this.host.ctx.waitUntil(this.host.armAlarm());
    return { ok: true, value: null };
  }

  async resumeWhatsAppProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppRuntimeSnapshot>> {
    const input = parseWhatsAppResumeRequest(raw);
    if (input === null) return invalid("connector_whatsapp_resume_invalid");
    const resumed = this.host.ctx.storage.transactionSync(() => {
      const identity = ensureConnectorIdentity(
        this.host.ctx.storage.sql,
        input.identity,
      );
      if (!identity.ok) return identity;
      return resumeWhatsAppRuntime(this.host.ctx.storage.sql, input);
    });
    if (!resumed.ok) return invalid(resumed.error.code);
    this.host.ctx.waitUntil(this.host.armAlarm());
    return resumed;
  }

  async inspectWhatsAppRuntime(): Promise<
    ConnectorResult<WhatsAppRuntimeStatus | null>
  > {
    const now = Date.now();
    const dueAt = nextWhatsAppSweepAt(this.host.ctx.storage.sql);
    if (dueAt !== null && dueAt <= now) {
      this.host.ctx.waitUntil(this.recoverOverdueWhatsAppWork());
    } else {
      this.host.ctx.waitUntil(this.host.armAlarm());
    }
    return {
      ok: true,
      value: inspectWhatsAppRuntime(
        { storage: this.host.ctx.storage, env: this.host.env },
        now,
      ),
    };
  }

  private async recoverOverdueWhatsAppWork(): Promise<void> {
    await this.host.trackExecution(this.runOverdueWhatsAppWork.bind(this));
  }

  private async runOverdueWhatsAppWork(): Promise<void> {
    const admission = await admitActorRecovery(
      this.host.env,
      this.host.ctx.storage,
    );
    if (
      admission.kind !== "admitted" ||
      !(await isActorExecutionActive(
        this.host.ctx.storage.sql,
        admission.scope,
      ))
    )
      return;
    await this.runDueWhatsAppTurns(admission.scope);
    await this.host.armAlarm();
  }

  async readWhatsAppConversationHeads(
    raw: unknown,
  ): Promise<ConnectorResult<readonly WhatsAppConversationHead[]>> {
    return this.host.trackExecution(
      this.readAdmittedWhatsAppConversationHeads.bind(this, raw),
    );
  }

  private async readAdmittedWhatsAppConversationHeads(
    raw: unknown,
  ): Promise<ConnectorResult<readonly WhatsAppConversationHead[]>> {
    const input = parseWhatsAppConversationHeadsRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const heads = await readWhatsAppConversationHeads(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
      input.caseIds,
    );
    return heads.ok ? heads : invalid(heads.error.code);
  }

  async readWhatsAppCasePanel(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppCasePanel>> {
    return this.host.trackExecution(
      this.readAdmittedWhatsAppCasePanel.bind(this, raw),
    );
  }

  private async readAdmittedWhatsAppCasePanel(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppCasePanel>> {
    const input = parseWhatsAppCaseRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const panel = await readWhatsAppCasePanel(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
      input.caseId,
    );
    return panel.ok ? panel : invalid(panel.error.code);
  }

  async previewWhatsAppProposal(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppProposalPreviewOutcome>> {
    return this.host.trackExecution(
      this.previewAdmittedWhatsAppProposal.bind(this, raw),
    );
  }

  private async previewAdmittedWhatsAppProposal(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppProposalPreviewOutcome>> {
    const input = parseWhatsAppProposalRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const preview = await previewWhatsAppProposalFor(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
      input.proposalId,
      input.now,
    );
    return preview.ok ? preview : invalid(preview.error.code);
  }

  async editWhatsAppProposal(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppProposalEditResult>> {
    return this.host.trackExecution(
      this.editWhatsAppProposalAdmitted.bind(this, raw),
    );
  }

  private async editWhatsAppProposalAdmitted(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppProposalEditResult>> {
    const input = parseWhatsAppEditRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const edited = await editWhatsAppProposalFor(
      {
        storage: this.host.ctx.storage,
        env: this.host.env,
        scope,
        origin: input.origin,
      },
      {
        proposalId: input.proposalId,
        body: input.body,
        maxReplyChars: input.maxReplyChars,
        now: input.now,
      },
    );
    return edited.ok ? edited : invalid(edited.error.code);
  }

  async dispatchWhatsAppReply(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppDispatchOutcome>> {
    return this.host.trackExecution(
      this.dispatchAdmittedWhatsAppReply.bind(this, raw),
    );
  }

  private async dispatchAdmittedWhatsAppReply(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppDispatchOutcome>> {
    const input = parseWhatsAppDispatchRequest(raw);
    if (input === null) return invalid("connector_whatsapp_dispatch_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const dispatched = await dispatchWhatsAppReplyFor(
      {
        storage: this.host.ctx.storage,
        env: this.host.env,
        scope,
        origin: input.origin,
        armAlarm: this.host.armAlarm.bind(this),
      },
      {
        proposalId: input.proposalId,
        approvedVersion: input.approvedVersion,
        approvedBodyDigest: input.approvedBodyDigest,
        approvedBy: input.approvedBy,
        now: input.now,
        fetcher: runtimeFetch,
      },
    );
    if (!dispatched.ok) return invalid(dispatched.error.code);
    this.host.ctx.waitUntil(this.host.armAlarm());
    return dispatched;
  }

  async disposeWhatsAppProposal(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppDisposalResult>> {
    const input = parseWhatsAppDisposalRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const disposed = await disposeWhatsAppProposalFor(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
      input,
    );
    return disposed.ok ? disposed : invalid(disposed.error.code);
  }

  async resolveWhatsAppIndeterminateSend(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppResolutionResult>> {
    const input = parseWhatsAppResolutionRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const resolved = await resolveWhatsAppIndeterminateFor(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
      {
        proposalId: input.proposalId,
        resolution: input.resolution,
        now: input.now,
      },
    );
    return resolved.ok ? resolved : invalid(resolved.error.code);
  }

  async takeOverWhatsAppCase(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppTakeoverResult>> {
    return this.host.trackExecution(
      this.takeOverWhatsAppCaseAdmitted.bind(this, raw),
    );
  }

  private async takeOverWhatsAppCaseAdmitted(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppTakeoverResult>> {
    const input = parseWhatsAppTakeoverRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const taken = await takeOverWhatsAppCase(
      {
        storage: this.host.ctx.storage,
        env: this.host.env,
        scope,
        origin: input.origin,
      },
      {
        caseId: input.caseId,
        operatorUserId: input.operatorUserId,
        now: input.now,
      },
    );
    return taken.ok ? taken : invalid(taken.error.code);
  }

  async returnWhatsAppCaseToAgent(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppReturnResult>> {
    const input = parseWhatsAppCaseRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const returned = await returnWhatsAppCaseToAgent(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
      { caseId: input.caseId, now: input.now },
    );
    if (!returned.ok) return invalid(returned.error.code);
    this.host.ctx.waitUntil(this.recoverOverdueWhatsAppWork());
    return returned;
  }

  async composeWhatsAppHumanReply(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppHumanReplyResult>> {
    return this.host.trackExecution(
      this.composeWhatsAppHumanReplyAdmitted.bind(this, raw),
    );
  }

  private async composeWhatsAppHumanReplyAdmitted(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppHumanReplyResult>> {
    const input = parseWhatsAppHumanReplyRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const composed = await composeWhatsAppHumanReplyFor(
      {
        storage: this.host.ctx.storage,
        env: this.host.env,
        scope,
        origin: input.origin,
      },
      input,
    );
    return composed.ok ? composed : invalid(composed.error.code);
  }

  async closeWhatsAppCase(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppCloseResult>> {
    const input = parseWhatsAppCaseRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const closed = await closeWhatsAppSupportCase(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
      { caseId: input.caseId, now: input.now },
    );
    if (!closed.ok) return invalid(closed.error.code);
    this.host.ctx.waitUntil(this.host.armAlarm());
    return closed;
  }

  /** WhatsApp as a channel of the Connector: its tables and its alarm part. */
  whatsAppChannel(): ChannelAdapter {
    return {
      name: "whatsapp",
      createSchema: createWhatsAppChannelSchema,
      alarmDue: whatsAppAlarmDue,
      alarmSteps: this.whatsAppAlarmSteps.bind(this),
    };
  }

  private whatsAppAlarmSteps(
    scope: OrganisationExecutionScope,
  ): ChannelAlarmSteps {
    return {
      together: [
        { name: "whatsapp_turns", run: () => this.runDueWhatsAppTurns(scope) },
      ],
      inOrder: [],
    };
  }

  /**
   * Runs every WhatsApp Case whose burst debounce has gone quiet. Expired
   * proposals are swept first so an approval queue never shows a body that
   * can no longer be sent inside the service window.
   */
  private async runDueWhatsAppTurns(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    try {
      const now = Date.now();
      // Time-driven cleanup first: a Case whose service window has passed can
      // no longer be replied to, so its envelope and drafts go before any new
      // turn is claimed.
      const swept = this.host.ctx.storage.transactionSync(
        sweepWhatsAppDeadlines.bind(null, this.host.ctx.storage.sql, now),
      );
      if (swept.recoveredProcessing) {
        traceWarn("connector.whatsapp_processing_recovered", {
          requestId: newRequestId(),
          reason: "turn_lease_expired",
        });
      }
      const expired = this.host.ctx.storage.transactionSync(
        expireWhatsAppProposals.bind(null, this.host.ctx.storage.sql, now),
      );
      // An attempt that stopped with an earlier instance of this Actor ends
      // as `send_indeterminate` and fences the account before any new turn.
      const fenced = this.host.ctx.storage.transactionSync(
        fenceAbandonedWhatsAppSends.bind(null, this.host.ctx.storage.sql, now),
      );
      const pendingNoticeKeys = [
        ...fenced,
        ...expired.map((entry) => entry.noticeKey).filter(isPresentNoticeKey),
        ...undeliveredWhatsAppNoticeKeys(this.host.ctx.storage.sql, now),
      ];
      for (;;) {
        if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
          break;
        const claim = this.host.ctx.storage.transactionSync(
          claimDueWhatsAppCase.bind(
            null,
            this.host.ctx.storage.sql,
            Date.now(),
          ),
        );
        if (claim.kind === "idle") break;
        const pendingNotice = await this.runWhatsAppCaseTurn(
          scope,
          claim.caseId,
        );
        pendingNoticeKeys.push(...pendingNotice);
        this.host.ctx.storage.transactionSync(
          completeWhatsAppProcessing.bind(null, this.host.ctx.storage.sql),
        );
      }
      // Notices are durable and remain retryable. Deliver them only after
      // customer work so a slow Slack destination cannot block a due Case.
      await this.notifyWhatsAppOperator(scope, pendingNoticeKeys, Date.now());
    } catch (error) {
      // A throw leaves the claimed Case with no debounce. Re-arm it inside the
      // same recovery as the processing release, or the admitted message would
      // wait for a customer to send another one.
      const claimed = readWhatsAppRuntime(
        this.host.ctx.storage.sql,
      )?.processing;
      this.host.ctx.storage.transactionSync(() => {
        if (claimed?.kind === "processing") {
          rearmWhatsAppDebounce(this.host.ctx.storage.sql, {
            caseId: claimed.caseId,
            retryAt: Date.now() + WHATSAPP_TURN_RETRY_MS,
          });
        }
        completeWhatsAppProcessing(this.host.ctx.storage.sql);
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
  private async notifyWhatsAppOperator(
    scope: OrganisationExecutionScope,
    noticeKeys: readonly string[],
    now: number,
  ): Promise<void> {
    if (noticeKeys.length === 0) return;
    const runtime = readWhatsAppRuntime(this.host.ctx.storage.sql);
    if (runtime === null) return;
    for (const noticeKey of noticeKeys) {
      await notifyOperator(
        { storage: this.host.ctx.storage, env: this.host.env, scope },
        runtime,
        noticeKey,
        now,
      );
    }
  }

  private async runWhatsAppCaseTurn(
    scope: OrganisationExecutionScope,
    caseId: string,
  ): Promise<readonly string[]> {
    const runtime = readWhatsAppRuntime(this.host.ctx.storage.sql);
    const supportCase = readWhatsAppCase(this.host.ctx.storage.sql, caseId);
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
      root: this.host.env.DATA_ENCRYPTION_ROOT,
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
    });
    if (!cipher.ok) return [];
    const turn = await processWhatsAppCaseTurn(this.host.env, {
      scope,
      connectorSql: this.host.ctx.storage.sql,
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
    this.host.ctx.storage.transactionSync(
      settleWhatsAppTurn.bind(null, this.host.ctx.storage.sql, caseId),
    );
    return [];
  }

  private async sendAutomaticWhatsAppProposal(
    scope: OrganisationExecutionScope,
    runtime: WhatsAppRuntimeSnapshot,
    caseId: string,
    proposal: Readonly<{ proposalId: string; version: number }>,
  ): Promise<readonly string[]> {
    const now = Date.now();
    const preview = await previewWhatsAppProposalFor(
      { storage: this.host.ctx.storage, env: this.host.env, scope },
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
        storage: this.host.ctx.storage,
        env: this.host.env,
        scope,
        origin: { kind: "automatic" },
        armAlarm: this.host.armAlarm.bind(this),
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
      this.host.ctx.storage.transactionSync(
        settleWhatsAppTurn.bind(null, this.host.ctx.storage.sql, caseId),
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
  private rearmWhatsAppCase(
    runtime: WhatsAppRuntimeSnapshot,
    caseId: string,
    reason: string,
  ): readonly string[] {
    const rearmed = this.host.ctx.storage.transactionSync(() =>
      rearmWhatsAppDebounce(this.host.ctx.storage.sql, {
        caseId,
        retryAt: Date.now() + WHATSAPP_TURN_RETRY_MS,
      }),
    );
    if (rearmed.kind !== "exhausted") return [];
    traceWarn("connector.whatsapp_turn_exhausted", {
      requestId: newRequestId(),
      reason,
    });
    const noticeKey = this.host.ctx.storage.transactionSync(() =>
      recordWhatsAppOperatorNotice(this.host.ctx.storage.sql, {
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
}

function isPresentNoticeKey(value: string | null): value is string {
  return value !== null;
}

/** The RPC methods of this module. The Actor class has one method for each. */
export type ConnectorWhatsAppRpc = Pick<
  ConnectorWhatsApp,
  | "acceptWhatsAppEvent"
  | "activateWhatsAppProcessing"
  | "disableWhatsAppProcessing"
  | "resumeWhatsAppProcessing"
  | "inspectWhatsAppRuntime"
  | "readWhatsAppConversationHeads"
  | "readWhatsAppCasePanel"
  | "previewWhatsAppProposal"
  | "editWhatsAppProposal"
  | "dispatchWhatsAppReply"
  | "disposeWhatsAppProposal"
  | "resolveWhatsAppIndeterminateSend"
  | "takeOverWhatsAppCase"
  | "returnWhatsAppCaseToAgent"
  | "composeWhatsAppHumanReply"
  | "closeWhatsAppCase"
>;
