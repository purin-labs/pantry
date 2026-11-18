import { Type, type TSchema } from "typebox";
import { isRecord, sameJson, sha256HexSync, utf8ByteLength } from "@seams/std";
import { StrictObject } from "@seams/commerce-contracts/schema";
import { encodeHarnessCheckpointRecord } from "./digest-encoders.ts";
import { encodeModelRoute } from "./model-route.ts";
import {
  agentSessionLifecycleSchema,
  harnessCheckpointRecordSchema,
  sessionCommandSchema,
  sessionTransitionSchema,
  type ActivatingSession,
  type AgentSessionLifecycle,
  type CancellingSession,
  type HarnessCheckpointRecord,
  type HarnessTaskContinuation,
  type ProcessingSession,
  type QuarantinedSession,
  type RecoveringSession,
  type RuntimeLease,
  type SessionCommand,
  type SessionContract,
  type SessionRecoveryAction,
  type SessionResumePoint,
  type SessionTransition,
  type TerminalSession,
  type TurnIdentity,
  type TurnLifecycle,
  type WorkspaceRevisionReceipt,
} from "./session-schemas.ts";

// The Plan 78 port of the Rust session reducer (actor.rs) and its JSON
// boundary (actor/serialized.rs). Each function takes the decoded request and
// returns the response that the Wasm export writes, in serde's field order.

export const ADVANCE_SESSION_COMMAND_SCHEMA =
  "satyr.actor.advance-session-command.v1";
export const RESTORE_SESSION_SCHEMA = "satyr.actor.restore-session.v1";
export const VALIDATE_HARNESS_CHECKPOINT_SCHEMA =
  "satyr.actor.validate-harness-checkpoint.v1";
export const VALIDATE_HARNESS_CHECKPOINT_RESTORE_SCHEMA =
  "satyr.actor.validate-harness-checkpoint-restore.v1";

export type SessionBoundaryResponse<T> =
  | Readonly<{ status: "ok"; value: T }>
  | Readonly<{ status: "error"; error: Readonly<{ code: string }> }>;

export type SessionAdvanceValue = Readonly<{
  transition: SessionTransition;
  state: AgentSessionLifecycle;
}>;
export type SessionRestoreValue = Readonly<{ state: AgentSessionLifecycle }>;
export type HarnessCheckpointValidationValue = Readonly<{ valid: true }>;

/** A Rust reducer or boundary error code. */
class SessionRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const advanceRequestSchema = StrictObject({
  schema: Type.String(),
  current: Type.Optional(
    Type.Union([agentSessionLifecycleSchema, Type.Null()]),
  ),
  command: sessionCommandSchema,
});
const restoreRequestSchema = StrictObject({
  schema: Type.String(),
  snapshot: Type.Optional(
    Type.Union([
      StrictObject({
        lastSequence: Type.Integer({ minimum: 0 }),
        state: agentSessionLifecycleSchema,
      }),
      Type.Null(),
    ]),
  ),
  tail: Type.Array(
    StrictObject({
      sequence: Type.Integer({ minimum: 0 }),
      transition: sessionTransitionSchema,
    }),
  ),
});
const checkpointRequestSchema = StrictObject({
  schema: Type.String(),
  state: agentSessionLifecycleSchema,
  checkpoint: harnessCheckpointRecordSchema,
});

export function advanceSessionCommand(
  input: unknown,
): SessionBoundaryResponse<SessionAdvanceValue> {
  return respond(() => {
    const request = decodeRequest(
      advanceRequestSchema,
      input,
      ADVANCE_SESSION_COMMAND_SCHEMA,
    ) as {
      current?: AgentSessionLifecycle | null;
      command: SessionCommand;
    };
    const current = request.current ?? null;
    const transition = decideSessionCommand(current, request.command);
    const state = reduceSessionTransition(current, transition);
    return { transition, state };
  });
}

export function restoreSession(
  input: unknown,
): SessionBoundaryResponse<SessionRestoreValue> {
  return respond(() => {
    const request = decodeRequest(
      restoreRequestSchema,
      input,
      RESTORE_SESSION_SCHEMA,
    ) as {
      snapshot?: {
        lastSequence: number;
        state: AgentSessionLifecycle;
      } | null;
      tail: { sequence: number; transition: SessionTransition }[];
    };
    return {
      state: restoreFromSnapshotAndTail(request.snapshot ?? null, request.tail),
    };
  });
}

export function validateHarnessCheckpointRecord(
  input: unknown,
): SessionBoundaryResponse<HarnessCheckpointValidationValue> {
  return respond(() => {
    const request = decodeRequest(
      checkpointRequestSchema,
      input,
      VALIDATE_HARNESS_CHECKPOINT_SCHEMA,
    ) as { state: AgentSessionLifecycle; checkpoint: HarnessCheckpointRecord };
    validateCheckpointRecord(request.state, request.checkpoint);
    return { valid: true as const };
  });
}

export function validateHarnessCheckpointRestoreRecord(
  input: unknown,
): SessionBoundaryResponse<HarnessCheckpointValidationValue> {
  return respond(() => {
    const request = decodeRequest(
      checkpointRequestSchema,
      input,
      VALIDATE_HARNESS_CHECKPOINT_RESTORE_SCHEMA,
    ) as { state: AgentSessionLifecycle; checkpoint: HarnessCheckpointRecord };
    validateCheckpointRestoreRecord(request.state, request.checkpoint);
    return { valid: true as const };
  });
}

/** serde writes this byte form; it is the only digest input of a route. */
export function digestModelRouteSync(
  route: SessionContract["modelRoute"],
): string {
  return sha256HexSync(encodeModelRoute(route));
}

/** `checkpoint_` and the SHA-256 of the record's serde bytes. */
export function harnessCheckpointIdSync(
  record: HarnessCheckpointRecord,
): string {
  return `checkpoint_${sha256HexSync(
    encodeHarnessCheckpointRecord(
      record as Parameters<typeof encodeHarnessCheckpointRecord>[0],
    ),
  )}`;
}

