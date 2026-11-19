import { hasRustControl, rustTrim, utf8ByteLength } from "@purin-labs/std";
import { Type, type Static } from "typebox";
import {
  attachmentIdSchema,
  objectKeyBelongsTo,
  organisationAttachmentObjectKeySchema,
  parseOrganisationAttachmentObjectKey,
  parseSha256Digest,
  type AttachmentId,
  type OrganisationAttachmentObjectKey,
} from "./message.ts";
import {
  admitJson,
  messageError,
  parseShape,
  type MessageParseResult,
} from "./message-shape.ts";

// Plan 78: TypeScript port of attachment_preparation.rs.

export const messageAttachmentPreparationIdentitySchema = Type.Object({
  organisationId: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  attachmentId: attachmentIdSchema,
  sourceSha256: Type.String(),
  handlerRevision: Type.String(),
});
export const messageAttachmentPreparationLimitsSchema = Type.Object({
  maxInputBytes: Type.Number(),
  maxOutputBytes: Type.Number(),
  maxDurationMs: Type.Number(),
  maxFrames: Type.Number(),
});
export const messageAttachmentPreparationUsageSchema = Type.Object({
  activeWallMs: Type.Number(),
  inputBytes: Type.Number(),
  outputBytes: Type.Number(),
});
export const messageAttachmentPreparationOutcomeSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("prepared"),
    resultObjectKey: organisationAttachmentObjectKeySchema,
  }),
  Type.Object({ kind: Type.Literal("limited"), reason: Type.String() }),
]);
export const messageAttachmentPreparationReceiptSchema = Type.Object({
  identity: messageAttachmentPreparationIdentitySchema,
  limits: messageAttachmentPreparationLimitsSchema,
  resultDigest: Type.String(),
  derivedObjectKeys: Type.Array(organisationAttachmentObjectKeySchema),
  usage: messageAttachmentPreparationUsageSchema,
  completedAt: Type.Number(),
  outcome: messageAttachmentPreparationOutcomeSchema,
});
export const messageAttachmentPreparationStateSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("pending"),
    identity: messageAttachmentPreparationIdentitySchema,
    limits: messageAttachmentPreparationLimitsSchema,
    startedAt: Type.Number(),
    deadlineAt: Type.Number(),
  }),
  Type.Object({
    kind: Type.Literal("completed"),
    receipt: messageAttachmentPreparationReceiptSchema,
  }),
]);

export type MessageAttachmentPreparationIdentity = Static<
  typeof messageAttachmentPreparationIdentitySchema
>;
export type MessageAttachmentPreparationLimits = Static<
  typeof messageAttachmentPreparationLimitsSchema
>;
export type MessageAttachmentPreparationUsage = Static<
  typeof messageAttachmentPreparationUsageSchema
>;
export type MessageAttachmentPreparationOutcome = Static<
  typeof messageAttachmentPreparationOutcomeSchema
>;
export type MessageAttachmentPreparationReceipt = Static<
  typeof messageAttachmentPreparationReceiptSchema
>;
export type MessageAttachmentPreparationStateValue = Static<
  typeof messageAttachmentPreparationStateSchema
>;

// serde shapes of the Raw* boundary records; each has deny_unknown_fields.
const unsigned = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const strict = { additionalProperties: false } as const;
const rawIdentity = Type.Object(
  {
    organisationId: Type.String(),
    sessionId: Type.String(),
    turnId: Type.String(),
    attachmentId: Type.String(),
    sourceSha256: Type.String(),
    handlerRevision: Type.String(),
  },
  strict,
);
const rawLimits = Type.Object(
  {
    maxInputBytes: unsigned,
    maxOutputBytes: unsigned,
    maxDurationMs: unsigned,
    maxFrames: unsigned,
  },
  strict,
);
const rawUsage = Type.Object(
  { activeWallMs: unsigned, inputBytes: unsigned, outputBytes: unsigned },
  strict,
);
const rawOutcome = Type.Union([
  Type.Object(
    { kind: Type.Literal("prepared"), resultObjectKey: Type.String() },
    strict,
  ),
  Type.Object({ kind: Type.Literal("limited"), reason: Type.String() }, strict),
]);
const rawReceipt = Type.Object(
  {
    identity: rawIdentity,
    limits: rawLimits,
    resultDigest: Type.String(),
    derivedObjectKeys: Type.Array(Type.String()),
    usage: rawUsage,
    completedAt: unsigned,
    outcome: rawOutcome,
  },
  strict,
);
const rawState = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("pending"),
      identity: rawIdentity,
      limits: rawLimits,
      startedAt: unsigned,
      deadlineAt: unsigned,
    },
    strict,
  ),
  Type.Object({ kind: Type.Literal("completed"), receipt: rawReceipt }, strict),
]);

