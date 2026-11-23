import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

// Refactor 10 step 2: the RPC inputs and stored records of ConnectorDO as
// TypeBox schemas. A schema checks the shape; the parser in the actor then
// copies only the named fields, so extra fields stay allowed and are dropped,
// as before. Message content and attachments keep their own parsers.

/** Text with at least one character that is not white space. */
export const nonBlankTextSchema = Type.String({ pattern: "\\S" });
/** A safe integer that is not negative: a count, a revision or a time. */
export const countSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const connectorIdentitySchema = Type.Object({
  organisationId: nonBlankTextSchema,
  connectorId: nonBlankTextSchema,
});

export const connectorIngressSchema = Type.Object({
  ingressId: nonBlankTextSchema,
  connectorId: nonBlankTextSchema,
  nativeEventId: nonBlankTextSchema,
  nativeCursor: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  receivedAt: countSchema,
  content: Type.Unknown(),
});

export const connectorIngressRequestSchema = Type.Object({
  identity: connectorIdentitySchema,
  ingress: Type.Unknown(),
});

export const connectorAddressSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("slack"),
    workspaceId: nonBlankTextSchema,
    channelId: nonBlankTextSchema,
    threadTs: nonBlankTextSchema,
  }),
  Type.Object({
    kind: Type.Literal("slack_channel"),
    workspaceId: nonBlankTextSchema,
    channelId: nonBlankTextSchema,
    // A channel address names no thread; the parser also refuses the key.
    threadTs: Type.Optional(Type.Never()),
  }),
  Type.Object({
    kind: Type.Literal("email_thread"),
    integrationAccountId: nonBlankTextSchema,
    gmailThreadId: nonBlankTextSchema,
  }),
  Type.Object({
    kind: Type.Literal("whatsapp_conversation"),
    integrationAccountId: nonBlankTextSchema,
    waId: nonBlankTextSchema,
  }),
]);

export const connectorDeliverySchema = Type.Object({
  deliveryId: nonBlankTextSchema,
  bindingId: nonBlankTextSchema,
  caseId: nonBlankTextSchema,
  caseRevision: countSchema,
  idempotencyKey: nonBlankTextSchema,
  addressedAt: countSchema,
  content: Type.Unknown(),
  address: Type.Unknown(),
});

export const connectorDeliveryRequestSchema = Type.Object({
  identity: connectorIdentitySchema,
  requestedAt: countSchema,
  delivery: Type.Unknown(),
});

export const connectorDeliveryReceiptSchema = Type.Object({
  deliveryId: nonBlankTextSchema,
  connectorId: nonBlankTextSchema,
  idempotencyKey: nonBlankTextSchema,
  nativeReceiptId: nonBlankTextSchema,
  deliveredAt: countSchema,
});

const attemptSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

/** The stored delivery state, before the actor reads its receipt. */
export const connectorDeliveryStateSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("sending"),
    attempt: attemptSchema,
    leaseExpiresAt: countSchema,
  }),
  Type.Object({
    kind: Type.Literal("retryable"),
    attempt: attemptSchema,
    reason: nonBlankTextSchema,
    retryAt: countSchema,
  }),
  Type.Object({ kind: Type.Literal("delivered"), receipt: Type.Unknown() }),
  Type.Object({ kind: Type.Literal("rejected"), reason: nonBlankTextSchema }),
]);

export type ConnectorAddressWire = Static<typeof connectorAddressSchema>;
export type ConnectorDeliveryStateWire = Static<
  typeof connectorDeliveryStateSchema
>;

/** The value as the schema's type, or null when it does not match. */
export function checked<S extends TSchema>(
  schema: S,
  value: unknown,
): Static<S> | null {
  return Value.Check(schema, value) ? (value as Static<S>) : null;
}

// WhatsApp support (Plan 32).

/** A safe integer above zero: a version, a revision or a limit. */
export const positiveCountSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const optionalTextOrNull = Type.Optional(
  Type.Union([Type.Null(), nonBlankTextSchema]),
);

export const whatsappIdentityRequestSchema = Type.Object({
  identity: connectorIdentitySchema,
  now: countSchema,
});

