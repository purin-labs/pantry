import type {
  ConnectorDelivery,
  ConnectorDeliveryReceipt,
  ConnectorIdentity,
} from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import type { SessionActorStub } from "../actor-stubs";
import type { SessionId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { AlarmReconciler } from "../lifecycle/actor-alarm";
import type { SessionActorRoute } from "../actor-router";
import type {
  CaseWorkCodec,
  CaseWorkCommand,
  CaseWorkOutcome,
  ConnectorCaseWorkClaim,
} from "../connector-case-work";
import type { Variant } from "@purin-labs/type-utils";
import type {
  ConnectorDeliveryRequest,
  ConnectorDeliveryResult,
  ConnectorIngressAcceptance,
  ConnectorResult,
} from "./types";

/**
 * A channel of the Connector: Slack, email or WhatsApp. The channel gives
 * the kernel its parts, and `ConnectorDO` gives the channels to the kernel.
 * The kernel names no channel.
 */
export interface ChannelAdapter {
  readonly name: string;
  /** Creates the channel's own tables. Each statement can run again. */
  createSchema(storage: DurableObjectStorage): void;
  /** The due times of the channel's alarm work. */
  readonly alarmDue?: ChannelAlarmDue;
  /** Work of an alarm that runs before the Case work drain starts. */
  beforeCaseWork?(scope: OrganisationExecutionScope): Promise<void>;
  /** The channel's steps in one alarm. */
  alarmSteps?(scope: OrganisationExecutionScope): ChannelAlarmSteps;
}

/**
 * The due times of a channel's alarm work. It reads only the channel's own
 * tables, so a caller with the storage alone can arm the alarm.
 */
export type ChannelAlarmDue = (sql: SqlStorage) => readonly AlarmReconciler[];

/**
 * The steps of a channel in one alarm. Each step runs only while the Actor
 * serves the Organisation, and a failed step does not stop the others.
 */
export type ChannelAlarmSteps = Readonly<{
  /** Steps that run at the same time as the other channels' steps of this kind. */
  together: readonly ChannelAlarmStep[];
  /** Steps that run one after another, after the steps that run together. */
  inOrder: readonly ChannelAlarmStep[];
}>;

/** One named step of an alarm. Its name is in the log of a failed step. */
export type ChannelAlarmStep = Readonly<{
  name: string;
  run: () => Promise<unknown>;
}>;

/** The channels of one Connector. */
export type ConnectorChannels = Readonly<{
  /** Every channel, in the order of its schema and its alarm steps. */
  adapters: readonly ChannelAdapter[];
  /** The channel whose messages are the Case work of the Connector. */
  caseWork: CaseWorkChannel<CaseWorkCommand>;
  /** The channel that sends the Case outputs of the Connector. */
  delivery: DeliveryChannel<unknown>;
}>;

/** The Session of a turn that streams now. A reply can steer it (Plan 71). */
export type LiveCaseTurn = Readonly<{
  sessionId: SessionId;
  sessionRoute: SessionActorRoute;
}>;

/** What a reply gives to the running turn that it steers. */
export type CaseWorkSteer = Readonly<{
  requesterPersonId: string;
  text: string;
  message: Parameters<
    SessionActorStub["steerCanonicalEmbeddedHarnessTurn"]
  >[0]["message"];
}>;

/** What the Case work drain needs from the channel of its messages. */
export interface CaseWorkChannel<Command extends CaseWorkCommand> {
  readonly codec: CaseWorkCodec<Command>;
  /** Runs one claimed message as a turn of its Case. */
  runTurn(
    claim: ConnectorCaseWorkClaim<Command>,
    scope: OrganisationExecutionScope,
    identity: ConnectorIdentity,
  ): Promise<CaseWorkOutcome>;
  /** Tells the thread of a message that the message used every attempt. */
  tellAttemptsExhausted(
    claim: ConnectorCaseWorkClaim<Command>,
    work: Variant<ConnectorCaseWorkClaim<Command>["work"], "exhausted_notice">,
    scope: OrganisationExecutionScope,
    identity: ConnectorIdentity,
  ): Promise<CaseWorkOutcome>;
  /** The Session of the running command's turn while it streams, or null. */
  liveTurn(running: Command): LiveCaseTurn | null;
  /** True when a waiting reply may join the running command's turn. */
  replyMaySteer(reply: Command, running: Command): boolean;
  /** The input of a reply for the running turn, or null when it has none. */
  steerInput(reply: Command): CaseWorkSteer | null;
  /** Clears what the channel shows for a reply that a turn read. */
  steerPlaced(reply: Command): Promise<void>;
}

/** What the Connector needs from the channel that sends its outputs. */
export interface DeliveryChannel<Read> {
  /**
   * Starts a read that the send of this delivery needs, beside the
   * admission. Null when the delivery needs none.
   */
  startRead(input: ConnectorDeliveryRequest): Promise<Read> | null;
  /** Sends a claimed delivery. `read` is the read started for it, or null. */
  send(
    input: ConnectorDeliveryRequest,
    scope: OrganisationExecutionScope,
    read: Promise<Read> | null,
  ): Promise<ConnectorDeliveryResult>;
  /** Records the receipt of a sent delivery, in its claim's transaction. */
  delivered(
    sql: SqlStorage,
    delivery: ConnectorDelivery,
    receipt: ConnectorDeliveryReceipt,
  ): void;
}

/** What the kernel gives to a channel. */
export type ConnectorChannelHost = Readonly<{
  storage: DurableObjectStorage;
  env: Env;
  /** Runs work that an export waits for. */
  trackExecution<Value>(start: () => Promise<Value>): Promise<Value>;
  /** The scope when it is active and this Connector is the named one. */
  admitAtScope(
    scope: OrganisationExecutionScope,
    identity: ConnectorIdentity,
  ): Promise<OrganisationExecutionScope | null>;
  /** Accepts an ingress under a scope that the caller holds. */
  acceptIngressAtScope(
    scope: OrganisationExecutionScope,
    raw: unknown,
  ): Promise<ConnectorIngressAcceptance>;
  /** Delivers an output under a scope that the caller holds. */
  deliverAtScope(
    scope: OrganisationExecutionScope,
    raw: unknown,
  ): Promise<ConnectorResult<ConnectorDeliveryResult>>;
  /** Wakes the Case work drain, so that a waiting reply can steer a turn. */
  wakeCaseWorkDrain(): void;
}>;

/**
 * What the Connector gives to a module of one channel or of the evals
 * (Refactor 17, step A1.9). A module is a class with this one value: it
 * reads no field of the Actor class. The state and the bindings are read at
 * each use.
 */
export type ConnectorModuleHost = Readonly<{
  ctx: DurableObjectState;
  env: Env;
  /** The scope when this Connector is the named one and admits work. */
  admitExecution(
    identity: ConnectorIdentity,
  ): Promise<OrganisationExecutionScope | null>;
  /** Sets the alarm to the first time that a part of the Connector is due. */
  armAlarm(): Promise<ConnectorResult<null>>;
  /** Runs work that an export waits for. */
  trackExecution<Value>(start: () => Promise<Value>): Promise<Value>;
}>;