function respond<T>(run: () => T): SessionBoundaryResponse<T> {
  try {
    return { status: "ok", value: run() };
  } catch (error) {
    if (error instanceof SessionRefusal)
      return { status: "error", error: { code: error.code } };
    throw error;
  }
}

/**
 * serde deserializes the whole request first, then the boundary checks the
 * schema version, then each Rust parser runs. All shape and parser failures
 * are `invalid_input`.
 */
function decodeRequest(
  schema: TSchema,
  input: unknown,
  expectedVersion: string,
): unknown {
  if (!matchesShape(schema, input)) throw new SessionRefusal("invalid_input");
  if ((input as { schema: string }).schema !== expectedVersion)
    throw new SessionRefusal("unsupported_schema_version");
  const decoded = normalize(schema, input);
  if (decoded === INVALID) throw new SessionRefusal("invalid_input");
  return decoded;
}

type Schema = Readonly<{
  anyOf?: readonly Schema[];
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  items?: Schema;
  minimum?: number;
  maximum?: number;
  rule?: string;
}>;

/**
 * serde_json's view of the JSON: types, tags, unknown fields and strings.
 * `buffered` is true inside an internally tagged variant: serde reads that
 * content from a buffer, which also accepts a variant index as a tag.
 */
function matchesShape(
  schemaInput: TSchema,
  value: unknown,
  buffered = false,
): boolean {
  const schema = schemaInput as Schema;
  if (schema.rule === "backend_id")
    return typeof value === "string" && wellFormed(value);
  if (schema.anyOf !== undefined || schema.enum !== undefined) {
    const selected = selectVariant(schema, value, buffered);
    if (selected === undefined) return false;
    return (
      selected.schema === undefined ||
      matchesShape(selected.schema as TSchema, value, buffered)
    );
  }
  switch (schema.type) {
    case "null":
      return value === null;
    case "string":
      // A literal outside a tag is a one-variant Rust enum.
      if (schema.const !== undefined)
        return (
          selectVariant({ anyOf: [schema] }, value, buffered) !== undefined
        );
      return typeof value === "string" && wellFormed(value);
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity)
      );
    case "array":
      return (
        Array.isArray(value) &&
        value.every((item) =>
          matchesShape(schema.items as TSchema, item, buffered),
        )
      );
    case "object": {
      if (!isRecord(value)) return false;
      const properties = schema.properties ?? {};
      const tag = tagOf(schema);
      // serde ignores other fields of an internally tagged unit variant.
      const unit = tag !== undefined && Object.keys(properties).length === 1;
      if (!unit)
        for (const key of Object.keys(value))
          if (!Object.hasOwn(properties, key)) return false;
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(value, key)) return false;
      for (const [key, property] of Object.entries(properties)) {
        // The union matched the tag already, by name or by variant index.
        if (key === tag?.key || !Object.hasOwn(value, key)) continue;
        if (
          !matchesShape(
            property as TSchema,
            value[key],
            buffered || tag !== undefined,
          )
        )
          return false;
      }
      return true;
    }
    default:
      return false;
  }
}

type SelectedVariant = Readonly<{
  /** Undefined for a unit enum: `name` is the variant. */
  schema: Schema | undefined;
  name?: unknown;
}>;

/**
 * serde picks an internally tagged variant by its tag, `null` for `None`,
 * and a unit enum by name, also in the `{"name": null}` form.
 */
function selectVariant(
  schema: Schema,
  value: unknown,
  buffered: boolean,
): SelectedVariant | undefined {
  const names = unitNames(schema);
  if (names !== undefined) {
    if (typeof value === "string" && names.includes(value))
      return { schema: undefined, name: value };
    if (isRecord(value)) {
      const keys = Object.keys(value);
      if (
        keys.length === 1 &&
        names.includes(keys[0]) &&
        value[keys[0]!] === null
      )
        return { schema: undefined, name: keys[0] };
    }
    return undefined;
  }
  const variants = schema.anyOf ?? [];
  for (const [index, candidate] of variants.entries()) {
    if (candidate.type === "null") {
      if (value === null) return { schema: candidate };
      continue;
    }
    if (candidate.anyOf !== undefined || candidate.enum !== undefined) {
      const nested = selectVariant(candidate, value, buffered);
      if (nested !== undefined)
        return nested.schema === undefined ? nested : { schema: candidate };
      continue;
    }
    if (candidate.type !== "object" || !isRecord(value)) continue;
    const tag = tagOf(candidate);
    if (tag === undefined) return { schema: candidate };
    const received = value[tag.key];
    if (received === tag.value || (buffered && received === index))
      return { schema: candidate };
  }
  return undefined;
}

/** The names of a unit-only enum, or undefined for any other schema. */
function unitNames(schema: Schema): readonly unknown[] | undefined {
  if (schema.enum !== undefined) return schema.enum;
  if (
    schema.anyOf !== undefined &&
    schema.anyOf.length > 0 &&
    schema.anyOf.every(
      (variant) => variant.type === "string" && variant.const !== undefined,
    )
  )
    return schema.anyOf.map((variant) => variant.const);
  return undefined;
}

function tagOf(schema: Schema): { key: string; value: unknown } | undefined {
  for (const key of ["kind", "keySource"]) {
    const property = schema.properties?.[key];
    if (property?.const !== undefined) return { key, value: property.const };
  }
  return undefined;
}

const INVALID: unique symbol = Symbol("invalid");

