import { runtimeFetch } from "../../runtime-fetch";
import { isActorExecutionActive } from "../actor-execution-quiescence";
import { admitActorRecovery } from "../actor-activation";
import { readWhatsAppIngressPolicy } from "../../data/whatsapp";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "../../ids";
import { traceWarn } from "../../observability";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
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
import type { ChannelAdapter, ChannelAlarmSteps } from "./channel-adapter";
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
import { ensureConnectorIdentity } from "./ingress-parsers";
import { invalid } from "./support";
import { type ConnectorResult } from "./types";
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
import { ConnectorEvals } from "./connector-evals";

/** How long a Case waits before a turn that produced no outcome is retried. */
const WHATSAPP_TURN_RETRY_MS = 60_000;

/**
 * WhatsApp runtime, turns, proposals and human replies for the Connector.
 */
export abstract class ConnectorWhatsApp extends ConnectorEvals {
  /**
   * Durable admission for one parsed WhatsApp webhook event. The Worker only
   * acknowledges Meta after this returns, so a failure here becomes a Meta
   * retry rather than a lost customer message.
   */
  async acceptWhatsAppEvent(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppAdmissionResult>> {
    return this.trackExecution(
      this.acceptAdmittedWhatsAppEvent.bind(this, raw),
    );
  }

  protected async acceptAdmittedWhatsAppEvent(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppAdmissionResult>> {
    const input = parseWhatsAppEventRequest(raw);
    if (input === null) return invalid("connector_whatsapp_event_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const accepted = await acceptWhatsAppEvent(
      { storage: this.ctx.storage, env: this.env, scope },
      input.event,
      input.now,
    );
    if (!accepted.ok) return invalid(accepted.error.code);
    const armed = await this.armAlarm();
    if (!armed.ok) return invalid(armed.error.code);
    return accepted;
  }

  async activateWhatsAppProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppRuntimeSnapshot>> {
    const input = parseWhatsAppActivationRequest(raw);
    if (input === null) return invalid("connector_whatsapp_activation_invalid");
    const activated = this.ctx.storage.transactionSync(() => {
      const identity = ensureConnectorIdentity(
        this.ctx.storage.sql,
        input.identity,
      );
      if (!identity.ok) return identity;
      const current = readWhatsAppRuntime(this.ctx.storage.sql);
      return current !== null && current.disabledAt === null
        ? updateWhatsAppRuntimePolicy(this.ctx.storage.sql, input)
        : activateWhatsAppRuntime(this.ctx.storage.sql, {
            ...input,
            organisationId: input.identity.organisationId,
            integrationAccountId: input.integrationAccountId,
          });
    });
    if (!activated.ok) return invalid(activated.error.code);
    this.ctx.waitUntil(this.armAlarm());
    return activated;
  }

  async disableWhatsAppProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<null>> {
    const input = parseWhatsAppIdentityRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const disabled = this.ctx.storage.transactionSync(() => {
      const identity = ensureConnectorIdentity(
        this.ctx.storage.sql,
        input.identity,
      );
      if (!identity.ok) return identity;
      return disableWhatsAppRuntime(this.ctx.storage.sql, { now: input.now });
    });
    if (!disabled.ok) return invalid(disabled.error.code);
    this.ctx.waitUntil(this.armAlarm());
    return { ok: true, value: null };
  }

  async resumeWhatsAppProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppRuntimeSnapshot>> {
    const input = parseWhatsAppResumeRequest(raw);
    if (input === null) return invalid("connector_whatsapp_resume_invalid");
    const resumed = this.ctx.storage.transactionSync(() => {
      const identity = ensureConnectorIdentity(
        this.ctx.storage.sql,
        input.identity,
      );
      if (!identity.ok) return identity;
      return resumeWhatsAppRuntime(this.ctx.storage.sql, input);
    });
    if (!resumed.ok) return invalid(resumed.error.code);
    this.ctx.waitUntil(this.armAlarm());
    return resumed;
  }

  async inspectWhatsAppRuntime(): Promise<
    ConnectorResult<WhatsAppRuntimeStatus | null>
  > {
    const now = Date.now();
    const dueAt = nextWhatsAppSweepAt(this.ctx.storage.sql);
    if (dueAt !== null && dueAt <= now) {
      this.ctx.waitUntil(this.recoverOverdueWhatsAppWork());
    } else {
      this.ctx.waitUntil(this.armAlarm());
    }
    return {
      ok: true,
      value: inspectWhatsAppRuntime(
        { storage: this.ctx.storage, env: this.env },
        now,
      ),
    };
  }

  protected async recoverOverdueWhatsAppWork(): Promise<void> {
    await this.trackExecution(this.runOverdueWhatsAppWork.bind(this));
  }

  protected async runOverdueWhatsAppWork(): Promise<void> {
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      !(await isActorExecutionActive(this.ctx.storage.sql, admission.scope))
    )
      return;
    await this.runDueWhatsAppTurns(admission.scope);
    await this.armAlarm();
  }

  async readWhatsAppConversationHeads(
    raw: unknown,
  ): Promise<ConnectorResult<readonly WhatsAppConversationHead[]>> {
    return this.trackExecution(
      this.readAdmittedWhatsAppConversationHeads.bind(this, raw),
    );
  }

  protected async readAdmittedWhatsAppConversationHeads(
    raw: unknown,
  ): Promise<ConnectorResult<readonly WhatsAppConversationHead[]>> {
    const input = parseWhatsAppConversationHeadsRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const heads = await readWhatsAppConversationHeads(
      { storage: this.ctx.storage, env: this.env, scope },
      input.caseIds,
    );
    return heads.ok ? heads : invalid(heads.error.code);
  }

  async readWhatsAppCasePanel(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppCasePanel>> {
    return this.trackExecution(
      this.readAdmittedWhatsAppCasePanel.bind(this, raw),
    );
  }

  protected async readAdmittedWhatsAppCasePanel(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppCasePanel>> {
    const input = parseWhatsAppCaseRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const panel = await readWhatsAppCasePanel(
      { storage: this.ctx.storage, env: this.env, scope },
      input.caseId,
    );
    return panel.ok ? panel : invalid(panel.error.code);
  }

  async previewWhatsAppProposal(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppProposalPreviewOutcome>> {
    return this.trackExecution(
      this.previewAdmittedWhatsAppProposal.bind(this, raw),
    );
  }

  protected async previewAdmittedWhatsAppProposal(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppProposalPreviewOutcome>> {
    const input = parseWhatsAppProposalRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const preview = await previewWhatsAppProposalFor(
      { storage: this.ctx.storage, env: this.env, scope },
      input.proposalId,
      input.now,
    );
    return preview.ok ? preview : invalid(preview.error.code);
  }

  async editWhatsAppProposal(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppProposalEditResult>> {
    return this.trackExecution(
      this.editWhatsAppProposalAdmitted.bind(this, raw),
    );
  }

  protected async editWhatsAppProposalAdmitted(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppProposalEditResult>> {
    const input = parseWhatsAppEditRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const edited = await editWhatsAppProposalFor(
      { storage: this.ctx.storage, env: this.env, scope, origin: input.origin },
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
    return this.trackExecution(
      this.dispatchAdmittedWhatsAppReply.bind(this, raw),
    );
  }

  protected async dispatchAdmittedWhatsAppReply(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppDispatchOutcome>> {
    const input = parseWhatsAppDispatchRequest(raw);
    if (input === null) return invalid("connector_whatsapp_dispatch_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const dispatched = await dispatchWhatsAppReplyFor(
      {
        storage: this.ctx.storage,
        env: this.env,
        scope,
        origin: input.origin,
        armAlarm: this.armAlarm.bind(this),
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
    this.ctx.waitUntil(this.armAlarm());
    return dispatched;
  }

  async disposeWhatsAppProposal(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppDisposalResult>> {
    const input = parseWhatsAppDisposalRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const disposed = await disposeWhatsAppProposalFor(
      { storage: this.ctx.storage, env: this.env, scope },
      input,
    );
    return disposed.ok ? disposed : invalid(disposed.error.code);
  }

  async resolveWhatsAppIndeterminateSend(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppResolutionResult>> {
    const input = parseWhatsAppResolutionRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const resolved = await resolveWhatsAppIndeterminateFor(
      { storage: this.ctx.storage, env: this.env, scope },
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
    return this.trackExecution(
      this.takeOverWhatsAppCaseAdmitted.bind(this, raw),
    );
  }

  protected async takeOverWhatsAppCaseAdmitted(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppTakeoverResult>> {
    const input = parseWhatsAppTakeoverRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const taken = await takeOverWhatsAppCase(
      { storage: this.ctx.storage, env: this.env, scope, origin: input.origin },
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
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const returned = await returnWhatsAppCaseToAgent(
      { storage: this.ctx.storage, env: this.env, scope },
      { caseId: input.caseId, now: input.now },
    );
    if (!returned.ok) return invalid(returned.error.code);
    this.ctx.waitUntil(this.recoverOverdueWhatsAppWork());
    return returned;
  }

  async composeWhatsAppHumanReply(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppHumanReplyResult>> {
    return this.trackExecution(
      this.composeWhatsAppHumanReplyAdmitted.bind(this, raw),
    );
  }

  protected async composeWhatsAppHumanReplyAdmitted(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppHumanReplyResult>> {
    const input = parseWhatsAppHumanReplyRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const composed = await composeWhatsAppHumanReplyFor(
      { storage: this.ctx.storage, env: this.env, scope, origin: input.origin },
      input,
    );
    return composed.ok ? composed : invalid(composed.error.code);
  }

  async closeWhatsAppCase(
    raw: unknown,
  ): Promise<ConnectorResult<WhatsAppCloseResult>> {
    const input = parseWhatsAppCaseRequest(raw);
    if (input === null) return invalid("connector_whatsapp_request_invalid");
    const scope = await this.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok) return identity;
    const closed = await closeWhatsAppSupportCase(
      { storage: this.ctx.storage, env: this.env, scope },
      { caseId: input.caseId, now: input.now },
    );
    if (!closed.ok) return invalid(closed.error.code);
    this.ctx.waitUntil(this.armAlarm());
    return closed;
  }

  /** WhatsApp as a channel of the Connector: its tables and its alarm part. */
  protected whatsAppChannel(): ChannelAdapter {
    return {
      name: "whatsapp",
      createSchema: createWhatsAppChannelSchema,
      alarmDue: whatsAppAlarmDue,
      alarmSteps: this.whatsAppAlarmSteps.bind(this),
    };
  }

  protected whatsAppAlarmSteps(
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
}

function isPresentNoticeKey(value: string | null): value is string {
  return value !== null;
}
