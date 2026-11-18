import {
  armAlarmAfterFailedSteps,
  runAlarmSteps,
  runAlarmStepsTogether,
} from "../lifecycle/actor-alarm";
import { runtimeFetch } from "../../runtime-fetch";
import {
  connectorWarmActorSlots,
  createWarmActorSlotSchema,
  eraseWarmActorSlots,
  type WarmActorSlot,
} from "../warm-actor-slots";
import { runMailOrganization } from "../../mail-inbox/connector-runtime";
import {
  createContinueSerialQueue,
  createKeyedContinueSerialQueue,
} from "@seams/async-control/serial-queue";
import type { ConnectorIdentity } from "@seams/contracts";
import { readWhatsAppIngressPolicy } from "../../data/whatsapp";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "../../ids";
import { traceLog, traceWarn } from "../../observability";
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
import { sessionActorStub } from "../actor-router";
import {
  createConnectorEmailSchema,
  claimDueEmailReplyTurn,
  completeEmailCorrectionLearning,
  completeEmailReplyTurn,
  retryEmailReplyTurn,
  type EmailCorrectionLearningWork,
  type EmailReplyTurnWork,
  dueEmailCaseContextDiscovery,
  claimDueEmailCorrectionLearning,
  retryEmailCorrectionLearning,
  nextEmailWatchCleanupAt,
  readEmailRuntime,
  type EmailRuntimeSnapshot,
} from "../connector-email";
import {
  claimDueEvalTask,
  deferEvalRunPublication,
  deferEvalTask,
  EVAL_TASK_MAX_CLAIMS,
  markEvalRunPublished,
  readSettledEvalRun,
  settleEvalTask,
  type ClaimedEvalTask,
} from "../connector-eval";
import { processEvalTask, type EvalTaskEnd } from "../eval-task-processing";
import { publishEvalRunResult } from "../../evals/access";
import {
  stopConnectorEmailWatch,
  runConnectorEmailEvaluation,
} from "../connector-email-evaluation";
import {
  processEmailCorrectionLearning,
  processEmailThreadTurn,
} from "../email-case-processing";
import {
  readCorrectedEmailReply,
  runEmailProposalMaintenance,
} from "../connector-email-proposal";
import {
  createConnectorCaseWorkSchema,
  renewRunningConnectorCaseWorkLeases,
} from "../connector-case-work";
import {
  startSlackSideCase,
  type SlackSideCaseStartOutcome,
} from "../connector-side-case";
import {
  createConnectorSlackStreamSchema,
  parseConnectorCaseTurnStreamInput,
  streamConnectorCaseTurn,
  type ConnectorCaseStreamRelease,
  type ConnectorCaseTurnStreamError,
} from "../connector-slack-stream";
import type { OngoingCaseWalkingConnector } from "../case-walking-path";
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
  finalizeEmailCaseContextDiscovery,
  maintainOperationalEmail,
  runEmailCaseContextDiscoveryWork,
} from "./email-work";
import { ignoreEarlierSideCaseStart, isPresentNoticeKey } from "./email";
import {
  ensureConnectorIdentity,
  ignoreUnusedCredentialRoute,
  parseDeliveryRequest,
  parseIngressRequest,
} from "./ingress-parsers";
import {
  deliverSlackOutput,
  startSlackThreadCredentialRoute,
} from "./slack-delivery";
import {
  type ConnectorAdmission,
  type LiveSlackTurn,
  invalid,
} from "./support";
import {
  type ConnectorDeliveryRequest,
  type ConnectorDeliveryResult,
  type ConnectorResult,
  WHATSAPP_TURN_RETRY_MS,
} from "./types";
import { ConnectorCaseWorkDrain } from "./case-work-drain";
import type { ConnectorDO } from "../connector";

/**
 * The Connector actor's state, its alarm and its shared Case work helpers (Refactor 10, step 2.6). The layers above add WhatsApp, evals and email; `ConnectorDO` adds the Slack ingress and delivery RPC methods.
 */