/** The Rust parsers after the shape passes, in Rust declaration order. */
function normalize(
  schemaInput: TSchema,
  value: unknown,
  buffered = false,
): unknown {
  const schema = schemaInput as Schema;
  if (schema.rule === "backend_id")
    return value === "picocodex" || value === "pi" || value === "codex"
      ? value
      : INVALID;
  if (schema.anyOf !== undefined || schema.enum !== undefined) {
    const selected = selectVariant(schema, value, buffered) as SelectedVariant;
    return selected.schema === undefined
      ? selected.name
      : normalize(selected.schema as TSchema, value, buffered);
  }
  switch (schema.type) {
    case "string":
      if (schema.const !== undefined) return schema.const;
      return schema.rule === undefined
        ? value
        : applyTextRule(schema.rule, value as string);
    case "integer":
      if (schema.rule === "positive" && value === 0) return INVALID;
      if (schema.rule === "nonzero_byte_length" && value === 0) return INVALID;
      return value;
    case "array": {
      const items: unknown[] = [];
      for (const item of value as unknown[]) {
        const normalized = normalize(schema.items as TSchema, item, buffered);
        if (normalized === INVALID) return INVALID;
        items.push(normalized);
      }
      return items;
    }
    case "object": {
      const record = value as Record<string, unknown>;
      const tag = tagOf(schema);
      const result: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(record, key)) continue;
        const normalized =
          key === tag?.key
            ? tag.value
            : normalize(
                property as TSchema,
                record[key],
                buffered || tag !== undefined,
              );
        if (normalized === INVALID) return INVALID;
        result[key] = normalized;
      }
      return result;
    }
    default:
      return value;
  }
}

// Unicode White_Space, as Rust str::trim removes it.
const RUST_WHITESPACE =
  /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
// Unicode Cc, as Rust char::is_control reports it.
const RUST_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const IDENTITY_TEXT = /^[A-Za-z0-9_.:-]+$/;
const SHA256 = /^[0-9A-Fa-f]{64}$/;

function applyTextRule(rule: string, value: string): unknown {
  switch (rule) {
    case "actor_identity":
      return value.length > 0 &&
        utf8ByteLength(value) <= 256 &&
        !RUST_WHITESPACE.test(value) &&
        !RUST_CONTROL.test(value)
        ? value
        : INVALID;
    case "object_key":
      return value.length > 0 &&
        utf8ByteLength(value) <= 1024 &&
        !RUST_WHITESPACE.test(value) &&
        !RUST_CONTROL.test(value)
        ? value
        : INVALID;
    case "bounded_identity":
      return validIdentityText(value) ? value : INVALID;
    case "workspace_id":
      return value.length > "workspace_".length &&
        value.startsWith("workspace_") &&
        validIdentityText(value)
        ? value
        : INVALID;
    case "sha256":
      return SHA256.test(value) ? value.toLowerCase() : INVALID;
    case "organisation_id":
      return value.length > 0 &&
        !RUST_WHITESPACE.test(value) &&
        !onlyWhitespace(value)
        ? value
        : INVALID;
    default:
      throw new Error(`Unknown session field rule: ${rule}`);
  }
}

function validIdentityText(value: string): boolean {
  return value.length <= 256 && IDENTITY_TEXT.test(value);
}

function onlyWhitespace(value: string): boolean {
  return /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(
    value,
  );
}

/** serde_json refuses a lone surrogate in a string escape. */
function wellFormed(value: string): boolean {
  return !/\p{Surrogate}/u.test(value);
}

// Reducer (actor.rs). Equality is Rust's structural equality of parsed values.