type Checked<T> = MessageParseResult<T>;

// The Rust error codes and their reason texts.
function refused(code: string, reason: string): Checked<never> {
  return { ok: false, error: messageError(code, reason) };
}
const invalidIdentity = (field: string) =>
  refused("invalid_identity", `invalid identity: ${field}`);
const invalidDigest = (field: string) =>
  refused("invalid_digest", `invalid digest: ${field}`);
const invalidObjectKey = (field: string) =>
  refused("invalid_object_key", `invalid organisation object key: ${field}`);
const invalidUsage = (field: string) =>
  refused("invalid_usage", `usage exceeds its limit: ${field}`);

/** Commerce `OrganisationId::new`: not blank and already trimmed. */
function isTrimmedIdentity(value: string): boolean {
  return rustTrim(value).length > 0 && value === rustTrim(value);
}

/** Pantry `actor_identity!` (SessionId, TurnId). */
function isActorIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    utf8ByteLength(value) <= 256 &&
    value === rustTrim(value) &&
    !hasRustControl(value)
  );
}

function isAttachmentId(value: string): boolean {
  const body = value.startsWith("att_") ? value.slice(4) : "";
  return body.length > 0 && body.length <= 64 && /^[0-9a-z]+$/u.test(body);
}

function parseIdentity(
  raw: Static<typeof rawIdentity>,
): Checked<MessageAttachmentPreparationIdentity> {
  if (!isTrimmedIdentity(raw.organisationId))
    return invalidIdentity("organisationId");
  if (!isActorIdentity(raw.sessionId)) return invalidIdentity("sessionId");
  if (!isActorIdentity(raw.turnId)) return invalidIdentity("turnId");
  if (!isAttachmentId(raw.attachmentId)) return invalidIdentity("attachmentId");
  const sourceSha256 = parseSha256Digest(raw.sourceSha256);
  if (sourceSha256 === null) return invalidDigest("sourceSha256");
  const revision = raw.handlerRevision;
  if (
    rustTrim(revision).length === 0 ||
    revision !== rustTrim(revision) ||
    utf8ByteLength(revision) > 256 ||
    hasRustControl(revision)
  )
    return refused(
      "invalid_handler_revision",
      "handler revision is empty or unsafe",
    );
  if (raw.organisationId.includes("/") || hasRustControl(raw.organisationId))
    return invalidIdentity("organisationId");
  return {
    ok: true,
    value: {
      organisationId: raw.organisationId,
      sessionId: raw.sessionId,
      turnId: raw.turnId,
      attachmentId: raw.attachmentId as AttachmentId,
      sourceSha256,
      handlerRevision: revision,
    },
  };
}

function parseLimits(
  raw: Static<typeof rawLimits>,
): Checked<MessageAttachmentPreparationLimits> {
  for (const field of [
    "maxInputBytes",
    "maxOutputBytes",
    "maxDurationMs",
    "maxFrames",
  ] as const)
    if (raw[field] === 0)
      return refused("invalid_limit", `limit must be positive: ${field}`);
  return {
    ok: true,
    value: {
      maxInputBytes: raw.maxInputBytes,
      maxOutputBytes: raw.maxOutputBytes,
      maxDurationMs: raw.maxDurationMs,
      maxFrames: raw.maxFrames,
    },
  };
}