export abstract class ConnectorActorBase extends PlacedActor<null> {
  protected activeMailOrganization: Promise<void> | null = null;

  protected activeCaseWorkDrain: Promise<void> | null = null;

  protected caseWorkDrain: ConnectorCaseWorkDrain | null = null;

  /**
   * The Session of each Slack turn that streams now, by turn id. A reply to a
   * busy Case can steer that turn (Plan 71). It lives in memory: after a
   * restart, replies wait for the next turn as before.
   */
  protected readonly liveSlackTurns = new Map<string, LiveSlackTurn>();

  /**
   * The start of each side Case that runs now, by proposal (Plan 74). A
   * second click waits for the first start, so one start posts one thread.
   */
  protected readonly sideCaseStarts = new Map<
    string,
    Promise<SlackSideCaseStartOutcome>
  >();

  protected readonly executions = new Set<
    Promise<Result<null, ActorExportError>>
  >();

  protected executionQuiescence: Promise<
    Result<null, ActorExportError>
  > | null = null;

  /**
   * One in-flight mutation per proposal. Dispatch, resolve, dispose, and the
   * maintenance sweep all await Gmail mid-flight, and the Workers runtime
   * interleaves requests at those awaits — so two operators approving the
   * same proposal together would otherwise both pass the sent check and both
   * send. Serialising per proposal makes the second caller re-read state the
   * first already wrote and return idempotently.
   */
  protected readonly emailProposalWork =
    createKeyedContinueSerialQueue<string>();

  /**
   * Names this instance of the Actor on the reply turns it claims. One
   * instance runs at a time, so a claim under another name is from an
   * instance that stopped.
   */
  protected readonly emailReplyTurnOwner = crypto.randomUUID();

  protected readonly runningEmailReplyTurns = new Set<string>();

  protected readonly emailMailboxWork = createContinueSerialQueue();