function decideSessionCommand(
  current: AgentSessionLifecycle | null,
  command: SessionCommand,
): SessionTransition {
  let transition: SessionTransition;
  switch (command.kind) {
    case "initialize":
      transition = {
        kind: "session_initialized",
        state: {
          identity: command.identity,
          contract: command.contract,
          resumePoint: command.resumePoint,
        },
      };
      break;
    case "accept_input": {
      const state = expect(current, "sleeping");
      transition = {
        kind: "input_accepted",
        input: command.input,
        state: {
          identity: state.identity,
          contract: nextSessionContract(state.contract),
          turnId: command.turnId,
          inputId: command.input.inputId,
          resumePoint: state.resumePoint,
          runtimeGeneration: command.runtimeGeneration,
        },
      };
      break;
    }
    case "activate_runtime": {
      const state = expect(current, "activating");
      transition = {
        kind: "runtime_activated",
        state: {
          identity: state.identity,
          contract: nextSessionContract(state.contract),
          resumePoint: state.resumePoint,
          runtimeLease: command.runtimeLease,
          activeTurn: {
            kind: "admitted",
            state: {
              identity: {
                turnId: state.turnId,
                inputId: state.inputId,
                turnLeaseGeneration: command.turnLeaseGeneration,
                budgetRevision: state.contract.budgetRevision,
              },
              admittedAt: command.admittedAt,
            },
          },
        },
      };
      break;
    }
    case "accept_execution_receipt": {
      const state = expect(current, "processing");
      if (!sameJson(state.runtimeLease, command.runtimeLease))
        throw new SessionRefusal("runtime_lease_mismatch");
      if (state.activeTurn.kind !== "awaiting_execution")
        throw new SessionRefusal("invalid_predecessor");
      const awaiting = state.activeTurn.state;
      const turn = awaiting.identity;
      const receipt = command.receipt;
      if (receipt.receipt.kind !== "inline")
        throw new SessionRefusal("turn_mismatch");
      const value = receipt.receipt.value;
      if (
        !sameJson(turn, value.turn) ||
        turn.turnLeaseGeneration !== command.turnLeaseGeneration ||
        awaiting.executionId !== value.executionId ||
        awaiting.effectId !== receipt.effectId
      )
        throw new SessionRefusal("turn_mismatch");
      if (
        receipt.kind !== "execution" ||
        receipt.capability !== "idempotent" ||
        !validExecutionWorkspaceReceipt(
          resumeWorkspaceReceipt(state.resumePoint),
          value.workspaceRevisionReceipt,
          receipt.receiptId,
        )
      )
        throw new SessionRefusal("contract_mismatch");
      transition = {
        kind: "execution_settled",
        receipt,
        state: {
          identity: state.identity,
          contract: nextSessionContract(state.contract),
          resumePoint: state.resumePoint,
          runtimeLease: state.runtimeLease,
          activeTurn: {
            kind: "reducing_result",
            state: {
              identity: turn,
              receiptId: receipt.receiptId,
              workspaceRevisionReceipt: value.workspaceRevisionReceipt,
            },
          },
        },
      };
      break;
    }
    case "request_execution": {
      const state = expect(current, "processing");
      if (!sameJson(state.runtimeLease, command.runtimeLease))
        throw new SessionRefusal("runtime_lease_mismatch");
      if (
        state.activeTurn.kind === "awaiting_execution" ||
        state.activeTurn.kind === "reducing_result"
      )
        throw new SessionRefusal("invalid_predecessor");
      const turn = turnIdentity(state.activeTurn);
      const request = command.request;
      if (request.request.kind !== "inline")
        throw new SessionRefusal("turn_mismatch");
      const value = request.request.value;
      if (
        !sameJson(turn, value.turn) ||
        turn.turnLeaseGeneration !== command.turnLeaseGeneration ||
        request.kind !== "execution" ||
        request.capability !== "idempotent" ||
        !sameJson(
          value.workspaceRevisionReceipt,
          resumeWorkspaceReceipt(state.resumePoint),
        )
      )
        throw new SessionRefusal("contract_mismatch");
      transition = {
        kind: "execution_requested",
        request,
        state: {
          identity: state.identity,
          contract: nextSessionContract(state.contract),
          resumePoint: state.resumePoint,
          runtimeLease: state.runtimeLease,
          activeTurn: {
            kind: "awaiting_execution",
            state: {
              identity: turn,
              executionId: value.executionId,
              effectId: request.effectId,
            },
          },
        },
      };
      break;
    }
    case "begin_checkpoint": {
      const state = expect(current, "processing");
      const turn = turnIdentity(state.activeTurn);
      if (!sameJson(state.runtimeLease, command.runtimeLease))
        throw new SessionRefusal("runtime_lease_mismatch");
      if (turn.turnLeaseGeneration !== command.turnLeaseGeneration)
        throw new SessionRefusal("turn_mismatch");
      const currentWorkspace = resumeWorkspaceReceipt(state.resumePoint);
      const receipt = command.workspaceRevisionReceipt;
      if (
        (receipt.outcome !== "accepted" &&
          receipt.outcome !== "already_applied") ||
        receipt.workspaceId !== currentWorkspace.workspaceId ||
        (state.activeTurn.kind === "reducing_result" &&
          !sameJson(receipt, state.activeTurn.state.workspaceRevisionReceipt))
      )
        throw new SessionRefusal("resume_point_mismatch");
      transition = {
        kind: "checkpointing_started",
        state: {
          identity: state.identity,
          contract: nextSessionContract(state.contract),
          runtimeLease: command.runtimeLease,
          turnId: turn.turnId,
          inputId: turn.inputId,
          turnLeaseGeneration: command.turnLeaseGeneration,
          outcome: command.outcome,
          resumePoint: state.resumePoint,
          workspaceRevisionReceipt: receipt,
        },
      };
      break;
    }
    case "commit_checkpoint": {
      const state = expect(current, "checkpointing");
      transition = {
        kind: "checkpoint_committed",
        state: {
          identity: state.identity,
          contract: nextSessionContract(state.contract),
          resumePoint: { kind: "checkpoint", checkpoint: command.checkpoint },
        },
      };
      break;
    }
    case "begin_execution_recovery": {
      const state = expect(current, "processing");
      transition = {
        kind: "execution_recovery_started",
        state: beginExecutionRecovery(
          state,
          command.continuation,
          command.action,
        ),
      };
      break;
    }
    case "update_execution_recovery": {
      const state = expect(current, "recovering");
      transition = {
        kind: "execution_recovery_updated",
        state: updateExecutionRecovery(state, command.action),
      };
      break;
    }
    case "resume_execution": {
      const state = expect(current, "recovering");
      transition = {
        kind: "execution_resumed",
        state: resumeExecution(state, command.runtimeLease),
      };
      break;
    }
    case "cancel":
      transition = {
        kind: "cancellation_started",
        state: decideCancellationStart(current, command.target),
      };
      break;
    case "resolve_cancellation":
      transition = {
        kind: "cancellation_resolved",
        resolution: decideCancellationResolution(current, command.resolution),
      };
      break;
    case "quarantine":
      transition = {
        kind: "session_quarantined",
        state: decideQuarantine(current, command.reason),
      };
      break;
    case "recover":
      transition = {
        kind: "session_recovered",
        state: decideRecovery(current),
      };
      break;
    case "terminate":
      transition = {
        kind: "session_terminated",
        state: decideTermination(current, command.reason, command.terminalAt),
      };
      break;
  }
  reduceSessionTransition(current, transition);
  return transition;
}

type LifecycleState<Kind extends AgentSessionLifecycle["kind"]> = Extract<
  AgentSessionLifecycle,
  { kind: Kind }
>["state"];

/** A missing session is not initialized; any other state is the wrong one. */
function expect<Kind extends AgentSessionLifecycle["kind"]>(
  current: AgentSessionLifecycle | null,
  kind: Kind,
): LifecycleState<Kind> {
  if (current === null) throw new SessionRefusal("session_not_initialized");
  if (current.kind !== kind) throw new SessionRefusal("invalid_predecessor");
  return current.state as LifecycleState<Kind>;
}

function beginExecutionRecovery(
  current: ProcessingSession,
  continuation: HarnessTaskContinuation,
  action: SessionRecoveryAction,
): RecoveringSession {
  return {
    identity: current.identity,
    contract: nextSessionContract(current.contract),
    resumePoint: current.resumePoint,
    fencedRuntime: current.runtimeLease,
    activeTurn: current.activeTurn,
    continuation,
    action,
  };
}

function updateExecutionRecovery(
  current: RecoveringSession,
  action: SessionRecoveryAction,
): RecoveringSession {
  return {
    identity: current.identity,
    contract: nextSessionContract(current.contract),
    resumePoint: current.resumePoint,
    fencedRuntime: current.fencedRuntime,
    activeTurn: current.activeTurn,
    continuation: current.continuation,
    action,
  };
}

