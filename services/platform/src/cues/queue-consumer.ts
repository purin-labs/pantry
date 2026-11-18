import {
  cueSnapshotKey,
  matchCueSubscriptions,
  parseCueQueueMessage,
  parseCueSnapshot,
  type CueQueueMessage,
  type NormalizedCueEvent,
  type TierOneCueSubscription,
} from "./engine";
import {
  addIgnoredCueToBatch,
  flushIgnoredCueBatch,
  type IgnoredCueAggregate,
  type IgnoredCueKv,
} from "./ignore-aggregate";
import { newRequestId } from "../ids";
import { traceLog, traceWarn } from "../observability";

export type CueMatchedDeliveryOutcome =
  { kind: "complete" } | { kind: "retry"; retryAt: number };

export type CueMatchedDelivery<TContext> = (
  context: TContext,
  message: CueQueueMessage,
  subscriptions: readonly TierOneCueSubscription[],
) => Promise<CueMatchedDeliveryOutcome>;

export type CueMutationAuthorizationOutcome =
  | { readonly kind: "authorized" }
  | { readonly kind: "drop" }
  | { readonly kind: "retry"; readonly retryAt: number };

export type CueMutationAuthorization<TContext> = (
  context: TContext,
  message: CueQueueMessage,
) => Promise<CueMutationAuthorizationOutcome>;

/**
 * Tells the cue's source that the queue is done with it: delivered, ignored
 * or dropped. A source that sends cues again stops sending this one.
 */
export type CueSettlement<TContext> = (
  context: TContext,
  message: CueQueueMessage,
) => Promise<void>;

export type CueQueueConsumerInput<TContext> = {
  messages: readonly Message<unknown>[];
  kv: IgnoredCueKv;
  deliveryContext: TContext;
  authorizeMutation: CueMutationAuthorization<TContext>;
  deliverMatched: CueMatchedDelivery<TContext>;
  settle: CueSettlement<TContext>;
  retryDelaySeconds: number;
  now: () => number;
};

type CueQueueProcessingOutcome =
  { kind: "processed" } | { kind: "ignored"; event: NormalizedCueEvent };

export async function processCueQueueBatch<TContext>(
  input: CueQueueConsumerInput<TContext>,
): Promise<void> {
  const ignored = new Map<string, IgnoredCueAggregate>();

  for (const message of input.messages) {
    const outcome = await processCueQueueMessage(message, input);

    if (outcome.kind === "ignored") {
      addIgnoredCueToBatch(ignored, outcome.event, input.now());
    }
  }

  if (ignored.size === 0) {
    return;
  }

  try {
    await flushIgnoredCueBatch(input.kv, ignored);
  } catch (error) {
    traceWarn("cue_queue.ignore_aggregate_failed", {
      requestId: newRequestId(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function processCueQueueMessage<TContext>(
  message: Message<unknown>,
  input: CueQueueConsumerInput<TContext>,
): Promise<CueQueueProcessingOutcome> {
  const parsed = parseCueQueueMessage(message.body);

  if (!parsed.ok) {
    traceWarn("cue_queue.invalid_message", {
      requestId: newRequestId(),
      message_id: message.id,
      error_code: parsed.error.code,
      field: parsed.error.code === "invalid_field" ? parsed.error.field : "",
    });
    message.ack();
    return { kind: "processed" };
  }

  const rawSnapshot = await input.kv.get(
    cueSnapshotKey(parsed.value.event.organisationId),
    "json",
  );

  if (rawSnapshot === null) {
    traceLog("cue_queue.no_snapshot", {
      requestId: parsed.value.requestId,
      organisation_id: parsed.value.event.organisationId,
      native_id: parsed.value.event.nativeId,
    });
    const authorization = await authorizeCueMutation(input, parsed.value);

    if (authorization !== null) {
      await settleCueAuthorization(message, parsed.value, authorization, input);
      return { kind: "processed" };
    }

    await ackSettled(message, parsed.value, input);
    return { kind: "ignored", event: parsed.value.event };
  }

  const snapshot = parseCueSnapshot(rawSnapshot);

  if (!snapshot.ok) {
    traceWarn("cue_queue.invalid_snapshot", {
      requestId: parsed.value.requestId,
      organisation_id: parsed.value.event.organisationId,
      error_code: snapshot.error.code,
    });
    message.retry({ delaySeconds: input.retryDelaySeconds });
    return { kind: "processed" };
  }

  const subscriptions = matchCueSubscriptions(
    snapshot.value,
    parsed.value.event,
  );
  const authorization = await authorizeCueMutation(input, parsed.value);

  if (authorization !== null) {
    await settleCueAuthorization(message, parsed.value, authorization, input);
    return { kind: "processed" };
  }

  if (subscriptions.length === 0) {
    await ackSettled(message, parsed.value, input);
    return { kind: "ignored", event: parsed.value.event };
  }

  const outcome = await input.deliverMatched(
    input.deliveryContext,
    parsed.value,
    subscriptions,
  );

  if (outcome.kind === "retry") {
    const delaySeconds = Math.max(
      1,
      Math.ceil((outcome.retryAt - input.now()) / 1_000),
    );
    message.retry({ delaySeconds });
    return { kind: "processed" };
  }

  await ackSettled(message, parsed.value, input);
  return { kind: "processed" };
}

async function ackSettled<TContext>(
  message: Message<unknown>,
  cue: CueQueueMessage,
  input: CueQueueConsumerInput<TContext>,
): Promise<void> {
  message.ack();
  try {
    await input.settle(input.deliveryContext, cue);
  } catch (error) {
    // The source sends the cue again later; its claim answers as a duplicate.
    traceWarn("cue_queue.settle_failed", {
      requestId: cue.requestId,
      organisation_id: cue.event.organisationId,
      native_id: cue.event.nativeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function authorizeCueMutation<TContext>(
  input: CueQueueConsumerInput<TContext>,
  message: CueQueueMessage,
): Promise<Exclude<
  CueMutationAuthorizationOutcome,
  { readonly kind: "authorized" }
> | null> {
  const authorization = await input.authorizeMutation(
    input.deliveryContext,
    message,
  );

  return authorization.kind === "authorized" ? null : authorization;
}

async function settleCueAuthorization<TContext>(
  message: Message<unknown>,
  cue: CueQueueMessage,
  authorization: Exclude<
    CueMutationAuthorizationOutcome,
    { readonly kind: "authorized" }
  >,
  input: CueQueueConsumerInput<TContext>,
): Promise<void> {
  if (authorization.kind === "drop") {
    await ackSettled(message, cue, input);
    return;
  }

  const delaySeconds = Math.max(
    1,
    Math.ceil((authorization.retryAt - input.now()) / 1_000),
  );
  message.retry({ delaySeconds });
}
