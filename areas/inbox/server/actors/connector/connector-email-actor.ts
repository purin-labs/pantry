import { admitNamedConnector } from "@purin-labs/conversation/actors/connector/module-admission";
import type { ConnectorModuleHost } from "@purin-labs/conversation/actors/connector/channel-adapter";
import type { ConnectorEvalWork } from "@purin-labs/area-brain-contract/server/evals/connector-eval-store";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import {
  createContinueSerialQueue,
  createKeyedContinueSerialQueue,
} from "@purin-labs/async-control/serial-queue";
import { runMailOrganization } from "../../mail-inbox/connector-runtime";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import { reconcileFrozenMailReceipt } from "./relocation-mail-receipt";
import type { RelocationMailReceiptRequest } from "@purin-labs/area-inbox-contract/server/relocation-mail-receipt";
import { GMAIL_MAILBOX } from "@purin-labs/connections/mail/gmail-mail-adapter";
import {
  fetchSessionConnectorMail,
  isSessionMailExecutionActive,
} from "../../mail-inbox/execution";
import {
  readEmailProposalFlow,
  validateEmailCaseContextCollectionDependency,
} from "../email-case-context-collection-evidence";
import {
  runMailAssistant,
  readMailAssistantStatus,
  type MailAssistantActorInput,
} from "../../mail-inbox/assistant";
import { eraseMailClassificationRecords } from "../../mail-inbox/store";
import { parseStoredRequestAuthority } from "@purin-labs/authority/request-authority/index";
import { readClassifiedPage, readDecision } from "../../mail-inbox/reads";
import {
  readOrganization,
  manageOrganization,
  type MailOrganizationActorInput,
  type MailOrganizationReadInput,
  type MailClassifiedPageInput,
  type MailDecisionInput,
} from "../../mail-inbox/commands";
import type { MailOrganizationCommand } from "@purin-labs/control-api";
import type { ConnectorIdentity } from "@purin-labs/contracts";
import {
  parseCaseId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import { readAgentMailboxBinding } from "../../data/email-mailbox";
import {
  connectionCredentialAuthority,
  resolveActiveProviderAccountContext,
} from "@purin-labs/connections/data/integration-account";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  actorExecutionAdmissionOpen,
  isActorExecutionActive,
} from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { admitActorRecovery } from "@purin-labs/actor-runtime/actors/actor-activation";
import {
  activateEmailRuntime,
  claimDueEmailCorrectionLearning,
  claimDueEmailReplyTurn,
  completeEmailCorrectionLearning,
  completeEmailReplyTurn,
  dueEmailCaseContextDiscovery,
  retryEmailCorrectionLearning,
  retryEmailReplyTurn,
  wakeEmailReplyTurns,
  type EmailCorrectionLearningWork,
  type EmailReplyTurnWork,
  countEmailAdmissionsSince,
  countEmailThreadsInProgress,
  disableEmailRuntime,
  emailTokenWindowTotals,
  latestEmailDraftOperation,
  nextEmailCorrectionLearningAt,
  nextEmailWatchCleanupAt,
  pendingEmailDraftProposals,
  reconnectEmailRuntime,
  nextEmailEvaluationAt,
  readEmailReplyCorrection,
  readEmailRuntime,
  resumeEmailRuntime,
  updateEmailRuntimePolicy,
  utcDayKey,
  type EmailHintAcceptance,
  type EmailReplyCorrection,
  type EmailRuntimeSnapshot,
} from "../connector-email";
import type {
  ClaimedEvalTask,
  EvalTaskEnd,
  EvalTaskServices,
} from "@purin-labs/area-brain-contract/server/evals/eval-task";
import { runMailboxEvalTask } from "../eval-task-processing";
import {
  establishConnectorEmailWatch,
  readConnectorEmailHistoryId,
  renewConnectorEmailWatch,
  runConnectorEmailEvaluation,
  stopConnectorEmailWatch,
  resolveConnectorGmailAccess,
} from "../connector-email-evaluation";
import {
  processEmailCorrectionLearning,
  processEmailThreadTurn,
} from "../email-case-processing";
import {
  readEmailProposalChatContext,
  readEmailProposalChatSources,
  recordChatEditProvenance,
} from "../email-proposal-sources";
import {
  authorizeEmailReplyReview,
  editEmailReplyBody,
  previewEmailRelationship,
  correctEmailRelationship,
  type EmailRelationshipPreview,
  type EmailReplyEditReceipt,
  dispatchEmailReply,
  disposeEmailProposal,
  previewEmailProposal,
  readCorrectedEmailReply,
  resolveEmailProposalState,
  runEmailProposalMaintenance,
  type EmailDispatchOutcome,
  type EmailDisposalOutcome,
  type EmailProposalPreviewOutcome,
  type EmailProposalResolution,
} from "../connector-email-proposal";
import {
  createOperationalEmailProposal,
  dispatchOperationalEmail,
  editOperationalEmailProposal,
  previewOperationalEmailProposal,
  revokeOperationalEmailProposals,
  type OperationalEmailDispatchOutcome,
  type OperationalEmailProposalOutcome,
  type OperationalEmailProposalRecord,
} from "../connector-email-operational";
import { isRecord } from "@purin-labs/std";
import {
  emailMessageExceedsLimit,
  parseEmailActivationRequest,
  parseEmailChangeRequest,
  parseEmailCheckRequest,
  parseEmailDispatchRequest,
  parseEmailIdentityRequest,
  parseEmailMailboxRevocationRequest,
  parseEmailMailboxSearchRequest,
  parseEmailOperationalAccountRequest,
  parseEmailOperationalDispatchRequest,
  parseEmailOperationalProposalCreateRequest,
  parseEmailOperationalProposalEditRequest,
  parseEmailOperationalProposalRequest,
  parseEmailProposalRequest,
  parseEmailReconnectRequest,
  parseEmailReplyProposalCreateRequest,
  parseEmailResolveRequest,
  parseEmailResumeRequest,
} from "./email-parsers";
import {
  executeOperationalEmailCommand,
  finalizeEmailCaseContextDiscovery,
  maintainOperationalEmail,
  projectOperationalEmailRecord,
  rejectAdmittedOperationalEmail,
  runEmailCaseContextDiscoveryWork,
} from "./email-work";
import {
  acceptConnectorEmailChange,
  createConnectorEmailReplyProposal,
  createEmailChannelSchema,
  emailAlarmDue,
  fenceConnectorEmailMailbox,
  type ConnectorEmailMailboxSearch,
  type ConnectorEmailReplyProposal,
  type EmailMailboxDisposal,
  type EmailMailboxRevocation,
  type EmailRuntimeStatus,
} from "./email";
import type {
  ChannelAdapter,
  ChannelAlarmSteps,
} from "@purin-labs/conversation/actors/connector/channel-adapter";
import { ensureConnectorIdentity } from "@purin-labs/conversation/actors/connector/ingress-parsers";
import { invalid } from "@purin-labs/conversation/actors/connector/support";
import type { ConnectorResult } from "@purin-labs/conversation/actors/connector/types";
import {
  type ConnectorEmailIdentityRequest,
  type EmailReplyProvenance,
} from "./whatsapp-parsers";
import type { Variant } from "@purin-labs/type-utils";

/**
 * Email processing for the Connector: the mailbox, reply turns, operational proposals, correction learning and Case context discovery.
 */
export class ConnectorEmail {
  constructor(
    private readonly host: ConnectorModuleHost,
    private readonly evals: ConnectorEvalWork,
  ) {}

  private activeMailOrganization: Promise<void> | null = null;

  /**
   * One in-flight mutation per proposal. Dispatch, resolve, dispose, and the
   * maintenance sweep all await Gmail mid-flight, and the Workers runtime
   * interleaves requests at those awaits — so two operators approving the
   * same proposal together would otherwise both pass the sent check and both
   * send. Serialising per proposal makes the second caller re-read state the
   * first already wrote and return idempotently.
   */
  private readonly emailProposalWork = createKeyedContinueSerialQueue<string>();

  evalAgentActive(): boolean {
    const runtime = readEmailRuntime(this.host.ctx.storage.sql);
    return runtime !== null && runtime.disabledAt === null;
  }

  runEvalTask(
    scope: OrganisationExecutionScope,
    claim: ClaimedEvalTask,
    evals: EvalTaskServices,
    now: number,
  ): Promise<EvalTaskEnd> {
    return runMailboxEvalTask(
      this.host.env,
      this.host.ctx.storage.sql,
      scope,
      claim,
      evals,
      now,
    );
  }