function resumeExecution(
  current: RecoveringSession,
  runtimeLease: RuntimeLease,
): ProcessingSession {
  if (current.action.kind !== "resume_task")
    throw new SessionRefusal("invalid_predecessor");
  if (
    runtimeLease.generation !==
      nextRuntimeGeneration(current.fencedRuntime.generation) ||
    runtimeLease.leaseId === current.fencedRuntime.leaseId
  )
    throw new SessionRefusal("runtime_lease_mismatch");
  return {
    identity: current.identity,
    contract: nextSessionContract(current.contract),
    resumePoint: current.resumePoint,
    runtimeLease,
    activeTurn: current.activeTurn,
  };
}

type CancellationTarget = Extract<SessionCommand, { kind: "cancel" }>["target"];
type CancellationPlan = CancellingSession["plan"];
type CancellationLease = CancellationPlan["lease"];

function cancellationPlan(
  target: CancellationTarget,
  turn: Readonly<{ turnId: string; inputId: string }>,
  resumePoint: SessionResumePoint,
  lease: CancellationLease,
): CancellationPlan {
  if (target.kind === "session")
    return { kind: "session", reason: target.reason, lease };
  if (target.turnId !== turn.turnId) throw new SessionRefusal("turn_mismatch");
  return {
    kind: "turn",
    turnId: turn.turnId,
    inputId: turn.inputId,
    resumePoint,
    lease,
  };
}

function decideCancellationStart(
  current: AgentSessionLifecycle | null,
  target: CancellationTarget,
): CancellingSession {
  if (current === null) throw new SessionRefusal("session_not_initialized");
  let plan: CancellationPlan;
  switch (current.kind) {
    case "activating":
      plan = cancellationPlan(
        target,
        current.state,
        current.state.resumePoint,
        {
          kind: "none",
        },
      );
      break;
    case "processing": {
      const turn = turnIdentity(current.state.activeTurn);
      plan = cancellationPlan(target, turn, current.state.resumePoint, {
        kind: "active",
        runtimeLease: current.state.runtimeLease,
        turnLeaseGeneration: turn.turnLeaseGeneration,
      });
      break;
    }
    case "recovering":
      plan = cancellationPlan(
        target,
        turnIdentity(current.state.activeTurn),
        current.state.resumePoint,
        { kind: "none" },
      );
      break;
    case "checkpointing":
      plan = cancellationPlan(
        target,
        current.state,
        current.state.resumePoint,
        {
          kind: "active",
          runtimeLease: current.state.runtimeLease,
          turnLeaseGeneration: current.state.turnLeaseGeneration,
        },
      );
      break;
    default:
      throw new SessionRefusal("invalid_predecessor");
  }
  return {
    identity: current.state.identity,
    contract: nextSessionContract(current.state.contract),
    plan,
  };
}

type CancellationResolutionInput = Extract<
  SessionCommand,
  { kind: "resolve_cancellation" }
>["resolution"];
type CancellationResolution = Extract<
  SessionTransition,
  { kind: "cancellation_resolved" }
>["resolution"];

function decideCancellationResolution(
  current: AgentSessionLifecycle | null,
  resolution: CancellationResolutionInput,
): CancellationResolution {
  const state = expect(current, "cancelling");
  const contract = nextSessionContract(state.contract);
  const plan = state.plan;
  if (plan.kind === "turn" && resolution.kind === "return_to_sleeping")
    return {
      kind: "sleeping",
      state: {
        identity: state.identity,
        contract,
        resumePoint: plan.resumePoint,
      },
    };
  if (
    plan.kind === "turn" &&
    plan.lease.kind === "active" &&
    resolution.kind === "begin_checkpointing"
  )
    return {
      kind: "checkpointing",
      state: {
        identity: state.identity,
        contract,
        runtimeLease: plan.lease.runtimeLease,
        turnId: plan.turnId,
        inputId: plan.inputId,
        turnLeaseGeneration: plan.lease.turnLeaseGeneration,
        outcome: "cancelled",
        resumePoint: plan.resumePoint,
        workspaceRevisionReceipt: resolution.workspaceRevisionReceipt,
      },
    };
  if (plan.kind === "session" && resolution.kind === "terminate")
    return {
      kind: "terminal",
      state: {
        identity: state.identity,
        contract,
        reason: plan.reason,
        terminalAt: resolution.terminalAt,
      },
    };
  throw new SessionRefusal("invalid_predecessor");
}

function decideQuarantine(
  current: AgentSessionLifecycle | null,
  reason: QuarantinedSession["reason"],
): QuarantinedSession {
  if (current === null) throw new SessionRefusal("session_not_initialized");
  let recovery: QuarantinedSession["recovery"];
  switch (current.kind) {
    case "activating":
      recovery =
        reason === "activation_failure"
          ? {
              kind: "reactivate",
              turnId: current.state.turnId,
              inputId: current.state.inputId,
              resumePoint: current.state.resumePoint,
              nextRuntimeGeneration: nextRuntimeGeneration(
                current.state.runtimeGeneration,
              ),
            }
          : { kind: "terminate_only" };
      break;
    case "processing":
    case "recovering":
    case "checkpointing":
    case "cancelling":
      recovery = { kind: "terminate_only" };
      break;
    default:
      throw new SessionRefusal("invalid_predecessor");
  }
  return {
    identity: current.state.identity,
    contract: nextSessionContract(current.state.contract),
    reason,
    recovery,
  };
}

function decideRecovery(
  current: AgentSessionLifecycle | null,
): ActivatingSession {
  const state = expect(current, "quarantined");
  const recovery = state.recovery;
  if (recovery.kind !== "reactivate")
    throw new SessionRefusal("invalid_predecessor");
  return {
    identity: state.identity,
    contract: nextSessionContract(state.contract),
    turnId: recovery.turnId,
    inputId: recovery.inputId,
    resumePoint: recovery.resumePoint,
    runtimeGeneration: recovery.nextRuntimeGeneration,
  };
}