  protected createSchema(): void {
    createActorActivationSchema(this.ctx.storage.sql);
    createActorImportSchema(this.ctx.storage.sql);
    createActorExecutionBarrierSchema(this.ctx.storage.sql);
    createConnectorSchema(this.ctx.storage.sql);
    this.ctx.storage.transactionSync(
      createConnectorCaseWorkSchema.bind(null, this.ctx.storage.sql),
    );
    createConnectorSlackStreamSchema(this.ctx.storage.sql);
    createConnectorEmailSchema(this.ctx.storage.sql);
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

  /**
   * This Connector as its own drain uses it for one item. The drain holds the
   * scope admitted for that item against the directory, so these calls do not
   * resolve the scope again. Each reads the regional fence and the local
   * barrier immediately before its write.
   */
  protected caseWorkConnector(
    scope: OrganisationExecutionScope,
  ): OngoingCaseWalkingConnector {
    return {
      acceptIngress: this.acceptIngressAtScope.bind(this, scope),
      deliver: this.deliverAtScope.bind(this, scope),
      streamCaseTurn: this.streamCaseTurnAtScope.bind(this, scope),
      warmActorSlots:
        this.env.SATYR_WARM_ACTOR_SLOTS === "on"
          ? connectorWarmActorSlots(
              this.ctx.storage,
              scope.organisationId,
              scope.placement,
            )
          : undefined,
    };
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
  ): ReturnType<ConnectorDO["acceptIngress"]> {
    return this.acceptAdmittedIngress(this.admitAtScope.bind(this, scope), raw);
  }

  protected async acceptAdmittedIngress(
    admit: ConnectorAdmission,
    raw: unknown,
  ): ReturnType<ConnectorDO["acceptIngress"]> {
    const input = parseIngressRequest(raw);
    if (input === null) return invalid("connector_ingress_invalid");
    if ((await admit(input.identity)) === null)
      return invalid("connector_placement_conflict");
    return this.ctx.storage.transactionSync(
      acceptIngress.bind(null, this.ctx.storage.sql, input),
    );
  }

  /** A start that waits for the start before it, which it then repeats. */
  protected async startSideCaseAfter(
    earlier: Promise<SlackSideCaseStartOutcome> | null,
    context: Parameters<typeof startSlackSideCase>[0],
    input: Parameters<typeof startSlackSideCase>[1],
  ): Promise<SlackSideCaseStartOutcome> {
    if (earlier !== null) await earlier.catch(ignoreEarlierSideCaseStart);
    return this.trackExecution(
      startSlackSideCase.bind(null, context, input, Date.now()),
    );
  }

  protected streamCaseTurnAtScope(
    scope: OrganisationExecutionScope,
    raw: unknown,
    release: ConnectorCaseStreamRelease,
  ): Promise<
    Result<
      { readonly finalMessage: string; readonly canonicalMessage: string },
      ConnectorCaseTurnStreamError
    >
  > {
    return this.trackExecution(
      this.prepareCaseTurnStream.bind(
        this,
        this.admitAtScope.bind(this, scope),
        raw,
        release,
      ),
    );
  }

  protected async prepareCaseTurnStream(
    admit: ConnectorAdmission,
    raw: unknown,
    release: ConnectorCaseStreamRelease,
  ): Promise<
    Result<
      { readonly finalMessage: string; readonly canonicalMessage: string },
      ConnectorCaseTurnStreamError
    >
  > {
    const input = parseConnectorCaseTurnStreamInput(raw);
    if (input === null)
      return {
        ok: false,
        error: { kind: "operational", code: "connector_stream_input_invalid" },
      };
    const scope = await admit(input.identity);
    if (scope === null)
      return {
        ok: false,
        error: { kind: "operational", code: "connector_placement_conflict" },
      };
    const identity = this.ctx.storage.transactionSync(
      ensureConnectorIdentity.bind(null, this.ctx.storage.sql, input.identity),
    );
    if (!identity.ok)
      return {
        ok: false,
        error: { kind: "operational", code: identity.error.code },
      };
    const session = sessionActorStub(
      this.env.SESSION,
      input.sessionRoute.physicalObjectName,
      input.sessionRoute.placement,
    );
    this.liveSlackTurns.set(input.turnId, {
      sessionId: input.sessionId,
      sessionRoute: input.sessionRoute,
    });
    // A reply that waits for this Case may steer the turn now.
    this.caseWorkDrain?.accept(null);
    let result: Awaited<ReturnType<typeof streamConnectorCaseTurn>>;
    try {
      result = await streamConnectorCaseTurn({
        storage: this.ctx.storage,
        env: this.env,
        scope,
        session,
        stream: input,
        release,
      });
    } finally {
      this.liveSlackTurns.delete(input.turnId);
    }
    // A stream that returns a result read the fence after its last wait and
    // has only written this Connector's storage since. Export can still close
    // local admission in between.
    if (result.ok && !actorExecutionAdmissionOpen(this.ctx.storage.sql))
      return {
        ok: false,
        error: { kind: "operational", code: "connector_placement_conflict" },
      };
    return result;
  }

  protected deliverAtScope(
    scope: OrganisationExecutionScope,
    raw: unknown,
  ): ReturnType<ConnectorDO["deliver"]> {
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
    // The route of the bot credential decides nothing and reads no fence.
    // Under a held scope it starts beside the admission. The post uses it
    // only for the delivery it was read for. The credential's last reads
    // follow the claim, beside the fence read of the post.
    const startedRoute =
      heldScope !== null &&
      heldScope.organisationId === input.identity.organisationId
        ? startSlackThreadCredentialRoute(this.env, input)
        : null;
    void startedRoute?.catch(ignoreUnusedCredentialRoute);
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
    const delivered = await deliverSlackOutput(
      this.env,
      this.ctx.storage.sql,
      claimedInput,
      scope,
      scope === heldScope &&
        JSON.stringify(claimedInput.delivery.address) ===
          JSON.stringify(input.delivery.address)
        ? startedRoute
        : null,
    );
    return this.ctx.storage.transactionSync(
      finalizeDelivery.bind(
        null,
        this.ctx.storage.sql,
        claimedInput,
        claim.value.attempt,
        delivered,
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
    const watchCleanupAt = nextEmailWatchCleanupAt(this.ctx.storage.sql);
    if (watchCleanupAt !== null && watchCleanupAt <= Date.now()) {
      await this.emailMailboxWork.enqueue(
        stopConnectorEmailWatch.bind(null, {
          env: this.env,
          storage: this.ctx.storage,
          scope: admission.scope,
          now: Date.now(),
          fetcher: runtimeFetch,
        }),
      );
    }
    const active = () =>
      isActorExecutionActive(this.ctx.storage.sql, admission.scope);
    if (!(await active())) return;
    this.startCaseWorkDrain();
    // Each step runs on its own (Refactor 15, S3): a failed step does not
    // stop the others, and the alarm comes back for it after a backoff. A
    // step does nothing once the Actor no longer serves the Organisation.
    const whenActive =
      (run: () => Promise<unknown>) => async (): Promise<void> => {
        if (await active()) await run();
      };
    const failed = [
      ...(await runAlarmStepsTogether("connector", [
        {
          name: "email_evaluation",
          run: whenActive(() => this.runDueEmailEvaluation(admission.scope)),
        },
        {
          name: "whatsapp_turns",
          run: whenActive(() => this.runDueWhatsAppTurns(admission.scope)),
        },
      ])),
      ...(await runAlarmSteps("connector", [
        {
          name: "email_case_context_discovery",
          run: whenActive(() =>
            this.runDueEmailCaseContextDiscoveries(admission.scope),
          ),
        },
        {
          name: "email_correction_learning",
          run: whenActive(() =>
            this.runDueEmailCorrectionLearning(admission.scope),
          ),
        },
        {
          name: "eval_work",
          run: whenActive(() => this.runDueEvalWork(admission.scope)),
        },
        {
          name: "mail_organization",
          run: whenActive(() => this.runDueMailOrganization(admission.scope)),
        },
        {
          name: "email_proposal_maintenance",
          run: whenActive(() =>
            runEmailProposalMaintenance({
              scope: admission.scope,
              sql: this.ctx.storage.sql,
              env: this.env,
              now: Date.now(),
              fetcher: runtimeFetch,
              withProposalLock: this.withEmailProposalLock.bind(this),
            }),
          ),
        },
        {
          name: "operational_email",
          run: whenActive(() =>
            this.emailMailboxWork.enqueue(
              maintainOperationalEmail.bind(
                null,
                this.ctx.storage,
                admission.scope,
              ),
            ),
          ),
        },
      ])),
    ];
    if (!(await active())) return;
    await armConnectorAlarm(this.ctx.storage);
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

  protected async runDueMailOrganization(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    if (this.activeMailOrganization !== null)
      return this.activeMailOrganization;
    this.activeMailOrganization = runMailOrganization({
      scope,
      env: this.env,
      storage: this.ctx.storage,
    });
    try {
      await this.activeMailOrganization;
    } finally {
      this.activeMailOrganization = null;
    }
  }

  protected async runDueEmailEvaluation(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    try {
      // Admission queues the reply turn each admitted burst is owed.
      await runConnectorEmailEvaluation({
        scope,
        storage: this.ctx.storage,
        env: this.env,
        now: Date.now(),
        fetcher: runtimeFetch,
      });
    } catch (error) {
      traceWarn("connector.email_evaluation_failed", {
        requestId: newRequestId(),
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    if (!(await isActorExecutionActive(this.ctx.storage.sql, scope))) return;
    await this.runDueEmailReplyTurns(scope);
  }

  /**
   * Runs each reply turn that is due. The work was written with the mail's
   * admission, so a turn this instance did not finish is run again: by its
   * retry time, or at once by the instance that replaces this one. A turn is
   * claimed before it runs and is never run twice at the same time.
   */
  protected async runDueEmailReplyTurns(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
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
      const work = this.ctx.storage.transactionSync(
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
        this.ctx.storage.transactionSync(
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
      const retried = this.ctx.storage.transactionSync(
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

  protected async runEmailReplyTurn(
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
    if (!(await isActorExecutionActive(this.ctx.storage.sql, scope)))
      return { kind: "retry", reason: "connector_placement_conflict" };
    if (binding === null)
      return { kind: "retry", reason: "mailbox_binding_missing" };
    const turn = await processEmailThreadTurn(this.env, {
      scope,
      connectorSql: this.ctx.storage.sql,
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
  protected async runDueEmailCorrectionLearning(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    for (let processed = 0; processed < 3; processed += 1) {
      if (!(await isActorExecutionActive(this.ctx.storage.sql, scope))) return;
      const now = Date.now();
      const work = this.ctx.storage.transactionSync(
        claimDueEmailCorrectionLearning.bind(null, this.ctx.storage.sql, now),
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
      if (!(await isActorExecutionActive(this.ctx.storage.sql, scope))) return;
      if (outcome.kind === "settled") {
        this.ctx.storage.transactionSync(
          completeEmailCorrectionLearning.bind(
            null,
            this.ctx.storage.sql,
            work,
          ),
        );
        continue;
      }
      const retried = this.ctx.storage.transactionSync(
        retryEmailCorrectionLearning.bind(null, this.ctx.storage.sql, {
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

  protected async learnFromEmailCorrection(
    scope: OrganisationExecutionScope,
    work: EmailCorrectionLearningWork,
    now: number,
  ): Promise<
    | Readonly<{ kind: "settled"; reason?: never }>
    | Readonly<{ kind: "retry"; reason: string }>
  > {
    const sql = this.ctx.storage.sql;
    const corrected = await readCorrectedEmailReply({
      sql,
      env: this.env,
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
    const learned = await processEmailCorrectionLearning(this.env, {
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

  protected async runDueEvalWork(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    for (let processed = 0; processed < 4; processed += 1) {
      if (!(await isActorExecutionActive(sql, scope))) return;
      const now = Date.now();
      const claim = this.ctx.storage.transactionSync(
        claimDueEvalTask.bind(null, sql, now),
      );
      if (claim === null) break;
      // A task that throws leaves its turn's end unknown. The next claim
      // reads what it left on the Case.
      const end = await this.runEvalTask(scope, claim, now).catch(
        (): EvalTaskEnd => ({
          kind: "deferred",
          retryAt: now + 30_000,
          exhausted: { kind: "indeterminate", code: "eval_task_failed" },
        }),
      );
      if (end.kind === "inactive") return;
      if (end.kind !== "deferred") continue;
      const key = { runId: claim.run.runId, taskId: claim.task.taskId };
      if (claim.attempt >= EVAL_TASK_MAX_CLAIMS) {
        this.ctx.storage.transactionSync(
          settleEvalTask.bind(null, sql, {
            ...key,
            result: {
              outcome: end.exhausted,
              execution: null,
              pins: null,
              totalTokens: null,
            },
            flowLabel: null,
          }),
        );
        traceWarn("connector.eval_task_claims_exhausted", {
          requestId: newRequestId(),
          reason: end.exhausted.kind,
        });
        continue;
      }
      this.ctx.storage.transactionSync(
        deferEvalTask.bind(null, sql, { ...key, availableAt: end.retryAt }),
      );
    }
    await this.publishSettledEvalRuns(scope);
  }

  protected async runEvalTask(
    scope: OrganisationExecutionScope,
    claim: ClaimedEvalTask,
    now: number,
  ): Promise<EvalTaskEnd> {
    const sql = this.ctx.storage.sql;
    const agentUnavailable = (): EvalTaskEnd => {
      const outcome = {
        kind: "unavailable",
        reason: "agent_unavailable",
      } as const;
      settleEvalTask(sql, {
        runId: claim.run.runId,
        taskId: claim.task.taskId,
        result: { outcome, execution: null, pins: null, totalTokens: null },
        flowLabel: null,
      });
      return { kind: "settled", outcome };
    };
    const runtime = readEmailRuntime(sql);
    if (runtime === null || runtime.disabledAt !== null)
      return agentUnavailable();
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
      return { kind: "inactive" };
    if (binding === null) return agentUnavailable();
    return processEvalTask(this.env, {
      scope,
      connectorSql: sql,
      organisationId: runtime.organisationId,
      integrationAccountId: runtime.integrationAccountId,
      mailboxBindingId: binding.mailboxBindingId,
      bindingRevision: binding.currentRevision,
      mailboxPolicyVersion: runtime.policyVersion,
      dailyTokenBudget: runtime.limits.dailyTokenBudget,
      claim,
      now,
    });
  }

  /**
   * Publishes each run whose tasks have all settled. The OrganisationActor
   * receives the settled result alone. A run it cannot take now is tried
   * again later, with the same result.
   */
  protected async publishSettledEvalRuns(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    for (let published = 0; published < 4; published += 1) {
      const now = Date.now();
      const settled = this.ctx.storage.transactionSync(
        readSettledEvalRun.bind(null, sql, now),
      );
      if (settled === null) return;
      const runId = settled.result.runId;
      const outcome = await publishEvalRunResult({
        env: this.env,
        execution: scope,
        organisationId: scope.organisationId,
        result: settled.result,
        flowLabels: settled.flowLabels,
      }).catch(() => "unavailable" as const);
      if (!(await isActorExecutionActive(sql, scope))) return;
      if (outcome === "unavailable") {
        this.ctx.storage.transactionSync(
          deferEvalRunPublication.bind(null, sql, {
            runId,
            publishAfter: now + 60_000,
          }),
        );
        continue;
      }
      if (outcome === "refused")
        traceWarn("connector.eval_run_result_refused", {
          requestId: newRequestId(),
          reason: "eval_run_result_refused",
        });
      this.ctx.storage.transactionSync(
        markEvalRunPublished.bind(null, sql, { runId, now }),
      );
    }
  }

  protected async runDueEmailCaseContextDiscoveries(
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    for (let processed = 0; processed < 5; processed += 1) {
      if (!(await isActorExecutionActive(this.ctx.storage.sql, scope))) return;
      const now = Date.now();
      const work = this.ctx.storage.transactionSync(
        dueEmailCaseContextDiscovery.bind(null, this.ctx.storage.sql, now),
      );
      if (work === null) return;
      const outcome = await runEmailCaseContextDiscoveryWork({
        scope,
        env: this.env,
        sql: this.ctx.storage.sql,
        work,
        now,
      });
      if (!(await isActorExecutionActive(this.ctx.storage.sql, scope))) return;
      if (outcome.kind === "evaluated") {
        traceLog("connector.email_case_context_discovery_evaluated", {
          requestId: newRequestId(),
          recorded: outcome.recorded,
        });
      }
      const finalized = this.ctx.storage.transactionSync(
        finalizeEmailCaseContextDiscovery.bind(
          null,
          this.ctx.storage.sql,
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

  protected async withEmailProposalLock<T>(
    proposalId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.emailProposalWork.enqueue(proposalId, task);
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
      connectorFor: this.caseWorkConnector.bind(this),
      liveSlackTurn: this.liveSlackTurn.bind(this),
    });
    this.caseWorkDrain = drain;
    this.activeCaseWorkDrain = this.runCaseWorkDrain(drain, admitted);
    this.ctx.waitUntil(this.activeCaseWorkDrain);
  }

  protected liveSlackTurn(turnId: string): LiveSlackTurn | null {
    return this.liveSlackTurns.get(turnId) ?? null;
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
