import type {
  ConnectorDelivery,
  ConnectorDeliveryReceipt,
  ConnectorIdentity,
} from "@purin-labs/contracts";
import { errorMessage } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import {
  resolveActiveSlackThreadCredential,
  type readSlackThreadCredentialRoute,
} from "../../credential-vault";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";
import {
  createSlackCaseCommand,
  type SlackCaseCommand,
} from "../../slack/case-command-message";
import {
  deliverSlackAttemptsExhaustedNotice,
  processScheduledSlackCaseMessage,
  slackCaseIngressId,
} from "../../slack/case-processing";
import { slackAuthoredText } from "../../slack/events";
import { resolveConfiguredSlackInstallationIdentity } from "../../slack/installation-identity";
import { setSlackThreadStatus } from "../../slack/messages";
import { buildSlackUserMessage } from "../../slack/user-message";
import { actorExecutionAdmissionOpen } from "../actor-execution-quiescence";
import { actorStub } from "../actor-stubs";
import type { OngoingCaseWalkingConnector } from "../case-walking-path";
import {
  CASE_WORK_ATTEMPTS_EXHAUSTED,
  CASE_WORK_EXHAUSTED_NOTICE_UNDELIVERED,
  type CaseWorkOutcome,
  type ConnectorCaseWorkClaim,
} from "../connector-case-work";
import {
  createSlackCaseWorkSchema,
  SLACK_CASE_WORK,
} from "../connector-slack-case-work";
import {
  startSlackSideCase,
  type SlackSideCaseStartOutcome,
} from "../connector-side-case";
import {
  completeConnectorSlackDelivery,
  connectorSlackStreamPostedFailure,
  createConnectorSlackStreamSchema,
  parseConnectorCaseTurnStreamInput,
  stopOpenConnectorSlackStream,
  streamConnectorCaseTurn,
} from "../connector-slack-stream";
import {
  slackCaseStreamId,
  slackCaseTurnId,
  type ConnectorCaseStreamRelease,
  type ConnectorCaseTurnStreamError,
} from "../case-turn-stream";
import { connectorWarmActorSlots } from "../warm-actor-slots";
import type {
  CaseWorkChannel,
  CaseWorkSteer,
  ChannelAdapter,
  ConnectorChannelHost,
  DeliveryChannel,
  LiveCaseTurn,
} from "./channel-adapter";
import { ensureConnectorIdentity } from "./ingress-parsers";
import {
  deliverSlackOutput,
  startSlackThreadCredentialRoute,
} from "./slack-delivery";
import type { ConnectorAdmission } from "./support";
import type {
  ConnectorDeliveryRequest,
  ConnectorDeliveryResult,
} from "./types";

type SlackThreadCredentialRoute = Awaited<
  ReturnType<typeof readSlackThreadCredentialRoute>
>;

type SlackClaim = ConnectorCaseWorkClaim<SlackCaseCommand>;

/**
 * Slack as a channel of the Connector. Slack messages are the Connector's
 * Case work, and Slack threads take its Case outputs. A Slack turn streams
 * its answer into its thread, and a reply can steer it while it streams.
 */