function decideTermination(
  current: AgentSessionLifecycle | null,
  reason: TerminalSession["reason"],
  terminalAt: number,
): TerminalSession {
  if (current === null) throw new SessionRefusal("session_not_initialized");
  if (current.kind !== "sleeping" && current.kind !== "quarantined")
    throw new SessionRefusal("invalid_predecessor");
  return {
    identity: current.state.identity,
    contract: nextSessionContract(current.state.contract),
    reason,
    terminalAt,
  };
}

/**
 * u64 checked_add. The boundary admits safe integers only, so the successor
 * is exact (2^53 at most) and never overflows, as in Rust for these values.
 */
function successor(value: number): number {
  return value + 1;
}

function nextRuntimeGeneration(current: number): number {
  return successor(current);
}

function reduceSessionTransition(
  current: AgentSessionLifecycle | null,
  transition: SessionTransition,
): AgentSessionLifecycle {
  switch (transition.kind) {
    case "session_state_imported": {
      if (current !== null) throw new SessionRefusal("already_initialized");
      const state = transition.state;
      switch (state.kind) {
        case "quarantined":
          if (state.state.recovery.kind !== "terminate_only")
            throw new SessionRefusal("imported_state_unsafe");
          break;
        case "sleeping":
        case "terminal":
          break;
        default:
          throw new SessionRefusal("imported_state_unsafe");
      }
      if (state.state.contract.lastEventSequence !== 0)
        throw new SessionRefusal("imported_sequence_invalid");
      return state;
    }
    case "session_initialized":
      if (current !== null) throw new SessionRefusal("already_initialized");
      if (transition.state.contract.lastEventSequence !== 0)
        throw new SessionRefusal("contract_mismatch");
      return { kind: "sleeping", state: transition.state };
    case "input_accepted": {
      const sleeping = expect(current, "sleeping");
      const state = transition.state;
      if (!sameJson(sleeping.identity, state.identity))
        throw new SessionRefusal("identity_mismatch");
      if (transition.input.inputId !== state.inputId)
        throw new SessionRefusal("input_mismatch");
      if (!sameJson(sleeping.resumePoint, state.resumePoint))
        throw new SessionRefusal("resume_point_mismatch");
      if (!contractAdvances(sleeping.contract, state.contract))
        throw new SessionRefusal("contract_mismatch");
      return { kind: "activating", state };
    }
    case "runtime_activated": {
      const activating = expect(current, "activating");
      const state = transition.state;
      if (!sameJson(activating.identity, state.identity))
        throw new SessionRefusal("identity_mismatch");
      if (!sameJson(activating.resumePoint, state.resumePoint))
        throw new SessionRefusal("resume_point_mismatch");
      if (!contractAdvances(activating.contract, state.contract))
        throw new SessionRefusal("contract_mismatch");
      if (activating.runtimeGeneration !== state.runtimeLease.generation)
        throw new SessionRefusal("runtime_lease_mismatch");
      if (state.activeTurn.kind !== "admitted")
        throw new SessionRefusal("turn_mismatch");
      const turn = state.activeTurn.state.identity;
      if (
        activating.turnId !== turn.turnId ||
        activating.inputId !== turn.inputId ||
        activating.contract.budgetRevision !== turn.budgetRevision
      )
        throw new SessionRefusal("turn_mismatch");
      return { kind: "processing", state };
    }
    case "execution_requested": {
      const processing = expect(current, "processing");
      const request = transition.request;
      const state = transition.state;
      if (request.request.kind !== "inline")
        throw new SessionRefusal("turn_mismatch");
      const value = request.request.value;
      if (
        !sameJson(processing.identity, state.identity) ||
        !sameJson(processing.resumePoint, state.resumePoint) ||
        !sameJson(processing.runtimeLease, state.runtimeLease)
      )
        throw new SessionRefusal("identity_mismatch");
      ensureNextContract(processing.contract, state.contract);
      if (
        processing.activeTurn.kind === "awaiting_execution" ||
        processing.activeTurn.kind === "reducing_result"
      )
        throw new SessionRefusal("invalid_predecessor");
      const turn = turnIdentity(processing.activeTurn);
      if (state.activeTurn.kind !== "awaiting_execution")
        throw new SessionRefusal("turn_mismatch");
      const awaiting = state.activeTurn.state;
      if (
        request.kind !== "execution" ||
        request.capability !== "idempotent" ||
        !sameJson(value.turn, turn) ||
        !sameJson(awaiting.identity, turn) ||
        awaiting.executionId !== value.executionId ||
        awaiting.effectId !== request.effectId ||
        !sameJson(
          value.workspaceRevisionReceipt,
          resumeWorkspaceReceipt(processing.resumePoint),
        )
      )
        throw new SessionRefusal("contract_mismatch");
      return { kind: "processing", state };
    }
    case "execution_settled": {
      const processing = expect(current, "processing");
      const receipt = transition.receipt;
      const state = transition.state;
      if (
        !sameJson(processing.identity, state.identity) ||
        !sameJson(processing.resumePoint, state.resumePoint) ||
        !sameJson(processing.runtimeLease, state.runtimeLease)
      )
        throw new SessionRefusal("identity_mismatch");
      ensureNextContract(processing.contract, state.contract);
      if (processing.activeTurn.kind === "reducing_result")
        throw new SessionRefusal("invalid_predecessor");
      const previousTurn = turnIdentity(processing.activeTurn);
      if (receipt.receipt.kind !== "inline")
        throw new SessionRefusal("turn_mismatch");
      const value = receipt.receipt.value;
      if (state.activeTurn.kind !== "reducing_result")
        throw new SessionRefusal("turn_mismatch");
      const reducing = state.activeTurn.state;
      if (
        receipt.kind !== "execution" ||
        receipt.capability !== "idempotent" ||
        !sameJson(previousTurn, value.turn) ||
        !sameJson(reducing.identity, value.turn) ||
        reducing.receiptId !== receipt.receiptId ||
        !sameJson(
          reducing.workspaceRevisionReceipt,
          value.workspaceRevisionReceipt,
        ) ||
        !validExecutionWorkspaceReceipt(
          resumeWorkspaceReceipt(processing.resumePoint),
          value.workspaceRevisionReceipt,
          receipt.receiptId,
        )
      )
        throw new SessionRefusal("turn_mismatch");
      return { kind: "processing", state };
    }
    case "execution_recovery_started": {
      const processing = expect(current, "processing");
      const state = transition.state;
      if (
        !sameJson(
          beginExecutionRecovery(processing, state.continuation, state.action),
          state,
        )
      )
        throw new SessionRefusal("contract_mismatch");
      return { kind: "recovering", state };
    }
    case "execution_recovery_updated": {
      const recovering = expect(current, "recovering");
      const state = transition.state;
      if (!sameJson(updateExecutionRecovery(recovering, state.action), state))
        throw new SessionRefusal("contract_mismatch");
      return { kind: "recovering", state };
    }
    case "execution_resumed": {
      const recovering = expect(current, "recovering");
      const state = transition.state;
      if (!sameJson(resumeExecution(recovering, state.runtimeLease), state))
        throw new SessionRefusal("contract_mismatch");
      return { kind: "processing", state };
    }
    case "checkpointing_started": {
      const processing = expect(current, "processing");
      const state = transition.state;
      if (!sameJson(processing.identity, state.identity))
        throw new SessionRefusal("identity_mismatch");
      if (!sameJson(processing.resumePoint, state.resumePoint))
        throw new SessionRefusal("resume_point_mismatch");
      ensureNextContract(processing.contract, state.contract);
      if (!sameJson(processing.runtimeLease, state.runtimeLease))
        throw new SessionRefusal("runtime_lease_mismatch");
      const turn = turnIdentity(processing.activeTurn);
      if (
        turn.turnId !== state.turnId ||
        turn.inputId !== state.inputId ||
        turn.turnLeaseGeneration !== state.turnLeaseGeneration ||
        turn.budgetRevision !== state.contract.budgetRevision
      )
        throw new SessionRefusal("turn_mismatch");
      return { kind: "checkpointing", state };
    }
    case "checkpoint_committed": {
      const checkpointing = expect(current, "checkpointing");
      const state = transition.state;
      if (!sameJson(checkpointing.identity, state.identity))
        throw new SessionRefusal("identity_mismatch");
      ensureNextContract(checkpointing.contract, state.contract);
      if (state.resumePoint.kind !== "checkpoint")
        throw new SessionRefusal("checkpoint_mismatch");
      const checkpoint = state.resumePoint.checkpoint;
      if (
        checkpoint.lastEventSequence !==
          checkpointing.contract.lastEventSequence ||
        checkpoint.runtimeRevision !== checkpointing.contract.runtimeRevision ||
        checkpoint.runtimeGeneration !==
          checkpointing.runtimeLease.generation ||
        checkpoint.policyVersion !== checkpointing.contract.policyVersion ||
        !sameJson(
          checkpoint.workspaceRevisionReceipt,
          checkpointing.workspaceRevisionReceipt,
        )
      )
        throw new SessionRefusal("checkpoint_mismatch");
      return { kind: "sleeping", state };
    }
    case "cancellation_started": {
      const state = transition.state;
      const target: CancellationTarget =
        state.plan.kind === "turn"
          ? { kind: "turn", turnId: state.plan.turnId }
          : { kind: "session", reason: state.plan.reason };
      if (!sameJson(decideCancellationStart(current, target), state))
        throw new SessionRefusal("contract_mismatch");
      return { kind: "cancelling", state };
    }
    case "cancellation_resolved": {
      const resolution = transition.resolution;
      let input: CancellationResolutionInput;
      switch (resolution.kind) {
        case "sleeping":
          input = { kind: "return_to_sleeping" };
          break;
        case "checkpointing":
          input = {
            kind: "begin_checkpointing",
            workspaceRevisionReceipt: resolution.state.workspaceRevisionReceipt,
          };
          break;
        case "terminal":
          input = {
            kind: "terminate",
            terminalAt: resolution.state.terminalAt,
          };
          break;
      }
      if (!sameJson(decideCancellationResolution(current, input), resolution))
        throw new SessionRefusal("contract_mismatch");
      return resolvedLifecycle(resolution);
    }
    case "session_quarantined":
      if (
        !sameJson(
          decideQuarantine(current, transition.state.reason),
          transition.state,
        )
      )
        throw new SessionRefusal("contract_mismatch");
      return { kind: "quarantined", state: transition.state };
    case "session_recovered":
      if (!sameJson(decideRecovery(current), transition.state))
        throw new SessionRefusal("contract_mismatch");
      return { kind: "activating", state: transition.state };
    case "session_terminated":
      if (
        !sameJson(
          decideTermination(
            current,
            transition.state.reason,
            transition.state.terminalAt,
          ),
          transition.state,
        )
      )
        throw new SessionRefusal("contract_mismatch");
      return { kind: "terminal", state: transition.state };
  }
}

