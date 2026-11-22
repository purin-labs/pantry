import type { Env } from "@purin-labs/kernel/env";
import type { SessionActorStub } from "../actor-stubs";
import { newRequestId, parseSessionId } from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { actorExecutionAdmissionOpen } from "../actor-execution-quiescence";
import { admitActorRecovery } from "../actor-activation";
import { actorStub } from "../actor-stubs";
import {
  claimConnectorCaseWork,
  parkSteeredCaseWork,
  pendingCaseWorkForCases,
  settleSteeredCaseWork,
  steeredCaseWorkToSettle,
  unparkRefusedSteer,
  finalizeConnectorCaseWork,
  type CaseWorkCommand,
  type ConnectorCaseWorkClaim,
} from "../connector-case-work";
import { scheduleCaseWorkAlarm } from "./alarm";
import { steerAnswerLost } from "./steer-fault";
import { caseWorkResult, readConnectorIdentity } from "./delivery";
import { CASE_WORK_CONCURRENCY } from "./support";
import type {
  CaseWorkChannel,
  ChannelAlarmDue,
  LiveCaseTurn,
} from "./channel-adapter";

type Claim = ConnectorCaseWorkClaim<CaseWorkCommand>;

/**
 * Runs the Case work that a Connector accepted. The channel of the work
 * runs each turn; the drain claims, settles and steers.
 */
export class ConnectorCaseWorkDrain {
  /** The Cases that have a message in flight. */
  private readonly busyCases = new Set<string>();
  /** The claim in flight for each busy Case. */
  private readonly runningClaims = new Map<string, Claim>();
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
      /** The channel whose messages are the Case work. */
      readonly channel: CaseWorkChannel<CaseWorkCommand>;
      /** The due times of the work of each channel, for the alarm. */
      readonly alarmDue: readonly ChannelAlarmDue[];
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
      await scheduleCaseWorkAlarm(
        this.input.storage,
        this.input.alarmDue,
        newRequestId(),
      );
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
    const { storage, channel } = this.input;
    this.acceptedSinceLaunch = false;
    while (
      this.state === "open" &&
      this.busyCases.size < CASE_WORK_CONCURRENCY &&
      actorExecutionAdmissionOpen(storage.sql)
    ) {
      let claim: ReturnType<typeof claimConnectorCaseWork<CaseWorkCommand>>;
      try {
        claim = storage.transactionSync(
          claimConnectorCaseWork.bind(
            null,
            channel.codec,
            storage.sql,
            Date.now(),
            [...this.busyCases],
          ),
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
      const eventId = channel.codec.eventId(claimed.command);
      traceLog("connector.case_work_claimed", {
        requestId: claimed.command.requestId,
        event_id: eventId,
        attempt: claimed.attempt,
        elapsed_ms: Date.now() - claimed.command.receivedAt,
        cases_in_flight: this.busyCases.size + 1,
      });
      this.steeringTried.delete(eventId);
      this.busyCases.add(claimed.command.target.caseId);
      this.runningClaims.set(claimed.command.target.caseId, claimed);
      void this.runClaimed(claimed, scope);
    }
  }

  /** Run one claimed item to its receipt. It never rejects. */
  private async runClaimed(
    claimed: Claim,
    scope: OrganisationExecutionScope,
  ): Promise<void> {
    const { storage, channel } = this.input;
    try {
      const [scheduled, result] = await Promise.all([
        scheduleCaseWorkAlarm(
          storage,
          this.input.alarmDue,
          claimed.command.requestId,
        ),
        claimed.work.kind === "turn"
          ? channel.runTurn(claimed, scope, readConnectorIdentity(storage.sql))
          : channel.tellAttemptsExhausted(
              claimed,
              claimed.work,
              scope,
              readConnectorIdentity(storage.sql),
            ),
      ]);
      if (!scheduled.ok) {
        this.halt("fault");
        return;
      }
      traceLog("connector.case_work_finished", {
        requestId: claimed.command.requestId,
        event_id: channel.codec.eventId(claimed.command),
        outcome: result.kind,
        reason: result.kind === "completed" ? null : result.reason,
        elapsed_ms: Date.now() - claimed.command.receivedAt,
      });
      const finalized = storage.transactionSync(
        finalizeConnectorCaseWork.bind(
          null,
          channel.codec,
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
    const { storage, channel } = this.input;
    for (const reply of pendingCaseWorkForCases(
      channel.codec,
      storage.sql,
      [...this.runningClaims.keys()],
      Date.now(),
    )) {
      if (this.steeringTried.has(reply.eventId)) continue;
      const running = this.runningClaims.get(reply.command.target.caseId);
      if (running === undefined || running.work.kind !== "turn") continue;
      const live = channel.liveTurn(running.command);
      if (live === null) continue;
      this.steeringTried.add(reply.eventId);
      if (!channel.replyMaySteer(reply.command, running.command)) continue;
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
    reply: Readonly<{ eventId: string; command: CaseWorkCommand }>,
    running: Claim,
    live: LiveCaseTurn,
  ): Promise<void> {
    const { storage, env, channel } = this.input;
    const input = channel.steerInput(reply.command);
    if (input === null) return;
    const runningEventId = channel.codec.eventId(running.command);
    const parked = storage.transactionSync(
      parkSteeredCaseWork.bind(null, storage.sql, {
        eventId: reply.eventId,
        runningEventId,
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
        requester: { kind: "person", personId: input.requesterPersonId },
        text: input.text,
        message: input.message,
      });
    } catch {
      // The Session may have taken the reply: the turn's end settles it.
      return;
    }
    if (!steered.ok || steered.value.kind !== "accepted") {
      storage.transactionSync(
        unparkRefusedSteer.bind(
          null,
          channel.codec,
          storage.sql,
          reply.eventId,
        ),
      );
      return;
    }
    if (await steerAnswerLost(env, storage)) return;
    traceLog("connector.slack_reply_steered", {
      requestId: reply.command.requestId,
      event_id: reply.eventId,
      running_event_id: runningEventId,
      parked,
    });
  }

  /**
   * Settle the steered replies whose turn has ended: a reply that the turn
   * read gets its receipt, and a withdrawn one returns to the queue. A reply
   * whose Session does not answer waits for a later pass. Never rejects.
   */
  private async settleSteeredReplies(): Promise<void> {
    const { storage, env, channel } = this.input;
    for (const steered of steeredCaseWorkToSettle(channel.codec, storage.sql)) {
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
          channel.codec,
          storage.sql,
          steered.eventId,
          settled,
          Date.now(),
        ),
      );
      if (settled === "placed" && steered.command !== null)
        await channel.steerPlaced(steered.command);
    }
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