export const whatsappLimitsSchema = Type.Object({
  maxActiveCases: positiveCountSchema,
  maxMessagesPerHour: positiveCountSchema,
  dailyAgentTokenBudget: positiveCountSchema,
  maxMessageBytes: positiveCountSchema,
  maxActiveCaseMessages: positiveCountSchema,
  maxActiveCaseBytes: positiveCountSchema,
  debounceSeconds: Type.Integer({ minimum: 10, maximum: 30 }),
});

export const whatsappAuthorityFieldsSchema = Type.Object({
  limits: whatsappLimitsSchema,
  policyVersion: positiveCountSchema,
  supportBindingId: nonBlankTextSchema,
  bindingRevision: positiveCountSchema,
  credentialGeneration: positiveCountSchema,
});

export const whatsappResumeFieldsSchema = Type.Object({
  skipProviderMessageId: optionalTextOrNull,
});

export const whatsappConversationHeadsFieldsSchema = Type.Object({
  caseIds: Type.Array(nonBlankTextSchema, { maxItems: 100 }),
});

export const whatsappEditFieldsSchema = Type.Object({
  body: nonBlankTextSchema,
  maxReplyChars: positiveCountSchema,
});

export const whatsappDispatchFieldsSchema = Type.Object({
  approvedVersion: positiveCountSchema,
  approvedBodyDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  approvedBy: nonBlankTextSchema,
});

export const whatsappDisposalFieldsSchema = Type.Object({
  actorUserId: nonBlankTextSchema,
  state: Type.Union([
    Type.Literal("rejected"),
    Type.Literal("taken_over"),
    Type.Literal("revoked"),
    Type.Literal("expired"),
  ]),
});

export const whatsappResolutionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("not_delivered") }),
  Type.Object({
    kind: Type.Literal("delivered"),
    whatsappMessageId: nonBlankTextSchema,
  }),
]);

export const whatsappHumanReplyFieldsSchema = Type.Object({
  proposalId: nonBlankTextSchema,
  body: nonBlankTextSchema,
  maxReplyChars: positiveCountSchema,
  expiresAt: countSchema,
});

export const whatsappEventSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("text_message"),
    customerWaId: nonBlankTextSchema,
    providerMessageId: nonBlankTextSchema,
    providerTimestamp: countSchema,
    body: nonBlankTextSchema,
  }),
  Type.Object({
    kind: Type.Literal("unsupported_message"),
    customerWaId: nonBlankTextSchema,
    providerMessageId: nonBlankTextSchema,
    messageType: nonBlankTextSchema,
  }),
  Type.Object({
    kind: Type.Literal("status"),
    whatsappMessageId: nonBlankTextSchema,
    statusAt: countSchema,
    status: Type.Union([
      Type.Literal("sent"),
      Type.Literal("delivered"),
      Type.Literal("read"),
      Type.Literal("failed"),
    ]),
    failureCode: optionalTextOrNull,
  }),
]);

/** A record with one required text field, such as `caseId` or `proposalId`. */
export function textFieldSchema<K extends string>(key: K) {
  return Type.Object({ [key]: nonBlankTextSchema } as Record<K, typeof nonBlankTextSchema>);
}

// The Connector's mailbox (Plans 29 and 40D). A request that names its exact
// keys is a strict object; the others allow extra keys, as before.

const strict = { additionalProperties: false } as const;
const digestSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const strictConnectorIdentitySchema = Type.Object(
  {
    organisationId: nonBlankTextSchema,
    connectorId: nonBlankTextSchema,
  },
  strict,
);

export const emailRevocationFieldsSchema = Type.Object({
  kind: Type.Union([Type.Literal("stand_down"), Type.Literal("erase")]),
  integrationAccountId: Type.String(),
});

export const emailMailboxSearchRequestSchema = Type.Object(
  {
    identity: strictConnectorIdentitySchema,
    execution: Type.Unknown(),
    now: countSchema,
    query: nonBlankTextSchema,
    limit: Type.Integer({ minimum: 1, maximum: 10 }),
  },
  strict,
);

export const emailReplyProposalCreateRequestSchema = Type.Object(
  {
    identity: strictConnectorIdentitySchema,
    execution: Type.Unknown(),
    now: countSchema,
    caseId: nonBlankTextSchema,
    proposalId: nonBlankTextSchema,
    threadId: nonBlankTextSchema,
    messageId: nonBlankTextSchema,
    body: nonBlankTextSchema,
    sources: Type.Unknown(),
    chatSources: Type.Unknown(),
    chatContext: Type.Unknown(),
  },
  strict,
);

