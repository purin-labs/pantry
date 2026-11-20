import type { Env, SessionActorStub } from "../../env";
import { resolveActiveSlackThreadCredential } from "../../credential-vault";
import { newRequestId, parseSessionId } from "../../ids";
import { slackAuthoredText } from "../../slack/events";
import { traceLog, traceWarn } from "../../observability";
import type { SlackCaseCommand } from "../../slack/case-command-message";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { actorExecutionAdmissionOpen } from "../actor-execution-quiescence";
import { resolveConfiguredSlackInstallationIdentity } from "../../slack/installation-identity";
import { admitActorRecovery } from "../actor-activation";
import { actorStub } from "../actor-stubs";
import { buildSlackUserMessage } from "../../slack/user-message";
import {
  CASE_WORK_ATTEMPTS_EXHAUSTED,
  CASE_WORK_EXHAUSTED_NOTICE_UNDELIVERED,
  claimConnectorCaseWork,
  parkSteeredCaseWork,
  pendingCaseWorkForCases,
  settleSteeredCaseWork,
  steeredCaseWorkToSettle,
  unparkRefusedSteer,
  finalizeConnectorCaseWork,
  type ConnectorCaseWorkClaim,
} from "../connector-case-work";
import {
  connectorSlackStreamPostedFailure,
  stopOpenConnectorSlackStream,
  slackCaseStreamId,
  slackCaseTurnId,
} from "../connector-slack-stream";
import {
  deliverSlackAttemptsExhaustedNotice,
  processScheduledSlackCaseMessage,
  slackCaseIngressId,
  type SlackCaseProcessingResult,
} from "../../slack/case-processing";
import type { OngoingCaseWalkingConnector } from "../case-walking-path";
import { setSlackThreadStatus } from "../../slack/messages";
import { errorMessage } from "@purin-labs/std";
import { scheduleCaseWorkAlarm } from "./alarm";
import { steerAnswerLost } from "./steer-fault";
import {
  caseWorkCommandAtPlacement,
  caseWorkResult,
  connectorIdentityForClaim,
} from "./delivery";
import {
  CASE_WORK_CONCURRENCY,
  type LiveSlackTurn,
  replyMaySteer,
} from "./support";
import type { Variant } from "@purin-labs/type-utils";