  /**
   * Names this instance of the Actor on the reply turns it claims. One
   * instance runs at a time, so a claim under another name is from an
   * instance that stopped.
   */
  private readonly emailReplyTurnOwner = crypto.randomUUID();

  private readonly runningEmailReplyTurns = new Set<string>();

  private readonly emailMailboxWork = createContinueSerialQueue();

  async reconcileRelocationMailReceipt(request: RelocationMailReceiptRequest) {
    return reconcileFrozenMailReceipt(
      this.host.env,
      this.host.ctx.storage,
      request,
    );
  }

  async mailAssistant(input: MailAssistantActorInput) {
    return this.host.trackExecution(
      this.runAdmittedMailAssistant.bind(this, input),
    );
  }

  private async runAdmittedMailAssistant(
    input: MailAssistantActorInput,
  ): Promise<
    Awaited<
      ReturnType<typeof runMailAssistant | typeof readMailAssistantStatus>
    >
  > {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid<never>("connector_placement_conflict");
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(
        null,
        this.host.ctx.storage.sql,
        input.identity,
      ),
    );
    if (!identity.ok) return identity;
    const result =
      input.command === null
        ? await readMailAssistantStatus(this.host.env, input)
        : await runMailAssistant(
            { env: this.host.env, storage: this.host.ctx.storage, scope },
            { ...input, command: input.command },
          );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid<never>("connector_placement_conflict");
    return result;
  }

  async readMailOrganization(input: MailOrganizationReadInput) {
    return this.host.trackExecution(
      this.readAdmittedMailOrganization.bind(this, input),
    );
  }

  private async readAdmittedMailOrganization(
    input: MailOrganizationReadInput,
  ): Promise<Awaited<ReturnType<typeof readOrganization>>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid<never>("connector_placement_conflict");
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(
        null,
        this.host.ctx.storage.sql,
        input.identity,
      ),
    );
    if (!identity.ok) return identity;
    return readOrganization(
      { env: this.host.env, storage: this.host.ctx.storage, scope },
      input,
    );
  }

  async readMailClassifiedPage(input: MailClassifiedPageInput) {
    return this.host.trackExecution(
      this.readAdmittedMailClassifiedPage.bind(this, input),
    );
  }

  private async readAdmittedMailClassifiedPage(
    input: MailClassifiedPageInput,
  ): Promise<Awaited<ReturnType<typeof readClassifiedPage>>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid<never>("connector_placement_conflict");
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(
        null,
        this.host.ctx.storage.sql,
        input.identity,
      ),
    );
    if (!identity.ok) return identity;
    return readClassifiedPage(
      { env: this.host.env, storage: this.host.ctx.storage, scope },
      input,
    );
  }

  async readMailDecision(input: MailDecisionInput) {
    return this.host.trackExecution(
      this.readAdmittedMailDecision.bind(this, input),
    );
  }

  private async readAdmittedMailDecision(
    input: MailDecisionInput,
  ): Promise<Awaited<ReturnType<typeof readDecision>>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid<never>("connector_placement_conflict");
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(
        null,
        this.host.ctx.storage.sql,
        input.identity,
      ),
    );
    if (!identity.ok) return identity;
    return readDecision(
      { env: this.host.env, storage: this.host.ctx.storage, scope },
      input,
    );
  }

  async manageMailOrganization(
    input: MailOrganizationActorInput &
      Readonly<{ command: MailOrganizationCommand }>,
  ) {
    return this.host.trackExecution(
      this.manageAdmittedMailOrganization.bind(this, input),
    );
  }

  private async manageAdmittedMailOrganization(
    input: MailOrganizationActorInput &
      Readonly<{ command: MailOrganizationCommand }>,
  ): Promise<Awaited<ReturnType<typeof manageOrganization>>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid<never>("connector_placement_conflict");
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(
        null,
        this.host.ctx.storage.sql,
        input.identity,
      ),
    );
    if (!identity.ok) return identity;
    const result = await manageOrganization(
      { env: this.host.env, storage: this.host.ctx.storage, scope },
      input,
    );
    await this.host.armAlarm();
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid<never>("connector_placement_conflict");
    return result;
  }

  async acceptEmailChange(
    raw: unknown,
  ): Promise<ConnectorResult<EmailHintAcceptance>> {
    return this.host.trackExecution(
      this.acceptAdmittedEmailChange.bind(this, raw),
    );
  }

  private async acceptAdmittedEmailChange(
    raw: unknown,
  ): Promise<ConnectorResult<EmailHintAcceptance>> {
    const input = parseEmailChangeRequest(raw);
    if (input === null) return invalid("connector_email_hint_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const accepted = this.host.ctx.storage.transactionSync(
      acceptConnectorEmailChange.bind(null, this.host.ctx.storage.sql, input),
    );
    if (!accepted.ok) return accepted;
    await this.host.armAlarm();
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return accepted;
  }

  /**
   * Checks Gmail for new mail now. A push can be late, and a local backend
   * gets none. The mailbox's current history id then goes through the same
   * admission as a push, under a notification id that no Pub/Sub id has, so
   * deduplication and the next evaluation's time are the ones a push gets.
   */
  async checkEmailChange(
    raw: unknown,
  ): Promise<ConnectorResult<EmailHintAcceptance>> {
    return this.host.trackExecution(
      this.checkAdmittedEmailChange.bind(this, raw),
    );
  }

  private async checkAdmittedEmailChange(
    raw: unknown,
  ): Promise<ConnectorResult<EmailHintAcceptance>> {
    const input = parseEmailCheckRequest(raw);
    if (input === null) return invalid("connector_email_check_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const runtime = readEmailRuntime(this.host.ctx.storage.sql);
    if (
      runtime === null ||
      runtime.disabledAt !== null ||
      runtime.integrationAccountId !== input.integrationAccountId
    )
      return { ok: true, value: { kind: "inactive" } };
    const historyId = await readConnectorEmailHistoryId({
      env: this.host.env,
      storage: this.host.ctx.storage,
      scope,
      integrationAccountId: runtime.integrationAccountId,
      now: input.now,
      fetcher: runtimeFetch,
    });
    if (!historyId.ok) return invalid(historyId.error.code);
    return this.acceptAdmittedEmailChange({
      identity: input.identity,
      notificationId: `check:${input.checkId}`,
      historyId: historyId.value,
      now: input.now,
    });
  }

  private async trackMailboxExecution<Value>(
    start: () => Promise<Value>,
  ): Promise<Value> {
    return this.host.trackExecution(
      (this.emailMailboxWork.enqueue<Value>).bind(this.emailMailboxWork, start),
    );
  }

  async activateEmailProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<EmailRuntimeSnapshot>> {
    return this.trackMailboxExecution(
      this.activateAdmittedEmailProcessing.bind(this, raw),
    );
  }

  private async activateAdmittedEmailProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<EmailRuntimeSnapshot>> {
    const input = parseEmailActivationRequest(raw);
    if (input === null) return invalid("connector_email_activation_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    return this.activateEmailProcessingWithScope(scope, input);
  }

  private async activateEmailProcessingWithScope(
    scope: OrganisationExecutionScope,
    input: NonNullable<ReturnType<typeof parseEmailActivationRequest>>,
  ): Promise<ConnectorResult<EmailRuntimeSnapshot>> {
    const sql = this.host.ctx.storage.sql;
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, sql, input.identity),
    );
    if (!identity.ok) return identity;
    if (nextEmailWatchCleanupAt(sql) !== null)
      return invalid("connector_email_watch_cleanup_pending");
    const current = readEmailRuntime(sql);
    if (
      current !== null &&
      current.integrationAccountId !== input.integrationAccountId
    )
      return invalid("connector_email_identity_conflict");
    if (current !== null && current.disabledAt === null) {
      const updated = this.host.ctx.storage.transactionSync(
        updateEmailRuntimePolicy.bind(null, sql, {
          policyVersion: input.policyVersion,
          limits: input.limits,
        }),
      );
      await this.host.armAlarm();
      if (!(await isActorExecutionActive(sql, scope)))
        return invalid("connector_placement_conflict");
      return updated;
    }
    const watch = await establishConnectorEmailWatch({
      env: this.host.env,
      storage: this.host.ctx.storage,
      scope,
      integrationAccountId: input.integrationAccountId,
      now: input.now,
      fetcher: runtimeFetch,
    });
    if (!watch.ok) {
      if (!(await isActorExecutionActive(sql, scope)))
        return invalid("connector_placement_conflict");
      return invalid(watch.error.code);
    }
    // The accepted watch and its floor travel with the drained export.
    const activated = this.host.ctx.storage.transactionSync(
      activateEmailRuntime.bind(null, sql, {
        organisationId: input.identity.organisationId,
        integrationAccountId: input.integrationAccountId,
        policyVersion: input.policyVersion,
        limits: input.limits,
        activationFloor: watch.value.activationFloor,
        watchExpiresAt: watch.value.watchExpiresAt,
        now: input.now,
      }),
    );
    await this.host.armAlarm();
    if (!(await isActorExecutionActive(sql, scope)))
      return invalid("connector_placement_conflict");
    return activated;
  }

  async disableEmailProcessing(raw: unknown): Promise<ConnectorResult<null>> {
    return this.trackMailboxExecution(
      this.disableAdmittedEmailProcessing.bind(this, raw),
    );
  }

  private async disableAdmittedEmailProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<null>> {
    const input = parseEmailIdentityRequest(raw);
    if (input === null) return invalid("connector_email_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const disabled = this.host.ctx.storage.transactionSync(
      disableEmailRuntime.bind(null, this.host.ctx.storage.sql, {
        now: input.now,
      }),
    );
    await this.host.armAlarm();
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return disabled;
  }

  /**
   * An owner or admin accepted the terms of the mail model. The reply turns
   * that wait run at once, and the first of them changes the card of the
   * wait to say that mail goes to the model again.
   */
  async wakeEmailReplyTurns(
    raw: unknown,
  ): Promise<ConnectorResult<Readonly<{ woken: number }>>> {
    return this.host.trackExecution(
      this.wakeAdmittedEmailReplyTurns.bind(this, raw),
    );
  }

  private async wakeAdmittedEmailReplyTurns(
    raw: unknown,
  ): Promise<ConnectorResult<Readonly<{ woken: number }>>> {
    const input = parseEmailIdentityRequest(raw);
    if (input === null) return invalid("connector_email_wake_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const sql = this.host.ctx.storage.sql;
    const woken = this.host.ctx.storage.transactionSync(
      wakeEmailReplyTurns.bind(null, sql, input.now),
    );
    if (woken > 0) await this.host.armAlarm();
    if (!(await isActorExecutionActive(sql, scope)))
      return invalid("connector_placement_conflict");
    return { ok: true, value: { woken } };
  }

  async resumeEmailProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<EmailRuntimeSnapshot>> {
    return this.trackMailboxExecution(
      this.resumeAdmittedEmailProcessing.bind(this, raw),
    );
  }

  private async resumeAdmittedEmailProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<EmailRuntimeSnapshot>> {
    const input = parseEmailResumeRequest(raw);
    if (input === null) return invalid("connector_email_resume_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const sql = this.host.ctx.storage.sql;
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, sql, input.identity),
    );
    if (!identity.ok) return identity;
    if (nextEmailWatchCleanupAt(sql) !== null)
      return invalid("connector_email_watch_cleanup_pending");
    const resumed = this.host.ctx.storage.transactionSync(
      resumeEmailRuntime.bind(null, sql, {
        policyVersion: input.policyVersion,
        limits: input.limits,
        skipProviderMessageId: input.skipProviderMessageId,
        now: input.now,
      }),
    );
    await this.host.armAlarm();
    if (!(await isActorExecutionActive(sql, scope)))
      return invalid("connector_placement_conflict");
    return resumed;
  }

  async reconnectEmailProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<EmailRuntimeSnapshot>> {
    return this.trackMailboxExecution(
      this.reconnectAdmittedEmailProcessing.bind(this, raw),
    );
  }

  private async reconnectAdmittedEmailProcessing(
    raw: unknown,
  ): Promise<ConnectorResult<EmailRuntimeSnapshot>> {
    const input = parseEmailReconnectRequest(raw);
    if (input === null) return invalid("connector_email_reconnect_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const sql = this.host.ctx.storage.sql;
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, sql, input.identity),
    );
    if (!identity.ok) return identity;
    if (nextEmailWatchCleanupAt(sql) !== null)
      return invalid("connector_email_watch_cleanup_pending");
    const runtime = readEmailRuntime(sql);
    if (
      runtime === null ||
      runtime.integrationAccountId !== input.integrationAccountId
    )
      return invalid("connector_email_runtime_missing");
    if (input.resetCursor) {
      const disabled = this.host.ctx.storage.transactionSync(
        disableEmailRuntime.bind(null, sql, { now: input.now }),
      );
      if (!disabled.ok) return disabled;
      return this.activateEmailProcessingWithScope(scope, input);
    }
    const watch = await renewConnectorEmailWatch({
      storage: this.host.ctx.storage,
      env: this.host.env,
      scope,
      integrationAccountId: input.integrationAccountId,
      now: input.now,
      fetcher: runtimeFetch,
    });
    if (!watch.ok) {
      if (!(await isActorExecutionActive(sql, scope)))
        return invalid("connector_placement_conflict");
      return invalid(watch.error.code);
    }
    const reconnected = this.host.ctx.storage.transactionSync(
      reconnectEmailRuntime.bind(null, sql, {
        policyVersion: input.policyVersion,
        limits: input.limits,
        watchExpiresAt: watch.value,
        now: input.now,
      }),
    );
    await this.host.armAlarm();
    if (!(await isActorExecutionActive(sql, scope)))
      return invalid("connector_placement_conflict");
    return reconnected;
  }

  async renewEmailWatch(raw: unknown): Promise<ConnectorResult<number>> {
    return this.trackMailboxExecution(
      this.renewAdmittedEmailWatch.bind(this, raw),
    );
  }

  private async renewAdmittedEmailWatch(
    raw: unknown,
  ): Promise<ConnectorResult<number>> {
    const input = parseEmailIdentityRequest(raw);
    if (input === null) return invalid("connector_email_request_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const sql = this.host.ctx.storage.sql;
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, sql, input.identity),
    );
    if (!identity.ok) return identity;
    const runtime = readEmailRuntime(sql);
    if (runtime === null || runtime.disabledAt !== null)
      return invalid("connector_email_runtime_missing");
    if (nextEmailWatchCleanupAt(sql) !== null)
      return invalid("connector_email_watch_cleanup_pending");
    const renewed = await renewConnectorEmailWatch({
      storage: this.host.ctx.storage,
      env: this.host.env,
      scope,
      integrationAccountId: runtime.integrationAccountId,
      now: input.now,
      fetcher: runtimeFetch,
    });
    if (!(await isActorExecutionActive(sql, scope)))
      return invalid("connector_placement_conflict");
    return renewed;
  }

  async inspectEmailRuntime(): Promise<
    ConnectorResult<EmailRuntimeStatus | null>
  > {
    return this.host.trackExecution(
      this.inspectAdmittedEmailRuntime.bind(this),
    );
  }

  private async inspectAdmittedEmailRuntime(): Promise<
    ConnectorResult<EmailRuntimeStatus | null>
  > {
    const sql = this.host.ctx.storage.sql;
    if (!actorExecutionAdmissionOpen(sql))
      return invalid("connector_placement_conflict");
    const admission = await admitActorRecovery(
      this.host.env,
      this.host.ctx.storage,
    );
    if (
      admission.kind !== "admitted" ||
      !(await isActorExecutionActive(sql, admission.scope))
    )
      return invalid("connector_placement_conflict");
    const runtime = readEmailRuntime(sql);
    if (runtime === null) return { ok: true, value: null };
    const now = Date.now();
    return {
      ok: true,
      value: {
        ...runtime,
        usage: {
          activeCases: countEmailThreadsInProgress(sql),
          admittedLastHour: countEmailAdmissionsSince(sql, now - 3_600_000),
          tokens: emailTokenWindowTotals(sql, utcDayKey(now)),
          nextEvaluationAt: nextEmailEvaluationAt(sql),
        },
      },
    };
  }

  async searchEmailMailbox(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorEmailMailboxSearch>> {
    return this.host.trackExecution(
      this.searchAdmittedEmailMailbox.bind(this, raw),
    );
  }

  private async searchAdmittedEmailMailbox(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorEmailMailboxSearch>> {
    const input = parseEmailMailboxSearchRequest(raw);
    if (input === null)
      return invalid("connector_email_search_request_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const sql = this.host.ctx.storage.sql;
    const identity = this.host.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, sql, input.identity),
    );
    if (!identity.ok) return identity;
    const runtime = readEmailRuntime(sql);
    if (runtime === null || runtime.disabledAt !== null)
      return invalid("connector_email_runtime_inactive");
    const fetcher = fetchSessionConnectorMail.bind(
      null,
      sql,
      scope,
      this.host.env.DB,
      input.execution,
      runtimeFetch,
    );
    const access = await resolveConnectorGmailAccess({
      env: this.host.env,
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
      now: input.now,
      fetcher,
    });
    if (
      !(await isSessionMailExecutionActive(
        sql,
        scope,
        this.host.env.DB,
        input.execution,
      ))
    )
      return invalid("connector_execution_authority_inactive");
    if (!access.ok) return invalid(access.error.code);
    const searched = await GMAIL_MAILBOX.reads.searchMessages({
      accessToken: access.value,
      query: input.query,
      limit: input.limit,
      fetcher,
    });
    if (
      !(await isSessionMailExecutionActive(
        sql,
        scope,
        this.host.env.DB,
        input.execution,
      ))
    )
      return invalid("connector_execution_authority_inactive");
    if (!searched.ok) return invalid(searched.error.code);
    if (
      searched.value.messages.some(
        emailMessageExceedsLimit.bind(null, runtime.limits.maxMessageBytes),
      )
    )
      return invalid("connector_email_search_message_too_large");
    return {
      ok: true,
      value: {
        integrationAccountId: runtime.integrationAccountId,
        messages: searched.value.messages,
        truncated: searched.value.truncated,
      },
    };
  }

  async createEmailReplyProposal(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorEmailReplyProposal>> {
    return this.host.trackExecution(
      this.createAdmittedEmailReplyProposal.bind(this, raw),
    );
  }

  private async createAdmittedEmailReplyProposal(
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorEmailReplyProposal>> {
    const input = parseEmailReplyProposalCreateRequest(raw);
    if (input === null)
      return invalid("connector_email_reply_proposal_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const runtime = readEmailRuntime(this.host.ctx.storage.sql);
    if (
      runtime === null ||
      runtime.disabledAt !== null ||
      runtime.organisationId !== input.identity.organisationId
    ) {
      return invalid("connector_email_runtime_inactive");
    }
    const organisationId = parseOrganisationId(runtime.organisationId);
    const integrationAccountId = parseIntegrationAccountId(
      runtime.integrationAccountId,
    );
    const caseId = parseCaseId(input.caseId);
    if (!organisationId.ok || !integrationAccountId.ok || !caseId.ok) {
      return invalid("connector_email_reply_proposal_identity_invalid");
    }
    const binding = await readAgentMailboxBinding({
      db: scope.database,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
    });
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    if (!binding.ok) return invalid(binding.error.code);
    return this.withEmailProposalLock(
      input.proposalId,
      createConnectorEmailReplyProposal.bind(null, {
        scope,
        env: this.host.env,
        sql: this.host.ctx.storage.sql,
        runtime,
        caseId: caseId.value,
        mailboxBindingId: binding.value.binding.mailboxBindingId,
        bindingRevision: binding.value.currentRevision.revision,
        request: input,
      }),
    );
  }

  async createEmailOperationalProposal(
    raw: unknown,
  ): Promise<ConnectorResult<OperationalEmailProposalRecord>> {
    return this.trackMailboxExecution(
      this.admittedCreateEmailOperationalProposal.bind(this, raw),
    );
  }

  private async admittedCreateEmailOperationalProposal(
    raw: unknown,
  ): Promise<ConnectorResult<OperationalEmailProposalRecord>> {
    const input = parseEmailOperationalProposalCreateRequest(raw);
    if (input === null) {
      return invalid("connector_email_operational_proposal_request_invalid");
    }
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const integrationAccountId = parseIntegrationAccountId(
      input.integrationAccountId,
    );
    if (!integrationAccountId.ok) {
      return invalid("connector_email_operational_identity_invalid");
    }
    const context = await resolveActiveProviderAccountContext({
      db: scope.database,
      organisationId: scope.organisationId,
      integrationAccountId: integrationAccountId.value,
    });
    if (!context.ok || context.value.account.provider !== "gmail") {
      return invalid("connector_email_operational_provider_invalid");
    }
    const authority = connectionCredentialAuthority(
      context.value.connection.authority,
    );
    return executeOperationalEmailCommand<OperationalEmailProposalRecord>(
      this.host.ctx.storage,
      this.host.armAlarm.bind(this),
      scope,
      input.proposalId,
      input.now,
      createOperationalEmailProposal.bind(null, {
        execution: input.execution,
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        integrationAccountId: integrationAccountId.value,
        proposalId: input.proposalId,
        caseId: input.caseId,
        target: input.target,
        subject: input.subject,
        body: input.body,
        policyVersion: input.policyVersion,
        credentialGeneration: authority.credentialGeneration,
        now: input.now,
        expiresAt: input.expiresAt,
      }),
    );
  }

  async editEmailOperationalProposal(
    raw: unknown,
  ): Promise<ConnectorResult<OperationalEmailProposalRecord>> {
    return this.trackMailboxExecution(
      this.admittedEditEmailOperationalProposal.bind(this, raw),
    );
  }

  private async admittedEditEmailOperationalProposal(
    raw: unknown,
  ): Promise<ConnectorResult<OperationalEmailProposalRecord>> {
    const input = parseEmailOperationalProposalEditRequest(raw);
    if (input === null) {
      return invalid("connector_email_operational_proposal_edit_invalid");
    }
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const integrationAccountId = parseIntegrationAccountId(
      input.integrationAccountId,
    );
    if (!integrationAccountId.ok) {
      return invalid("connector_email_operational_identity_invalid");
    }
    return executeOperationalEmailCommand<OperationalEmailProposalRecord>(
      this.host.ctx.storage,
      this.host.armAlarm.bind(this),
      scope,
      input.proposalId,
      input.now,
      editOperationalEmailProposal.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        integrationAccountId: integrationAccountId.value,
        proposalId: input.proposalId,
        subject: input.subject,
        body: input.body,
        expectedVersion: input.expectedVersion,
        now: input.now,
      }),
    );
  }

  async previewEmailOperationalProposal(
    raw: unknown,
  ): Promise<ConnectorResult<OperationalEmailProposalOutcome>> {
    return this.trackMailboxExecution(
      this.admittedPreviewEmailOperationalProposal.bind(this, raw),
    );
  }

  private async admittedPreviewEmailOperationalProposal(
    raw: unknown,
  ): Promise<ConnectorResult<OperationalEmailProposalOutcome>> {
    const input = parseEmailOperationalProposalRequest(raw);
    if (input === null) {
      return invalid("connector_email_operational_proposal_request_invalid");
    }
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const integrationAccountId = parseIntegrationAccountId(
      input.integrationAccountId,
    );
    if (!integrationAccountId.ok) {
      return invalid("connector_email_operational_identity_invalid");
    }
    return executeOperationalEmailCommand<OperationalEmailProposalOutcome>(
      this.host.ctx.storage,
      this.host.armAlarm.bind(this),
      scope,
      input.proposalId,
      input.now,
      previewOperationalEmailProposal.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        integrationAccountId: integrationAccountId.value,
        proposalId: input.proposalId,
        now: input.now,
      }),
    );
  }

  async dispatchEmailOperational(
    raw: unknown,
  ): Promise<ConnectorResult<OperationalEmailDispatchOutcome>> {
    return this.trackMailboxExecution(
      this.admittedDispatchEmailOperational.bind(this, raw),
    );
  }

  private async admittedDispatchEmailOperational(
    raw: unknown,
  ): Promise<ConnectorResult<OperationalEmailDispatchOutcome>> {
    const input = parseEmailOperationalDispatchRequest(raw);
    if (input === null) {
      return invalid("connector_email_operational_dispatch_invalid");
    }
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const integrationAccountId = parseIntegrationAccountId(
      input.integrationAccountId,
    );
    if (!integrationAccountId.ok) {
      return invalid("connector_email_operational_identity_invalid");
    }
    return executeOperationalEmailCommand<OperationalEmailDispatchOutcome>(
      this.host.ctx.storage,
      this.host.armAlarm.bind(this),
      scope,
      input.proposalId,
      input.now,
      dispatchOperationalEmail.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        integrationAccountId: integrationAccountId.value,
        proposalId: input.proposalId,
        approvedVersion: input.approvedVersion,
        approvedSnapshotDigest: input.approvedSnapshotDigest,
        now: input.now,
      }),
    );
  }

  async rejectEmailOperational(raw: unknown): Promise<ConnectorResult<null>> {
    return this.trackMailboxExecution(
      this.admittedRejectEmailOperational.bind(this, raw),
    );
  }

  private async admittedRejectEmailOperational(
    raw: unknown,
  ): Promise<ConnectorResult<null>> {
    const input = parseEmailOperationalDispatchRequest(raw);
    if (input === null) {
      return invalid("connector_email_operational_dispatch_invalid");
    }
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const integrationAccountId = parseIntegrationAccountId(
      input.integrationAccountId,
    );
    if (!integrationAccountId.ok)
      return invalid("connector_email_operational_identity_invalid");
    return executeOperationalEmailCommand<null>(
      this.host.ctx.storage,
      this.host.armAlarm.bind(this),
      scope,
      input.proposalId,
      input.now,
      rejectAdmittedOperationalEmail.bind(
        null,
        this.host.ctx.storage.sql,
        scope,
        integrationAccountId.value,
        input.proposalId,
        input.approvedVersion,
        input.now,
      ),
    );
  }

  async revokeEmailOperationalProposals(
    raw: unknown,
  ): Promise<ConnectorResult<{ readonly revoked: number }>> {
    return this.trackMailboxExecution(
      this.admittedRevokeEmailOperationalProposals.bind(this, raw),
    );
  }

  private async admittedRevokeEmailOperationalProposals(
    raw: unknown,
  ): Promise<ConnectorResult<{ readonly revoked: number }>> {
    const input = parseEmailOperationalAccountRequest(raw);
    if (input === null) {
      return invalid("connector_email_operational_account_request_invalid");
    }
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const integrationAccountId = parseIntegrationAccountId(
      input.integrationAccountId,
    );
    if (!integrationAccountId.ok) {
      return invalid("connector_email_operational_identity_invalid");
    }
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    const revoked = this.host.ctx.storage.transactionSync(
      revokeOperationalEmailProposals.bind(
        null,
        this.host.ctx.storage.sql,
        integrationAccountId.value,
        input.now,
      ),
    );
    await this.host.armAlarm();
    for (const proposal of revoked) {
      const projected = await projectOperationalEmailRecord(
        this.host.ctx.storage.sql,
        scope,
        proposal,
        input.now,
      );
      if (!projected.ok) return projected;
    }
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return { ok: true, value: { revoked: revoked.length } };
  }

  async previewEmailProposal(
    raw: unknown,
  ): Promise<ConnectorResult<EmailProposalPreviewOutcome>> {
    return this.host.trackExecution(
      this.admittedPreviewEmailProposal.bind(this, raw),
    );
  }

  private async admittedPreviewEmailProposal(
    raw: unknown,
  ): Promise<ConnectorResult<EmailProposalPreviewOutcome>> {
    const input = parseEmailProposalRequest(raw);
    if (input === null)
      return invalid("connector_email_proposal_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const preview = await previewEmailProposal({
      sql: this.host.ctx.storage.sql,
      env: this.host.env,
      scope,
      proposalId: input.proposalId,
      now: input.now,
      fetcher: runtimeFetch,
    });
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return preview.ok ? preview : invalid(preview.error.code);
  }

  async authorizeEmailProposalDelivery(
    raw: unknown,
  ): Promise<ConnectorResult<null>> {
    return this.host.trackExecution(
      this.admittedAuthorizeEmailProposalDelivery.bind(this, raw),
    );
  }

  private async admittedAuthorizeEmailProposalDelivery(
    raw: unknown,
  ): Promise<ConnectorResult<null>> {
    const input = parseEmailProposalRequest(raw);
    if (input === null || !isRecord(raw))
      return invalid("connector_email_proposal_request_invalid");
    const authority = parseStoredRequestAuthority(raw.authority);
    if (
      !authority.ok ||
      authority.value.requestAuthority.kind !== "control" ||
      authority.value.requestAuthority.organisationId !==
        input.identity.organisationId
    )
      return invalid("connector_email_proposal_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const authorized = await authorizeEmailReplyReview(
      this.host.ctx.storage.sql,
      this.host.env,
      scope,
      authority.value.requestAuthority,
      input.proposalId,
    );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return authorized.ok ? authorized : invalid(authorized.error.code);
  }

  async dispatchEmailReply(
    raw: unknown,
  ): Promise<ConnectorResult<EmailDispatchOutcome>> {
    return this.host.trackExecution(
      this.admittedDispatchEmailReply.bind(this, raw),
    );
  }

  private async admittedDispatchEmailReply(
    raw: unknown,
  ): Promise<ConnectorResult<EmailDispatchOutcome>> {
    const input = parseEmailDispatchRequest(raw);
    if (input === null) return invalid("connector_email_dispatch_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const dispatched = await this.withEmailProposalLock(
      input.proposalId,
      dispatchEmailReply.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        proposalId: input.proposalId,
        approvedVersion: input.approvedVersion,
        approvedSnapshotDigest: input.approvedSnapshotDigest,
        now: input.now,
        fetcher: runtimeFetch,
      }),
    );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return dispatched.ok ? dispatched : invalid(dispatched.error.code);
  }

  /**
   * Plan 40D: what a reply rests on, for an agent edit of its shared draft.
   * A reply that the mailbox agent drafted carries its turn's flow; one that
   * a Portal chat drafted carries the chat's sources and context.
   */
  async readEmailReplyProvenance(
    input: ConnectorEmailIdentityRequest & Readonly<{ proposalId: string }>,
  ): Promise<ConnectorResult<EmailReplyProvenance>> {
    return this.host.trackExecution(
      this.admittedReadEmailReplyProvenance.bind(this, input),
    );
  }

  private async admittedReadEmailReplyProvenance(
    input: Parameters<ConnectorEmail["readEmailReplyProvenance"]>[0],
  ): Promise<ConnectorResult<EmailReplyProvenance>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const sql = this.host.ctx.storage.sql;
    const operation = latestEmailDraftOperation(sql, input.proposalId);
    if (operation === null || operation.state !== "awaiting_approval")
      return invalid("email_reply_edit_unavailable");
    const value: EmailReplyProvenance =
      readEmailProposalFlow(sql, input.proposalId) !== null
        ? { kind: "mailbox" }
        : {
            kind: "chat",
            chatSources: readEmailProposalChatSources(sql, input.proposalId),
            chatContext: readEmailProposalChatContext(sql, input.proposalId),
          };
    if (!(await isActorExecutionActive(sql, scope)))
      return invalid("connector_placement_conflict");
    return { ok: true, value };
  }

  /**
   * Plan 40D: adds what an editing Portal chat read to a chat-drafted reply,
   * before its words reach the shared draft.
   */
  async recordEmailReplyEditProvenance(
    input: ConnectorEmailIdentityRequest &
      Readonly<{
        proposalId: string;
        chatSources: readonly import("../../mail-inbox/reply-sources").EmailChatSource[];
        chatContext: import("../../mail-inbox/reply-sources").EmailChatContext;
      }>,
  ): Promise<ConnectorResult<null>> {
    return this.host.trackExecution(
      this.admittedRecordEmailReplyEditProvenance.bind(this, input),
    );
  }

  private async admittedRecordEmailReplyEditProvenance(
    input: Parameters<ConnectorEmail["recordEmailReplyEditProvenance"]>[0],
  ): Promise<ConnectorResult<null>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const recorded = await this.withEmailProposalLock(
      input.proposalId,
      async (): Promise<ConnectorResult<null>> => {
        const sql = this.host.ctx.storage.sql;
        const operation = latestEmailDraftOperation(sql, input.proposalId);
        if (
          operation === null ||
          operation.state !== "awaiting_approval" ||
          readEmailProposalFlow(sql, input.proposalId) !== null
        )
          return invalid("email_reply_edit_unavailable");
        const kept = this.host.ctx.storage.transactionSync(
          recordChatEditProvenance.bind(null, sql, input.proposalId, {
            chatSources: input.chatSources,
            chatContext: input.chatContext,
          }),
        );
        return kept
          ? { ok: true, value: null }
          : invalid("email_reply_provenance_too_large");
      },
    );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return recorded;
  }

  async editReviewedEmailReply(
    input: ConnectorEmailIdentityRequest &
      Readonly<{
        proposalId: string;
        authority: Variant<
          import("@purin-labs/contracts").RequestAuthority,
          "control"
        >;
        edit: import("@purin-labs/control-api").MailReplyEdit;
        /** Plan 40D: `shared` for a body that several authors wrote. */
        attribution?: "single_editor" | "shared";
      }>,
  ): Promise<ConnectorResult<EmailReplyEditReceipt>> {
    return this.host.trackExecution(
      this.admittedEditReviewedEmailReply.bind(this, input),
    );
  }

  private async admittedEditReviewedEmailReply(
    input: Parameters<ConnectorEmail["editReviewedEmailReply"]>[0],
  ): Promise<ConnectorResult<EmailReplyEditReceipt>> {
    if (input.authority.organisationId !== input.identity.organisationId)
      return invalid("connector_email_proposal_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const edited = await this.withEmailProposalLock(
      input.proposalId,
      editEmailReplyBody.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        proposalId: input.proposalId,
        authority: input.authority,
        edit: input.edit,
        attribution: input.attribution ?? "single_editor",
        now: input.now,
        fetcher: runtimeFetch,
      }),
    );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    // A recorded correction queued its learning turn; wake for it. An edit
    // that recorded none leaves the alarm as it was.
    if (
      edited.ok &&
      nextEmailCorrectionLearningAt(this.host.ctx.storage.sql) !== null
    )
      await this.host.armAlarm();
    return edited.ok ? edited : invalid(edited.error.code);
  }

  /**
   * The recorded correction that produced one reply version, or null. It is
   * returned only while every source the proposal drew on still stands at
   * the revision the proposal cited. The caller decides who may read it from
   * the binding's label. Neither body is returned.
   */
  async readEmailReplyCorrection(
    input: ConnectorEmailIdentityRequest &
      Readonly<{ proposalId: string; version: number }>,
  ): Promise<ConnectorResult<EmailReplyCorrection | null>> {
    return this.host.trackExecution(
      this.admittedReadEmailReplyCorrection.bind(this, input),
    );
  }

  private async admittedReadEmailReplyCorrection(
    input: Parameters<ConnectorEmail["readEmailReplyCorrection"]>[0],
  ): Promise<ConnectorResult<EmailReplyCorrection | null>> {
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const correction = readEmailReplyCorrection(
      this.host.ctx.storage.sql,
      input.proposalId,
      input.version,
    );
    if (correction === null) return { ok: true, value: null };
    const sources = await this.emailProposalSourcesStand(
      input.identity,
      input.proposalId,
    );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    if (!sources.ok) return sources;
    return { ok: true, value: sources.value ? correction : null };
  }

  /**
   * Whether the sources a proposal's recorded flow depends on still stand at
   * their cited revisions. A changed or erased source is a known fact and
   * answers false; a check that could not be made is an error.
   */
  private async emailProposalSourcesStand(
    identity: ConnectorIdentity,
    proposalId: string,
  ): Promise<ConnectorResult<boolean>> {
    const flow = readEmailProposalFlow(this.host.ctx.storage.sql, proposalId);
    if (flow === null) return { ok: true, value: false };
    const valid = await validateEmailCaseContextCollectionDependency(
      this.host.env,
      identity.organisationId,
      flow.dependency,
    );
    if (valid.ok) return { ok: true, value: true };
    return valid.error.code === "case_context_collection_evidence_stale" ||
      valid.error.code === "case_context_collection_evidence_invalid"
      ? { ok: true, value: false }
      : invalid(valid.error.code);
  }

  async previewEmailRelationship(
    input: ConnectorEmailIdentityRequest &
      Readonly<{
        proposalId: string;
        authority: Variant<
          import("@purin-labs/contracts").RequestAuthority,
          "control"
        >;
        lookup: import("@purin-labs/control-api").MailRelationshipLookup;
      }>,
  ): Promise<ConnectorResult<EmailRelationshipPreview>> {
    return this.host.trackExecution(
      this.admittedPreviewEmailRelationship.bind(this, input),
    );
  }

  private async admittedPreviewEmailRelationship(
    input: Parameters<ConnectorEmail["previewEmailRelationship"]>[0],
  ): Promise<ConnectorResult<EmailRelationshipPreview>> {
    if (input.authority.organisationId !== input.identity.organisationId)
      return invalid("connector_email_proposal_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const preview = await this.withEmailProposalLock(
      input.proposalId,
      previewEmailRelationship.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        proposalId: input.proposalId,
        authority: input.authority,
        lookup: input.lookup,
        now: input.now,
        fetcher: runtimeFetch,
      }),
    );

    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return preview;
  }

  async correctEmailRelationship(
    input: ConnectorEmailIdentityRequest &
      Readonly<{
        proposalId: string;
        authority: Variant<
          import("@purin-labs/contracts").RequestAuthority,
          "control"
        >;
        correction: import("@purin-labs/control-api").MailReplyCorrection;
      }>,
  ): Promise<ConnectorResult<EmailReplyEditReceipt>> {
    return this.host.trackExecution(
      this.admittedCorrectEmailRelationship.bind(this, input),
    );
  }

  private async admittedCorrectEmailRelationship(
    input: Parameters<ConnectorEmail["correctEmailRelationship"]>[0],
  ): Promise<ConnectorResult<EmailReplyEditReceipt>> {
    if (input.authority.organisationId !== input.identity.organisationId)
      return invalid("connector_email_proposal_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const corrected = await this.withEmailProposalLock(
      input.proposalId,
      correctEmailRelationship.bind(null, {
        sql: this.host.ctx.storage.sql,
        storage: this.host.ctx.storage,
        env: this.host.env,
        scope,
        proposalId: input.proposalId,
        authority: input.authority,
        correction: input.correction,
        now: input.now,
        fetcher: runtimeFetch,
      }),
    );

    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return corrected;
  }

  async dispatchReviewedEmailReply(
    raw: unknown,
  ): Promise<ConnectorResult<EmailDispatchOutcome>> {
    return this.host.trackExecution(
      this.admittedDispatchReviewedEmailReply.bind(this, raw),
    );
  }

  private async admittedDispatchReviewedEmailReply(
    raw: unknown,
  ): Promise<ConnectorResult<EmailDispatchOutcome>> {
    const input = parseEmailDispatchRequest(raw);
    if (input === null || !isRecord(raw))
      return invalid("connector_email_dispatch_invalid");
    const parsed = parseStoredRequestAuthority(raw.authority);
    if (
      !parsed.ok ||
      parsed.value.requestAuthority.kind !== "control" ||
      parsed.value.requestAuthority.organisationId !==
        input.identity.organisationId
    )
      return invalid("connector_email_dispatch_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const beforeSend = authorizeEmailReplyReview.bind(
      null,
      this.host.ctx.storage.sql,
      this.host.env,
      scope,
      parsed.value.requestAuthority,
      input.proposalId,
    );
    const dispatched = await this.withEmailProposalLock(
      input.proposalId,
      dispatchEmailReply.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        proposalId: input.proposalId,
        approvedVersion: input.approvedVersion,
        approvedSnapshotDigest: input.approvedSnapshotDigest,
        now: input.now,
        fetcher: runtimeFetch,
        beforeSend,
      }),
    );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return dispatched.ok ? dispatched : invalid(dispatched.error.code);
  }

  async resolveEmailProposal(
    raw: unknown,
  ): Promise<ConnectorResult<EmailProposalResolution>> {
    return this.host.trackExecution(
      this.admittedResolveEmailProposal.bind(this, raw),
    );
  }

  private async admittedResolveEmailProposal(
    raw: unknown,
  ): Promise<ConnectorResult<EmailProposalResolution>> {
    const input = parseEmailResolveRequest(raw);
    if (input === null)
      return invalid("connector_email_proposal_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const resolved = await this.withEmailProposalLock(
      input.proposalId,
      resolveEmailProposalState.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        proposalId: input.proposalId,
        dispatchVersion: input.dispatchVersion,
        now: input.now,
        fetcher: runtimeFetch,
      }),
    );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return resolved.ok ? resolved : invalid(resolved.error.code);
  }

  async disposeEmailProposal(
    raw: unknown,
  ): Promise<ConnectorResult<EmailDisposalOutcome>> {
    return this.host.trackExecution(
      this.admittedDisposeEmailProposal.bind(this, raw),
    );
  }

  private async admittedDisposeEmailProposal(
    raw: unknown,
  ): Promise<ConnectorResult<EmailDisposalOutcome>> {
    const input = parseEmailProposalRequest(raw);
    if (input === null)
      return invalid("connector_email_proposal_request_invalid");
    const admitted = await admitNamedConnector(this.host, input.identity);
    if (!admitted.ok) return admitted;
    const scope = admitted.value;
    const disposed = await this.withEmailProposalLock(
      input.proposalId,
      disposeEmailProposal.bind(null, {
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        proposalId: input.proposalId,
        now: input.now,
        fetcher: runtimeFetch,
      }),
    );
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    return disposed.ok ? disposed : invalid(disposed.error.code);
  }

  /**
   * Mailbox teardown. Fencing comes first so no approval in flight can reach
   * messages.send once revocation begins, then every outstanding Pantry-created
   * draft is disposed, then the Gmail watch is stopped so Google stops
   * publishing. Draft disposal is reported per proposal rather than summarised,
   * because a draft Pantry cannot delete stays in the organisation's mailbox and the
   * operator has to know about it.
   */
  async revokeEmailMailbox(
    raw: unknown,
  ): Promise<ConnectorResult<EmailMailboxRevocation>> {
    return this.trackMailboxExecution(
      this.admittedRevokeEmailMailbox.bind(this, raw),
    );
  }

  private async admittedRevokeEmailMailbox(
    raw: unknown,
  ): Promise<ConnectorResult<EmailMailboxRevocation>> {
    const input = parseEmailMailboxRevocationRequest(raw);
    if (input === null) return invalid("connector_email_request_invalid");
    const scope = await this.host.admitExecution(input.identity);
    if (scope === null) return invalid("connector_placement_conflict");
    const fenced = this.host.ctx.storage.transactionSync(
      fenceConnectorEmailMailbox.bind(null, this.host.ctx.storage.sql, input),
    );
    if (!fenced.ok) return invalid(fenced.error.code);
    if (input.kind === "erase") {
      await eraseMailClassificationRecords(scope, input.integrationAccountId);
    }
    await this.host.armAlarm();
    const pending = pendingEmailDraftProposals(this.host.ctx.storage.sql);
    const disposals: EmailMailboxDisposal[] = [];
    for (const operation of pending) {
      const disposed = await disposeEmailProposal({
        sql: this.host.ctx.storage.sql,
        env: this.host.env,
        scope,
        proposalId: operation.proposalId,
        now: input.now,
        fetcher: runtimeFetch,
      });
      disposals.push({
        proposalId: operation.proposalId,
        version: operation.version,
        kind: disposed.ok ? disposed.value.kind : "cleanup_pending",
      });
    }
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    const stopped = await stopConnectorEmailWatch({
      env: this.host.env,
      storage: this.host.ctx.storage,
      scope,
      now: input.now,
      fetcher: runtimeFetch,
    });
    await this.host.armAlarm();
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return invalid("connector_placement_conflict");
    const watchStopped = stopped.ok;
    return { ok: true, value: { watchStopped, disposals } };
  }

  /** Email as a channel of the Connector: its tables and its alarm part. */
  emailChannel(): ChannelAdapter {
    return {
      name: "email",
      createSchema: createEmailChannelSchema,
      alarmDue: emailAlarmDue,
      beforeCaseWork: this.stopDueEmailWatch.bind(this),
      alarmSteps: this.emailAlarmSteps.bind(this),
    };
  }

  /** Stops the Gmail watch of a mailbox whose cleanup is due. */
  private async stopDueEmailWatch(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const watchCleanupAt = nextEmailWatchCleanupAt(this.host.ctx.storage.sql);
    if (watchCleanupAt !== null && watchCleanupAt <= Date.now()) {
      await this.emailMailboxWork.enqueue(
        stopConnectorEmailWatch.bind(null, {
          env: this.host.env,
          storage: this.host.ctx.storage,
          scope,
          now: Date.now(),
          fetcher: runtimeFetch,
        }),
      );
    }
  }

  /**
   * The mailbox work of one alarm. The mailbox's evals run here too: an eval
   * task runs the mailbox's agent.
   */
  private emailAlarmSteps(
    scope: OrganisationExecutionScope,
  ): ChannelAlarmSteps {
    return {
      together: [
        {
          name: "email_evaluation",
          run: () => this.runDueEmailEvaluation(scope),
        },
      ],
      inOrder: [
        {
          name: "email_case_context_discovery",
          run: () => this.runDueEmailCaseContextDiscoveries(scope),
        },
        {
          name: "email_correction_learning",
          run: () => this.runDueEmailCorrectionLearning(scope),
        },
        { name: "eval_work", run: () => this.evals.runDueEvalWork(scope) },
        {
          name: "mail_organization",
          run: () => this.runDueMailOrganization(scope),
        },
        {
          name: "email_proposal_maintenance",
          run: () =>
            runEmailProposalMaintenance({
              scope,
              sql: this.host.ctx.storage.sql,
              env: this.host.env,
              now: Date.now(),
              fetcher: runtimeFetch,
              withProposalLock: this.withEmailProposalLock.bind(this),
            }),
        },
        {
          name: "operational_email",
          run: () =>
            this.emailMailboxWork.enqueue(
              maintainOperationalEmail.bind(null, this.host.ctx.storage, scope),
            ),
        },
      ],
    };
  }

  private async runDueMailOrganization(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    if (this.activeMailOrganization !== null)
      return this.activeMailOrganization;
    this.activeMailOrganization = runMailOrganization({
      scope,
      env: this.host.env,
      storage: this.host.ctx.storage,
    });
    try {
      await this.activeMailOrganization;
    } finally {
      this.activeMailOrganization = null;
    }
  }

  private async runDueEmailEvaluation(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    // The reply turns that wait run first. Each one that ends frees its
    // place under the in-progress limit, so the evaluation after a Resume
    // admits the mail that paused the mailbox instead of pausing again.
    await this.runDueEmailReplyTurns(scope);
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return;
    try {
      // Admission queues the reply turn each admitted burst is owed.
      await runConnectorEmailEvaluation({
        scope,
        storage: this.host.ctx.storage,
        env: this.host.env,
        now: Date.now(),
        fetcher: runtimeFetch,
      });
    } catch (error) {
      traceWarn("connector.email_evaluation_failed", {
        requestId: newRequestId(),
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return;
    await this.runDueEmailReplyTurns(scope);
  }

  /**
   * Runs each reply turn that is due. The work was written with the mail's
   * admission, so a turn this instance did not finish is run again: by its
   * retry time, or at once by the instance that replaces this one. A turn is
   * claimed before it runs and is never run twice at the same time.
   */
  private async runDueEmailReplyTurns(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const sql = this.host.ctx.storage.sql;
    for (let processed = 0; processed < 5; processed += 1) {
      if (!(await isActorExecutionActive(sql, scope))) return;
      const runtime = readEmailRuntime(sql);
      if (
        runtime === null ||
        runtime.disabledAt !== null ||
        runtime.processing.kind === "paused"
      )
        return;
      const now = Date.now();
      const work = this.host.ctx.storage.transactionSync(
        claimDueEmailReplyTurn.bind(null, sql, {
          now,
          owner: this.emailReplyTurnOwner,
          running: this.runningEmailReplyTurns,
        }),
      );
      if (work === null) return;
      this.runningEmailReplyTurns.add(work.providerMessageId);
      // A turn that throws is one failed attempt. It must not stop the
      // alarm's other work or repeat without bound.
      const outcome = await this.runEmailReplyTurn(scope, runtime, work, now)
        .catch(() => ({ kind: "retry", reason: "email_turn_failed" }) as const)
        .finally(() => {
          this.runningEmailReplyTurns.delete(work.providerMessageId);
        });
      // A frozen placement keeps the claim. The instance that takes over
      // finds it held by another and runs the turn.
      if (!(await isActorExecutionActive(sql, scope))) return;
      if (outcome.kind === "settled") {
        this.host.ctx.storage.transactionSync(
          completeEmailReplyTurn.bind(null, sql, work.providerMessageId),
        );
        if (outcome.reason !== null)
          traceWarn("connector.email_turn_failed", {
            requestId: newRequestId(),
            thread_id: work.threadId,
            reason: outcome.reason,
          });
        continue;
      }
      const retried = this.host.ctx.storage.transactionSync(
        retryEmailReplyTurn.bind(null, sql, { work, now: Date.now() }),
      );
      traceWarn("connector.email_turn_failed", {
        requestId: newRequestId(),
        thread_id: work.threadId,
        reason:
          retried === "exhausted"
            ? "email_turn_retries_exhausted"
            : outcome.reason,
      });
    }
  }

  private async runEmailReplyTurn(
    scope: OrganisationExecutionScope,
    runtime: EmailRuntimeSnapshot,
    work: EmailReplyTurnWork,
    now: number,
  ): Promise<
    | Readonly<{ kind: "settled"; reason: string | null }>
    | Readonly<{ kind: "retry"; reason: string }>
  > {
    const binding = await scope.database
      .prepare(
        `SELECT mailbox_binding_id AS mailboxBindingId, current_revision AS currentRevision
         FROM agent_mailbox_binding WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(runtime.organisationId, runtime.integrationAccountId)
      .first<{
        readonly mailboxBindingId: string;
        readonly currentRevision: number;
      }>();
    if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
      return { kind: "retry", reason: "connector_placement_conflict" };
    if (binding === null)
      return { kind: "retry", reason: "mailbox_binding_missing" };
    const turn = await processEmailThreadTurn(this.host.env, {
      scope,
      connectorSql: this.host.ctx.storage.sql,
      responsePolicy: "cue_routed",
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
      threadId: work.threadId,
      caseId: work.caseId,
      messageIds: work.messageIds,
      mailboxBindingId: binding.mailboxBindingId,
      bindingRevision: binding.currentRevision,
      policyVersion: runtime.policyVersion,
      limits: runtime.limits,
      claim: { attempt: work.attempt, disposition: work.disposition },
      now,
    });
    if (turn.ok) {
      const outcome = turn.value;
      if (outcome.kind === "deferred")
        return { kind: "retry", reason: outcome.reason };
      // No budget today and another assignment in progress both pass.
      return outcome.kind === "skipped" &&
        (outcome.reason === "daily_token_budget_exhausted" ||
          outcome.reason === "case_assignment_in_progress")
        ? { kind: "retry", reason: outcome.reason }
        : { kind: "settled", reason: null };
    }
    // The message is no longer this path's to answer, or its draft was
    // claimed and can never be made a second time.
    return turn.error.code === "email_turn_identity_invalid" ||
      turn.error.code === "email_response_owner_conflict" ||
      turn.error.code === "email_draft_creation_indeterminate"
      ? { kind: "settled", reason: turn.error.code }
      : { kind: "retry", reason: turn.error.code };
  }

  /**
   * Runs the learning turn for each recorded correction that is due. The
   * turn runs only while that correction is still the draft, so a correction
   * that was edited again, sent or removed is dropped. A turn that could not
   * run is tried again later. Each attempt is claimed before it runs and has
   * its own assignment and Session, so an attempt that stopped with its
   * instance is settled and the turn is run again.
   */
  private async runDueEmailCorrectionLearning(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    for (let processed = 0; processed < 3; processed += 1) {
      if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
        return;
      const now = Date.now();
      const work = this.host.ctx.storage.transactionSync(
        claimDueEmailCorrectionLearning.bind(
          null,
          this.host.ctx.storage.sql,
          now,
        ),
      );
      if (work === null) return;
      // A turn that throws is one failed attempt. It must not stop the
      // alarm's other work or repeat without bound.
      const outcome = await this.learnFromEmailCorrection(
        scope,
        work,
        now,
      ).catch(
        () =>
          ({ kind: "retry", reason: "correction_learning_failed" }) as const,
      );
      if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
        return;
      if (outcome.kind === "settled") {
        this.host.ctx.storage.transactionSync(
          completeEmailCorrectionLearning.bind(
            null,
            this.host.ctx.storage.sql,
            work,
          ),
        );
        continue;
      }
      const retried = this.host.ctx.storage.transactionSync(
        retryEmailCorrectionLearning.bind(null, this.host.ctx.storage.sql, {
          work,
          now,
        }),
      );
      traceWarn("connector.email_correction_learning_failed", {
        requestId: newRequestId(),
        reason:
          retried === "exhausted"
            ? "correction_learning_retries_exhausted"
            : outcome.reason,
      });
    }
  }

  private async learnFromEmailCorrection(
    scope: OrganisationExecutionScope,
    work: EmailCorrectionLearningWork,
    now: number,
  ): Promise<
    | Readonly<{ kind: "settled"; reason?: never }>
    | Readonly<{ kind: "retry"; reason: string }>
  > {
    const sql = this.host.ctx.storage.sql;
    const corrected = await readCorrectedEmailReply({
      sql,
      env: this.host.env,
      scope,
      proposalId: work.proposalId,
      version: work.version,
      now,
      fetcher: runtimeFetch,
    });
    if (corrected.kind !== "current")
      return corrected.kind === "gone"
        ? { kind: "settled" }
        : { kind: "retry", reason: "corrected_reply_unavailable" };
    const runtime = readEmailRuntime(sql);
    if (runtime === null || runtime.disabledAt !== null)
      return { kind: "settled" };
    if (runtime.processing.kind === "paused")
      return { kind: "retry", reason: "mailbox_processing_paused" };
    const binding = await scope.database
      .prepare(
        `SELECT mailbox_binding_id AS mailboxBindingId, current_revision AS currentRevision
         FROM agent_mailbox_binding WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(runtime.organisationId, runtime.integrationAccountId)
      .first<{
        readonly mailboxBindingId: string;
        readonly currentRevision: number;
      }>();
    if (!(await isActorExecutionActive(sql, scope)))
      return { kind: "retry", reason: "connector_placement_conflict" };
    if (binding === null) return { kind: "settled" };
    const learned = await processEmailCorrectionLearning(this.host.env, {
      scope,
      connectorSql: sql,
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
      threadId: corrected.operation.threadId,
      caseId: corrected.operation.caseId,
      messageIds: [corrected.operation.triggeringMessageId],
      mailboxBindingId: binding.mailboxBindingId,
      bindingRevision: binding.currentRevision,
      policyVersion: runtime.policyVersion,
      limits: runtime.limits,
      correction: {
        proposalId: work.proposalId,
        version: work.version,
        bodyDigest: corrected.bodyDigest,
        correctedReply: corrected.body,
      },
      claim: { attempt: work.attempt },
      now,
    });
    if (learned.ok) {
      const outcome = learned.value;
      if (outcome.kind === "deferred")
        return { kind: "retry", reason: outcome.reason };
      // No budget today and another assignment in progress both pass.
      return outcome.kind === "skipped" &&
        (outcome.reason === "daily_token_budget_exhausted" ||
          outcome.reason === "case_assignment_in_progress")
        ? { kind: "retry", reason: outcome.reason }
        : { kind: "settled" };
    }
    // A settled assignment under this attempt's name means the correction
    // was queued again after a run that learned from it.
    return learned.error.code === "case_assignment_settled"
      ? { kind: "settled" }
      : { kind: "retry", reason: learned.error.code };
  }

  private async runDueEmailCaseContextDiscoveries(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    for (let processed = 0; processed < 5; processed += 1) {
      if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
        return;
      const now = Date.now();
      const work = this.host.ctx.storage.transactionSync(
        dueEmailCaseContextDiscovery.bind(null, this.host.ctx.storage.sql, now),
      );
      if (work === null) return;
      const outcome = await runEmailCaseContextDiscoveryWork({
        scope,
        env: this.host.env,
        sql: this.host.ctx.storage.sql,
        work,
        now,
      });
      if (!(await isActorExecutionActive(this.host.ctx.storage.sql, scope)))
        return;
      if (outcome.kind === "evaluated") {
        traceLog("connector.email_case_context_discovery_evaluated", {
          requestId: newRequestId(),
          recorded: outcome.recorded,
        });
      }
      const finalized = this.host.ctx.storage.transactionSync(
        finalizeEmailCaseContextDiscovery.bind(
          null,
          this.host.ctx.storage.sql,
          work,
          outcome,
          now,
        ),
      );
      if (outcome.kind === "retry") {
        traceWarn("connector.email_case_context_collection_failed", {
          requestId: newRequestId(),
          reason:
            finalized === "exhausted"
              ? "case_context_discovery_retries_exhausted"
              : outcome.reason,
        });
      }
    }
  }

  private async withEmailProposalLock<T>(
    proposalId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.emailProposalWork.enqueue(proposalId, task);
  }
}

/** The RPC methods of this module. The Actor class has one method for each. */
export type ConnectorEmailRpc = Pick<
  ConnectorEmail,
  | "reconcileRelocationMailReceipt"
  | "mailAssistant"
  | "readMailOrganization"
  | "readMailClassifiedPage"
  | "readMailDecision"
  | "manageMailOrganization"
  | "acceptEmailChange"
  | "checkEmailChange"
  | "activateEmailProcessing"
  | "disableEmailProcessing"
  | "resumeEmailProcessing"
  | "wakeEmailReplyTurns"
  | "reconnectEmailProcessing"
  | "renewEmailWatch"
  | "inspectEmailRuntime"
  | "searchEmailMailbox"
  | "createEmailReplyProposal"
  | "createEmailOperationalProposal"
  | "editEmailOperationalProposal"
  | "previewEmailOperationalProposal"
  | "dispatchEmailOperational"
  | "rejectEmailOperational"
  | "revokeEmailOperationalProposals"
  | "previewEmailProposal"
  | "authorizeEmailProposalDelivery"
  | "dispatchEmailReply"
  | "readEmailReplyProvenance"
  | "recordEmailReplyEditProvenance"
  | "editReviewedEmailReply"
  | "readEmailReplyCorrection"
  | "previewEmailRelationship"
  | "correctEmailRelationship"
  | "dispatchReviewedEmailReply"
  | "resolveEmailProposal"
  | "disposeEmailProposal"
  | "revokeEmailMailbox"
>;