export const emailOperationalProposalCreateRequestSchema = Type.Object(
  {
    identity: Type.Unknown(),
    execution: Type.Unknown(),
    now: Type.Unknown(),
    integrationAccountId: nonBlankTextSchema,
    caseId: nonBlankTextSchema,
    proposalId: nonBlankTextSchema,
    target: Type.Unknown(),
    subject: nonBlankTextSchema,
    body: nonBlankTextSchema,
    policyVersion: countSchema,
    expiresAt: countSchema,
  },
  strict,
);

export const emailOperationalProposalEditRequestSchema = Type.Object(
  {
    identity: Type.Unknown(),
    now: Type.Unknown(),
    integrationAccountId: nonBlankTextSchema,
    proposalId: nonBlankTextSchema,
    subject: nonBlankTextSchema,
    body: nonBlankTextSchema,
    /** The version that the person started from; a newer one is a conflict. */
    expectedVersion: Type.Optional(positiveCountSchema),
  },
  strict,
);

export const emailOperationalProposalRequestSchema = Type.Object(
  {
    identity: Type.Unknown(),
    now: Type.Unknown(),
    integrationAccountId: nonBlankTextSchema,
    proposalId: nonBlankTextSchema,
  },
  strict,
);

export const emailOperationalAccountRequestSchema = Type.Object(
  {
    identity: Type.Unknown(),
    now: Type.Unknown(),
    integrationAccountId: nonBlankTextSchema,
  },
  strict,
);

export const emailOperationalDispatchRequestSchema = Type.Object(
  {
    identity: Type.Unknown(),
    now: Type.Unknown(),
    integrationAccountId: nonBlankTextSchema,
    proposalId: nonBlankTextSchema,
    approvedVersion: positiveCountSchema,
    approvedSnapshotDigest: digestSchema,
  },
  strict,
);

export const emailResolveFieldsSchema = Type.Object({
  dispatchVersion: positiveCountSchema,
});

export const emailDispatchFieldsSchema = Type.Object({
  approvedVersion: positiveCountSchema,
  approvedSnapshotDigest: digestSchema,
});

export const emailChangeFieldsSchema = Type.Object({
  notificationId: nonBlankTextSchema,
  historyId: Type.String({ pattern: "^[0-9]+$" }),
});

export const emailCheckFieldsSchema = Type.Object({
  integrationAccountId: Type.String(),
  checkId: Type.String(),
});

export const emailLimitsSchema = Type.Object({
  maxActiveCases: positiveCountSchema,
  maxMessagesPerHour: positiveCountSchema,
  dailyTokenBudget: positiveCountSchema,
  maxMessageBytes: positiveCountSchema,
  maxAttachmentBytes: positiveCountSchema,
});

export const emailActivationFieldsSchema = Type.Object({
  integrationAccountId: nonBlankTextSchema,
  policyVersion: positiveCountSchema,
  limits: Type.Unknown(),
});

export const emailReconnectFieldsSchema = Type.Object({
  resetCursor: Type.Boolean(),
});

export const emailResumeFieldsSchema = Type.Object({
  policyVersion: positiveCountSchema,
  limits: Type.Unknown(),
  skipProviderMessageId: optionalTextOrNull,
});

/** The connector address with only its named fields, or null. */
export function parseConnectorAddressWire(
  value: unknown,
): ConnectorAddressWire | null {
  const address = checked(connectorAddressSchema, value);
  if (address === null) return null;
  switch (address.kind) {
    case "slack":
      return {
        kind: "slack",
        workspaceId: address.workspaceId,
        channelId: address.channelId,
        threadTs: address.threadTs,
      };
    case "slack_channel":
      // A channel address names no thread, not even an undefined one.
      return "threadTs" in address
        ? null
        : {
            kind: "slack_channel",
            workspaceId: address.workspaceId,
            channelId: address.channelId,
          };
    case "email_thread":
      return {
        kind: "email_thread",
        integrationAccountId: address.integrationAccountId,
        gmailThreadId: address.gmailThreadId,
      };
    case "whatsapp_conversation":
      return {
        kind: "whatsapp_conversation",
        integrationAccountId: address.integrationAccountId,
        waId: address.waId,
      };
  }
}