export class SlackConnectorChannel
  implements
    ChannelAdapter,
    CaseWorkChannel<SlackCaseCommand>,
    DeliveryChannel<SlackThreadCredentialRoute>
{
  readonly name = "slack";

  readonly codec = SLACK_CASE_WORK;

  /**
   * The Session of each Slack turn that streams now, by turn id. A reply to a
   * busy Case can steer that turn (Plan 71). It lives in memory: after a
   * restart, replies wait for the next turn as before.
   */
  private readonly liveTurns = new Map<string, LiveCaseTurn>();

  /**
   * The start of each side Case that runs now, by proposal (Plan 74). A
   * second click waits for the first start, so one start posts one thread.
   */
  private readonly sideCaseStarts = new Map<
    string,
    Promise<SlackSideCaseStartOutcome>
  >();

  constructor(private readonly host: ConnectorChannelHost) {}

  createSchema(storage: DurableObjectStorage): void {
    storage.transactionSync(createSlackCaseWorkSchema.bind(null, storage.sql));
    createConnectorSlackStreamSchema(storage.sql);
  }

  runTurn(
    claim: SlackClaim,
    scope: OrganisationExecutionScope,
    identity: ConnectorIdentity,
  ): Promise<CaseWorkOutcome> {
    return processScheduledSlackCaseMessage(
      this.host.env,
      commandAtPlacement(claim.command, scope),
      claim.attempt,
      identity,
      this.caseWorkConnector(scope),
      scope,
    );
  }

  /**
   * The message used every attempt. Its thread is told one time, and the
   * message is then settled as rejected. A thread that already holds the
   * failure text of the turn's own stream gets no second post.
   */
  async tellAttemptsExhausted(
    claim: SlackClaim,
    work: Variant<SlackClaim["work"], "exhausted_notice">,
    scope: OrganisationExecutionScope,
    identity: ConnectorIdentity,
  ): Promise<CaseWorkOutcome> {
    const { storage, env } = this.host;
    const command = commandAtPlacement(claim.command, scope);
    const streamId = slackCaseStreamId(slackCaseIngressId(command));
    const streamFailurePosted = connectorSlackStreamPostedFailure(
      storage.sql,
      streamId,
    );
    traceWarn("connector.case_work_attempts_exhausted", {
      requestId: command.requestId,
      event_id: command.event.eventId,
      attempt: claim.attempt,
      last_reason: work.lastReason,
      stream_failure_posted: streamFailurePosted,
    });
    if (streamFailurePosted)
      return { kind: "rejected", reason: CASE_WORK_ATTEMPTS_EXHAUSTED };
    // A partial answer stops streaming before the notice follows it.
    await stopOpenConnectorSlackStream({
      sql: storage.sql,
      env,
      scope,
      streamId,
    });
    const notice = await deliverSlackAttemptsExhaustedNotice(
      command,
      identity,
      this.caseWorkConnector(scope),
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

  liveTurn(running: SlackCaseCommand): LiveCaseTurn | null {
    return (
      this.liveTurns.get(slackCaseTurnId(slackCaseIngressId(running))) ?? null
    );
  }

  /**
   * A reply may steer the running turn of its Case when the turn's requester
   * sent it, in the same thread, with text and no files. An edit changes an
   * earlier message and waits for the next turn.
   */
  replyMaySteer(reply: SlackCaseCommand, running: SlackCaseCommand): boolean {
    return (
      reply.principalId === running.principalId &&
      reply.event.threadTs === running.event.threadTs &&
      reply.event.trigger !== "edit" &&
      reply.event.files.length === 0 &&
      slackAuthoredText(reply.event.authored).trim().length > 0
    );
  }

  steerInput(reply: SlackCaseCommand): CaseWorkSteer | null {
    const message = buildSlackUserMessage(reply.event, []);
    if (!message.ok) return null;
    return {
      requesterPersonId: String(reply.principalId),
      text: slackAuthoredText(reply.event.authored).trim(),
      message: message.value.message,
    };
  }

  /**
   * Ingress shows "is thinking…" for each message that it accepts. A reply
   * that steered a turn gets no answer of its own, so nothing clears that
   * status: clear it once the turn has read the reply. Never rejects.
   */
  async steerPlaced(command: SlackCaseCommand): Promise<void> {
    const { env } = this.host;
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

  startRead(
    input: ConnectorDeliveryRequest,
  ): Promise<SlackThreadCredentialRoute> | null {
    return startSlackThreadCredentialRoute(this.host.env, input);
  }

  send(
    input: ConnectorDeliveryRequest,
    scope: OrganisationExecutionScope,
    read: Promise<SlackThreadCredentialRoute> | null,
  ): Promise<ConnectorDeliveryResult> {
    return deliverSlackOutput(
      this.host.env,
      this.host.storage.sql,
      input,
      scope,
      read,
    );
  }

  delivered(
    sql: SqlStorage,
    delivery: ConnectorDelivery,
    receipt: ConnectorDeliveryReceipt,
  ): void {
    completeConnectorSlackDelivery(sql, delivery, receipt);
  }

  /**
   * Start a side Case. A start waits for the start before it of the same
   * proposal, which it then repeats.
   */
  async startSideCase(
    context: Parameters<typeof startSlackSideCase>[0],
    input: Parameters<typeof startSlackSideCase>[1],
  ): Promise<SlackSideCaseStartOutcome> {
    const earlier = this.sideCaseStarts.get(input.proposalId) ?? null;
    const start = this.startSideCaseAfter(earlier, context, input);
    this.sideCaseStarts.set(input.proposalId, start);
    try {
      return await start;
    } finally {
      if (this.sideCaseStarts.get(input.proposalId) === start)
        this.sideCaseStarts.delete(input.proposalId);
    }
  }

  private async startSideCaseAfter(
    earlier: Promise<SlackSideCaseStartOutcome> | null,
    context: Parameters<typeof startSlackSideCase>[0],
    input: Parameters<typeof startSlackSideCase>[1],
  ): Promise<SlackSideCaseStartOutcome> {
    if (earlier !== null) await earlier.catch(ignoreEarlierSideCaseStart);
    return this.host.trackExecution(
      startSlackSideCase.bind(null, context, input, Date.now()),
    );
  }

  /**
   * This Connector as its own drain uses it for one item. The drain holds the
   * scope admitted for that item against the directory, so these calls do not
   * resolve the scope again. Each reads the regional fence and the local
   * barrier immediately before its write.
   */
  private caseWorkConnector(
    scope: OrganisationExecutionScope,
  ): OngoingCaseWalkingConnector {
    const { host } = this;
    return {
      acceptIngress: host.acceptIngressAtScope.bind(null, scope),
      deliver: host.deliverAtScope.bind(null, scope),
      streamCaseTurn: this.streamCaseTurnAtScope.bind(this, scope),
      warmActorSlots: connectorWarmActorSlots(
        host.storage,
        scope.organisationId,
        scope.placement,
      ),
    };
  }

  private streamCaseTurnAtScope(
    scope: OrganisationExecutionScope,
    raw: unknown,
    release: ConnectorCaseStreamRelease,
  ): Promise<
    Result<
      { readonly finalMessage: string; readonly canonicalMessage: string },
      ConnectorCaseTurnStreamError
    >
  > {
    return this.host.trackExecution(
      this.prepareCaseTurnStream.bind(
        this,
        this.host.admitAtScope.bind(null, scope),
        raw,
        release,
      ),
    );
  }

  private async prepareCaseTurnStream(
    admit: ConnectorAdmission,
    raw: unknown,
    release: ConnectorCaseStreamRelease,
  ): Promise<
    Result<
      { readonly finalMessage: string; readonly canonicalMessage: string },
      ConnectorCaseTurnStreamError
    >
  > {
    const { storage, env } = this.host;
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
    const identity = storage.transactionSync(
      ensureConnectorIdentity.bind(null, storage.sql, input.identity),
    );
    if (!identity.ok)
      return {
        ok: false,
        error: { kind: "operational", code: identity.error.code },
      };
    const session = actorStub(
      env.SESSION,
      input.sessionRoute.physicalObjectName,
      input.sessionRoute.placement,
    );
    this.liveTurns.set(input.turnId, {
      sessionId: input.sessionId,
      sessionRoute: input.sessionRoute,
    });
    // A reply that waits for this Case may steer the turn now.
    this.host.wakeCaseWorkDrain();
    let result: Awaited<ReturnType<typeof streamConnectorCaseTurn>>;
    try {
      result = await streamConnectorCaseTurn({
        storage,
        env,
        scope,
        session,
        stream: input,
        release,
      });
    } finally {
      this.liveTurns.delete(input.turnId);
    }
    // A stream that returns a result read the fence after its last wait and
    // has only written this Connector's storage since. Export can still close
    // local admission in between.
    if (result.ok && !actorExecutionAdmissionOpen(storage.sql))
      return {
        ok: false,
        error: { kind: "operational", code: "connector_placement_conflict" },
      };
    return result;
  }
}

/** The later start repeats the work of an earlier one that failed. */
function ignoreEarlierSideCaseStart(): void {}

/** The command with the placement of the scope that runs it. */
function commandAtPlacement(
  command: SlackCaseCommand,
  scope: OrganisationExecutionScope,
): SlackCaseCommand {
  return createSlackCaseCommand({
    requestId: command.requestId,
    receivedAt: command.receivedAt,
    organisationId: command.organisationId,
    integrationAccountId: command.integrationAccountId,
    principalId: command.principalId,
    userId: command.userId,
    requestAuthority: command.requestAuthority,
    event: command.event,
    target: {
      caseId: command.target.caseId,
      connectorId: command.target.connectorId,
      sessionId: command.target.sessionId,
      assignmentId: command.target.assignmentId,
      placement: scope.placement,
    },
  });
}