export class ConnectorCaseWorkDrain {
  /** The Cases that have a message in flight. */
  private readonly busyCases = new Set<string>();
  /** The claim in flight for each busy Case. */
  private readonly runningClaims = new Map<string, ConnectorCaseWorkClaim>();
  /** Replies that already had their chance to steer a running turn. */
  private readonly steeringTried = new Set<string>();
  /**
   * The steer calls in flight for each busy Case. The Case stays busy until
   * they end, so the drain never claims a reply that a turn may have read.
   */
  private readonly steeringCalls = new Map<string, Set<Promise<void>>>();
  private state: "open" | "inactive" | "fault" | "closed" = "open";
  private failure: { readonly error: unknown } | null = null;
  private acceptedSinceLaunch = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly input: {
      readonly storage: DurableObjectStorage;
      readonly env: Env;
      /** The Connector as one item uses it, under the scope admitted for it. */
      readonly connectorFor: (
        scope: OrganisationExecutionScope,
      ) => OngoingCaseWalkingConnector;
      /** The Session of a Slack turn that streams now. */
      readonly liveSlackTurn: (turnId: string) => LiveSlackTurn | null;
    },
  ) {}

  /**
   * Take in newly accepted work. A call that was admitted, read the regional
   * fence and has not waited since passes its scope, and its work starts at
   * once. False means this drain has ended and another must be started.
   */
  accept(admitted: OrganisationExecutionScope | null): boolean {
    if (this.state === "closed") return false;
    if (admitted !== null) {
      this.launch(admitted);
      return true;
    }
    // The drain admits itself for this work on its next pass.
    this.acceptedSinceLaunch = true;
    this.signal();
    return true;
  }

  async run(admitted: OrganisationExecutionScope | null): Promise<void> {
    let scope = admitted;
    for (;;) {
      if (this.state === "open") {
        // Work starts only under a scope admitted for it against the
        // directory and the regional fence. The starting call's scope serves
        // the first launch only, because nothing has waited since that call
        // read the fence.
        if (scope === null) {
          const admission = await admitActorRecovery(
            this.input.env,
            this.input.storage,
          );
          if (
            admission.kind === "admitted" &&
            actorExecutionAdmissionOpen(this.input.storage.sql)
          )
            scope = admission.scope;
          else this.halt("inactive");
        }
        if (scope !== null) this.launch(scope);
        scope = null;
      }
      if (this.busyCases.size > 0) {
        await this.changed();
        continue;
      }
      if (this.state === "inactive") break;
      // A reply steered into a turn that ended while this Connector was away
      // is settled once nothing runs.
      await this.settleSteeredReplies();
      // Nothing runs. Leave the alarm at the next due item.
      await scheduleCaseWorkAlarm(this.input.storage, newRequestId());
      if (
        this.state === "open" &&
        (this.busyCases.size > 0 || this.acceptedSinceLaunch)
      )
        continue;
      break;
    }
    this.state = "closed";
    if (this.failure !== null) throw this.failure.error;
  }

  /**
   * Claim and start every due item whose Case is idle. It runs without a
   * wait, so the fence its caller read is still the latest observation.
   */
  private launch(scope: OrganisationExecutionScope): void {
    const { storage } = this.input;
    this.acceptedSinceLaunch = false;
    while (
      this.state === "open" &&
      this.busyCases.size < CASE_WORK_CONCURRENCY &&
      actorExecutionAdmissionOpen(storage.sql)
    ) {
      let claim: ReturnType<typeof claimConnectorCaseWork>;
      try {
        claim = storage.transactionSync(
          claimConnectorCaseWork.bind(null, storage.sql, Date.now(), [
            ...this.busyCases,
          ]),
        );
      } catch (error) {
        // An accepting call may be the caller. Its work is already accepted,
        // so a failed claim ends this drain and never the call.
        this.failure ??= { error };
        this.halt("fault");
        return;
      }
      if (!claim.ok) {
        this.halt("fault");
        return;
      }
      const claimed = claim.value.result;
      traceLog("connector.case_work_claim_query", {
        requestId:
          claimed === null ? newRequestId() : claimed.command.requestId,
        rows_read: claim.value.rowsRead,
        work_found: claimed !== null,
      });
      if (claimed === null) {
        this.steerWaitingReplies();
        return;
      }
      traceLog("connector.case_work_claimed", {
        requestId: claimed.command.requestId,
        event_id: claimed.command.event.eventId,
        attempt: claimed.attempt,
        elapsed_ms: Date.now() - claimed.command.receivedAt,
        cases_in_flight: this.busyCases.size + 1,
      });
      this.steeringTried.delete(claimed.command.event.eventId);
      this.busyCases.add(claimed.command.target.caseId);
      this.runningClaims.set(claimed.command.target.caseId, claimed);
      void this.runClaimed(claimed, scope);
    }
  }

  /** Run one claimed item to its receipt. It never rejects. */
  private async runClaimed(
    claimed: ConnectorCaseWorkClaim,
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const { storage } = this.input;
    try {
      const [scheduled, result] = await Promise.all([
        scheduleCaseWorkAlarm(storage, claimed.command.requestId),
        claimed.work.kind === "turn"
          ? processScheduledSlackCaseMessage(
              this.input.env,
              caseWorkCommandAtPlacement(claimed.command, scope),
              claimed.attempt,
              connectorIdentityForClaim(storage.sql, claimed),
              this.input.connectorFor(scope),
              scope,
            )
          : this.tellAttemptsExhausted(claimed, claimed.work, scope),
      ]);
      if (!scheduled.ok) {
        this.halt("fault");
        return;
      }
      traceLog("connector.case_work_finished", {
        requestId: claimed.command.requestId,
        event_id: claimed.command.event.eventId,
        outcome: result.kind,
        reason: result.kind === "completed" ? null : result.reason,
        elapsed_ms: Date.now() - claimed.command.receivedAt,
      });
      const finalized = storage.transactionSync(
        finalizeConnectorCaseWork.bind(
          null,
          storage.sql,
          claimed,
          caseWorkResult(result),
        ),
      );
      if (!finalized.ok) this.halt("fault");
    } catch (error) {
      // The item keeps its lease and is claimed again when the lease ends.
      this.failure ??= { error };
      this.halt("fault");
    } finally {
      this.runningClaims.delete(claimed.command.target.caseId);
      await Promise.all(
        this.steeringCalls.get(claimed.command.target.caseId) ?? [],
      );
      this.steeringCalls.delete(claimed.command.target.caseId);
      await this.settleSteeredReplies();
      this.busyCases.delete(claimed.command.target.caseId);
      this.signal();
    }
  }

  /**
   * Offer each waiting reply of a busy Case to the Case's running turn
   * (Plan 71). Only a text reply from the turn's requester, to a turn that
   * streams now, can steer it. Each reply has one chance; a reply that does
   * not join the turn waits for the next turn, as before.
   */
  private steerWaitingReplies(): void {
    const { storage } = this.input;
    for (const reply of pendingCaseWorkForCases(
      storage.sql,
      [...this.runningClaims.keys()],
      Date.now(),
    )) {
      if (this.steeringTried.has(reply.eventId)) continue;
      const running = this.runningClaims.get(reply.command.target.caseId);
      if (running === undefined || running.work.kind !== "turn") continue;
      const live = this.input.liveSlackTurn(
        slackCaseTurnId(slackCaseIngressId(running.command)),
      );
      if (live === null) continue;
      this.steeringTried.add(reply.eventId);
      if (!replyMaySteer(reply.command, running.command)) continue;
      const caseId = reply.command.target.caseId;
      const calls = this.steeringCalls.get(caseId) ?? new Set();
      this.steeringCalls.set(caseId, calls);
      const call = this.steerReply(reply, running, live);
      calls.add(call);
      void call.finally(calls.delete.bind(calls, call));
    }
  }

  /**
   * Never rejects: a reply that does not join the turn returns to the queue.
   *
   * The record of the steer comes first, as an intent (Refactor 15,
   * refactor 9): the reply leaves the queue before the Session can read it.
   * A process loss after the Session's answer then leaves the record, and
   * the turn's end settles it from what the Session says, so the reply
   * never runs again as a turn of its own. A refused steer returns the reply
   * to its place in the queue; a call with no answer keeps the record.
   */
  private async steerReply(
    reply: Readonly<{ eventId: string; command: SlackCaseCommand }>,
    running: ConnectorCaseWorkClaim,
    live: LiveSlackTurn,
  ): Promise<void> {
    const { storage, env } = this.input;
    const message = buildSlackUserMessage(reply.command.event, []);
    if (!message.ok) return;
    const parked = storage.transactionSync(
      parkSteeredCaseWork.bind(null, storage.sql, {
        eventId: reply.eventId,
        runningEventId: running.command.event.eventId,
        sessionId: String(live.sessionId),
        sessionRoute: live.sessionRoute,
        steeredAt: Date.now(),
      }),
    );
    if (!parked) return;
    let steered: Awaited<
      ReturnType<SessionActorStub["steerCanonicalEmbeddedHarnessTurn"]>
    >;
    try {
      steered = await actorStub(
        env.SESSION,
        live.sessionRoute.physicalObjectName,
        live.sessionRoute.placement,
      ).steerCanonicalEmbeddedHarnessTurn({
        organisationId: reply.command.organisationId,
        sessionId: live.sessionId,
        requestId: reply.command.requestId,
        requester: {
          kind: "person",
          personId: String(reply.command.principalId),
        },
        text: slackAuthoredText(reply.command.event.authored).trim(),
        message: message.value.message,
      });
    } catch {
      // The Session may have taken the reply: the turn's end settles it.
      return;
    }
    if (!steered.ok || steered.value.kind !== "accepted") {
      storage.transactionSync(
        unparkRefusedSteer.bind(null, storage.sql, reply.eventId),
      );
      return;
    }
    if (await steerAnswerLost(env, storage)) return;
    traceLog("connector.slack_reply_steered", {
      requestId: reply.command.requestId,
      event_id: reply.eventId,
      running_event_id: running.command.event.eventId,
      parked,
    });
  }

  /**
   * Settle the steered replies whose turn has ended: a reply that the turn
   * read gets its receipt, and a withdrawn one returns to the queue. A reply
   * whose Session does not answer waits for a later pass. Never rejects.
   */
  private async settleSteeredReplies(): Promise<void> {
    const { storage, env } = this.input;
    for (const steered of steeredCaseWorkToSettle(storage.sql)) {
      let outcome: "placed" | "withdrawn" | null = null;
      const sessionId = parseSessionId(steered.sessionId);
      if (
        steered.command === null ||
        steered.sessionRoute === null ||
        !sessionId.ok
      )
        outcome = "withdrawn";
      else {
        try {
          const read = await actorStub(
            env.SESSION,
            steered.sessionRoute.physicalObjectName,
            steered.sessionRoute.placement,
          ).readSteeringInputState({
            organisationId: steered.command.organisationId,
            sessionId: sessionId.value,
            requestId: steered.command.requestId,
          });
          if (read.ok)
            outcome =
              read.value.state === "placed"
                ? "placed"
                : read.value.state === "withdrawn" ||
                    read.value.state === "missing"
                  ? "withdrawn"
                  : null;
        } catch {
          outcome = null;
        }
      }
      if (outcome === null) continue;
      this.steeringTried.delete(steered.eventId);
      const settled = outcome;
      storage.transactionSync(() =>
        settleSteeredCaseWork(
          storage.sql,
          steered.eventId,
          settled,
          Date.now(),
        ),
      );
      if (settled === "placed" && steered.command !== null)
        await this.clearSteeredReplyStatus(steered.command);
    }
  }

  /**
   * Ingress shows "is thinking…" for each message that it accepts. A reply
   * that steered a turn gets no answer of its own, so nothing clears that
   * status: clear it once the turn has read the reply. Never rejects.
   */
  private async clearSteeredReplyStatus(
    command: SlackCaseCommand,
  ): Promise<void> {
    const { env } = this.input;
    const identity = resolveConfiguredSlackInstallationIdentity({
      deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
      appId: env.SLACK_APP_ID,
    });
    if (!identity.ok) return;
    try {
      const credential = await resolveActiveSlackThreadCredential({
        env,
        keys: env,
        installationIdentity: identity.value,
        organisationId: command.organisationId,
        workspaceId: command.event.workspaceId,
        channelId: command.event.channelId,
        rootMessageTs: command.event.threadTs,
      });
      if (!credential.ok || credential.value.kind !== "bearer") return;
      const cleared = await setSlackThreadStatus({
        token: credential.value.value,
        channelId: command.event.channelId,
        threadTs: command.event.threadTs,
        status: "",
      });
      if (!cleared.ok)
        traceWarn("connector.slack_steered_status_kept", {
          requestId: command.requestId,
          detail: cleared.error.detail,
        });
    } catch (error) {
      traceWarn("connector.slack_steered_status_kept", {
        requestId: command.requestId,
        detail: errorMessage(error).slice(0, 300),
      });
    }
  }

  /**
   * The message used every attempt. Its thread is told one time, and the
   * message is then settled as rejected. A thread that already holds the
   * failure text of the turn's own stream gets no second post.
   */
  private async tellAttemptsExhausted(
    claimed: ConnectorCaseWorkClaim,
    work: Variant<ConnectorCaseWorkClaim["work"], "exhausted_notice">,
    scope: OrganisationExecutionScope,
  ): Promise<SlackCaseProcessingResult> {
    const { storage } = this.input;
    const command = caseWorkCommandAtPlacement(claimed.command, scope);
    const streamId = slackCaseStreamId(slackCaseIngressId(command));
    const streamFailurePosted = connectorSlackStreamPostedFailure(
      storage.sql,
      streamId,
    );
    traceWarn("connector.case_work_attempts_exhausted", {
      requestId: command.requestId,
      event_id: command.event.eventId,
      attempt: claimed.attempt,
      last_reason: work.lastReason,
      stream_failure_posted: streamFailurePosted,
    });
    if (streamFailurePosted)
      return { kind: "rejected", reason: CASE_WORK_ATTEMPTS_EXHAUSTED };
    // A partial answer stops streaming before the notice follows it.
    await stopOpenConnectorSlackStream({
      sql: storage.sql,
      env: this.input.env,
      scope,
      streamId,
    });
    const notice = await deliverSlackAttemptsExhaustedNotice(
      command,
      connectorIdentityForClaim(storage.sql, claimed),
      this.input.connectorFor(scope),
    );
    if (notice.kind === "completed")
      return { kind: "rejected", reason: CASE_WORK_ATTEMPTS_EXHAUSTED };
    // A later claim posts the notice, unless this one was the last.
    if (notice.kind === "retry" && !work.final) return notice;
    traceWarn("connector.case_work_exhausted_notice_undelivered", {
      requestId: command.requestId,
      event_id: command.event.eventId,
      reason: notice.reason,
    });
    return { kind: "rejected", reason: CASE_WORK_EXHAUSTED_NOTICE_UNDELIVERED };
  }

  /** Stop starting work. The items in flight still run to their receipts. */
  private halt(reason: "inactive" | "fault"): void {
    if (this.state === "open") this.state = reason;
  }

  private changed(): Promise<void> {
    return new Promise(this.awaitSignal.bind(this));
  }

  private awaitSignal(resolve: () => void): void {
    this.wake = resolve;
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