function resolvedLifecycle(
  resolution: CancellationResolution,
): AgentSessionLifecycle {
  switch (resolution.kind) {
    case "sleeping":
      return { kind: "sleeping", state: resolution.state };
    case "checkpointing":
      return { kind: "checkpointing", state: resolution.state };
    case "terminal":
      return { kind: "terminal", state: resolution.state };
  }
}

/** Every contract field stays, and the event sequence moves on by one. */
function contractAdvances(
  current: SessionContract,
  next: SessionContract,
): boolean {
  return (
    current.policyVersion === next.policyVersion &&
    current.budgetRevision === next.budgetRevision &&
    current.runtimeRevision === next.runtimeRevision &&
    successor(current.lastEventSequence) === next.lastEventSequence
  );
}

function nextSessionContract(current: SessionContract): SessionContract {
  return {
    policyVersion: current.policyVersion,
    budgetRevision: current.budgetRevision,
    runtimeRevision: current.runtimeRevision,
    modelRoute: current.modelRoute,
    lastEventSequence: successor(current.lastEventSequence),
  };
}

function ensureNextContract(
  current: SessionContract,
  next: SessionContract,
): void {
  if (!sameJson(nextSessionContract(current), next))
    throw new SessionRefusal("contract_mismatch");
}

function turnIdentity(turn: TurnLifecycle): TurnIdentity {
  return turn.state.identity;
}

