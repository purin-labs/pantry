import { runtimeFetch } from "../../runtime-fetch";
import { isActorExecutionActive } from "../actor-execution-quiescence";
import { admitActorRecovery } from "../actor-activation";
import {
  activateWhatsAppRuntime,
  disableWhatsAppRuntime,
  nextWhatsAppSweepAt,
  readWhatsAppRuntime,
  resumeWhatsAppRuntime,
  updateWhatsAppRuntimePolicy,
  type WhatsAppRuntimeSnapshot,
} from "../connector-whatsapp";
import {
  acceptWhatsAppEvent,
  closeWhatsAppSupportCase,
  composeWhatsAppHumanReplyFor,
  dispatchWhatsAppReplyFor,
  disposeWhatsAppProposalFor,
  editWhatsAppProposalFor,
  inspectWhatsAppRuntime,
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
import { armConnectorAlarm } from "./alarm";
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
import { ConnectorActorBase } from "./connector-actor-base";

/**
 * WhatsApp runtime, turns, proposals and human replies for the Connector.
 */
export abstract class ConnectorWhatsApp extends ConnectorActorBase {
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
    const armed = await armConnectorAlarm(this.ctx.storage);
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
    this.ctx.waitUntil(armConnectorAlarm(this.ctx.storage));
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
    this.ctx.waitUntil(armConnectorAlarm(this.ctx.storage));
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
    this.ctx.waitUntil(armConnectorAlarm(this.ctx.storage));
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
      this.ctx.waitUntil(armConnectorAlarm(this.ctx.storage));
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
    await armConnectorAlarm(this.ctx.storage);
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
      { storage: this.ctx.storage, env: this.env, scope, origin: input.origin },
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
    this.ctx.waitUntil(armConnectorAlarm(this.ctx.storage));
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
    this.ctx.waitUntil(armConnectorAlarm(this.ctx.storage));
    return closed;
  }
}