function parseOutcome(
  raw: Static<typeof rawOutcome>,
): Checked<MessageAttachmentPreparationOutcome> {
  if (raw.kind === "prepared") {
    const key = parseOrganisationAttachmentObjectKey(raw.resultObjectKey);
    if (!key.ok) return invalidObjectKey("resultObjectKey");
    return {
      ok: true,
      value: { kind: "prepared", resultObjectKey: key.value },
    };
  }
  const reason = raw.reason;
  if (
    rustTrim(reason).length === 0 ||
    reason !== rustTrim(reason) ||
    utf8ByteLength(reason) > 512 ||
    hasRustControl(reason)
  )
    return refused("invalid_reason", "limited reason is empty or unsafe");
  return { ok: true, value: { kind: "limited", reason } };
}

function validateReceipt(
  receipt: MessageAttachmentPreparationReceipt,
): Checked<MessageAttachmentPreparationReceipt> {
  const seen = new Set<string>();
  for (const key of receipt.derivedObjectKeys) {
    if (!objectKeyBelongsTo(key, receipt.identity.organisationId))
      return invalidObjectKey(key);
    if (seen.has(key))
      return refused(
        "duplicate_object_key",
        "derived object keys must be unique",
      );
    seen.add(key);
  }
  const outcome = receipt.outcome;
  if (
    outcome.kind === "prepared" &&
    !receipt.derivedObjectKeys.includes(outcome.resultObjectKey)
  )
    return refused(
      "result_object_key_missing",
      "prepared result object key must be listed in derived object keys",
    );
  const { usage, limits } = receipt;
  if (usage.activeWallMs > limits.maxDurationMs)
    return invalidUsage("activeWallMs");
  if (usage.inputBytes > limits.maxInputBytes)
    return invalidUsage("inputBytes");
  if (usage.outputBytes > limits.maxOutputBytes)
    return invalidUsage("outputBytes");
  return { ok: true, value: receipt };
}

function parseReceipt(
  raw: Static<typeof rawReceipt>,
): Checked<MessageAttachmentPreparationReceipt> {
  const identity = parseIdentity(raw.identity);
  if (!identity.ok) return identity;
  const limits = parseLimits(raw.limits);
  if (!limits.ok) return limits;
  const resultDigest = parseSha256Digest(raw.resultDigest);
  if (resultDigest === null) return invalidDigest("resultDigest");
  const derivedObjectKeys: OrganisationAttachmentObjectKey[] = [];
  for (const key of raw.derivedObjectKeys) {
    const parsed = parseOrganisationAttachmentObjectKey(key);
    if (!parsed.ok) return invalidObjectKey("derivedObjectKeys");
    derivedObjectKeys.push(parsed.value);
  }
  const outcome = parseOutcome(raw.outcome);
  if (!outcome.ok) return outcome;
  return validateReceipt({
    identity: identity.value,
    limits: limits.value,
    resultDigest,
    derivedObjectKeys,
    usage: {
      activeWallMs: raw.usage.activeWallMs,
      inputBytes: raw.usage.inputBytes,
      outputBytes: raw.usage.outputBytes,
    },
    completedAt: raw.completedAt,
    outcome: outcome.value,
  });
}

/** Rust `validate_message_attachment_preparation`: a persisted state re-enters. */
export function parseMessageAttachmentPreparationState(
  input: unknown,
): MessageParseResult<MessageAttachmentPreparationStateValue> {
  const admitted = admitJson(input);
  if (!admitted.ok) return admitted;
  const shape = parseShape(rawState, input);
  if (!shape.ok)
    return refused(
      "invalid_request",
      "preparation state does not match the contract",
    );
  const raw = shape.value;
  if (raw.kind === "completed") {
    const receipt = parseReceipt(raw.receipt);
    return receipt.ok
      ? { ok: true, value: { kind: "completed", receipt: receipt.value } }
      : receipt;
  }
  const identity = parseIdentity(raw.identity);
  if (!identity.ok) return identity;
  const limits = parseLimits(raw.limits);
  if (!limits.ok) return limits;
  if (raw.deadlineAt < raw.startedAt)
    return refused(
      "invalid_deadline",
      "deadline must be at or after startedAt",
    );
  return {
    ok: true,
    value: {
      kind: "pending",
      identity: identity.value,
      limits: limits.value,
      startedAt: raw.startedAt,
      deadlineAt: raw.deadlineAt,
    },
  };
}