function resumeWorkspaceReceipt(
  resumePoint: SessionResumePoint,
): WorkspaceRevisionReceipt {
  return resumePoint.kind === "new"
    ? resumePoint.workspaceRevisionReceipt
    : resumePoint.checkpoint.workspaceRevisionReceipt;
}

function validExecutionWorkspaceReceipt(
  current: WorkspaceRevisionReceipt,
  candidate: WorkspaceRevisionReceipt,
  executionReceiptId: string,
): boolean {
  if (candidate.workspaceId !== current.workspaceId) return false;
  if (sameJson(candidate, current)) return true;
  return (
    candidate.causation.kind === "effect_receipt" &&
    candidate.causation.receiptId === executionReceiptId
  );
}

function lifecycleSequence(state: AgentSessionLifecycle): number {
  return state.state.contract.lastEventSequence;
}

function restoreFromSnapshotAndTail(
  snapshot: { lastSequence: number; state: AgentSessionLifecycle } | null,
  tail: readonly { sequence: number; transition: SessionTransition }[],
): AgentSessionLifecycle {
  let current = snapshot?.state ?? null;
  let expected: number;
  if (snapshot !== null) {
    if (lifecycleSequence(snapshot.state) !== snapshot.lastSequence)
      throw new SessionRefusal("snapshot_sequence_mismatch");
    expected = successor(snapshot.lastSequence);
  } else expected = 0;
  for (const entry of tail) {
    if (expected !== entry.sequence)
      throw new SessionRefusal("tail_sequence_gap");
    const next = reduceSessionTransition(current, entry.transition);
    if (lifecycleSequence(next) !== entry.sequence)
      throw new SessionRefusal("transition_sequence_mismatch");
    current = next;
    expected = successor(entry.sequence);
  }
  if (current === null) throw new SessionRefusal("empty_history");
  return current;
}

function validateCheckpointRecord(
  lifecycle: AgentSessionLifecycle,
  record: HarnessCheckpointRecord,
): void {
  if (lifecycle.kind !== "processing")
    throw new SessionRefusal("session_not_processing");
  const state = lifecycle.state;
  if (!sameJson(record.session, state.identity))
    throw new SessionRefusal("session_identity_mismatch");
  if (!sameJson(record.turn, turnIdentity(state.activeTurn)))
    throw new SessionRefusal("turn_identity_mismatch");
  if (!sameJson(record.runtimeLease, state.runtimeLease))
    throw new SessionRefusal("runtime_lease_mismatch");
  if (record.runtimeRevision !== state.contract.runtimeRevision)
    throw new SessionRefusal("runtime_revision_mismatch");
  if (record.policyVersion !== state.contract.policyVersion)
    throw new SessionRefusal("policy_version_mismatch");
  if (record.budgetRevision !== state.contract.budgetRevision)
    throw new SessionRefusal("budget_revision_mismatch");
  if (
    record.modelRouteDigest !== digestModelRouteSync(state.contract.modelRoute)
  )
    throw new SessionRefusal("model_route_digest_mismatch");
  if (record.lastActorEventSequence !== state.contract.lastEventSequence)
    throw new SessionRefusal("actor_event_sequence_mismatch");
  if (
    record.workspaceBaseRevision !==
    resumeWorkspaceReceipt(state.resumePoint).revision
  )
    throw new SessionRefusal("workspace_base_revision_mismatch");
  if (!sameJson(record.cursor.turn, record.turn))
    throw new SessionRefusal("cursor_turn_mismatch");
}

function validateCheckpointRestoreRecord(
  lifecycle: AgentSessionLifecycle,
  record: HarnessCheckpointRecord,
): void {
  if (lifecycle.kind !== "processing")
    throw new SessionRefusal("session_not_processing");
  const state = lifecycle.state;
  if (state.resumePoint.kind !== "checkpoint")
    throw new SessionRefusal("resume_point_missing");
  const checkpoint = state.resumePoint.checkpoint;
  if (!sameJson(record.session, state.identity))
    throw new SessionRefusal("session_identity_mismatch");
  if (!sameJson(record.cursor.turn, record.turn))
    throw new SessionRefusal("cursor_turn_mismatch");
  if (record.blob.sha256 !== checkpoint.stateDigest)
    throw new SessionRefusal("checkpoint_state_digest_mismatch");
  if (record.runtimeRevision !== checkpoint.runtimeRevision)
    throw new SessionRefusal("runtime_revision_mismatch");
  if (record.runtimeLease.generation !== checkpoint.runtimeGeneration)
    throw new SessionRefusal("runtime_lease_mismatch");
  if (record.policyVersion !== checkpoint.policyVersion)
    throw new SessionRefusal("policy_version_mismatch");
  if (record.budgetRevision !== checkpoint.budgetRevision)
    throw new SessionRefusal("budget_revision_mismatch");
  if (!sameJson(record.budgetUsage, checkpoint.budgetUsage))
    throw new SessionRefusal("budget_usage_mismatch");
  if (record.usageCursor !== checkpoint.usageCursor)
    throw new SessionRefusal("budget_usage_cursor_mismatch");
  if (record.budgetAccountDigest !== checkpoint.budgetAccountDigest)
    throw new SessionRefusal("budget_account_digest_mismatch");
  if (
    record.modelRouteDigest !== digestModelRouteSync(state.contract.modelRoute)
  )
    throw new SessionRefusal("model_route_digest_mismatch");
  if (successor(record.lastActorEventSequence) !== checkpoint.lastEventSequence)
    throw new SessionRefusal("checkpoint_sequence_mismatch");
  if (record.workspaceRevision !== checkpoint.workspaceRevisionReceipt.revision)
    throw new SessionRefusal("workspace_revision_mismatch");
  if (checkpoint.checkpointId !== harnessCheckpointIdSync(record))
    throw new SessionRefusal("checkpoint_id_mismatch");
}
