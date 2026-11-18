import type { AdapterCapability } from "./AdapterCapability";
import type { DispatchAttempt } from "./DispatchAttempt";
import type { DispatchId } from "./DispatchId";
import type { EffectId } from "./EffectId";
import type { EffectKind } from "./EffectKind";
import type { EventBody } from "./EventBody";
import type { IdempotencyKey } from "./IdempotencyKey";
import type { Timestamp } from "./Timestamp";

export type DispatchingEffect<Request> = {
  effectId: EffectId;
  kind: EffectKind;
  capability: AdapterCapability;
  idempotencyKey: IdempotencyKey;
  request: EventBody<Request>;
  dispatchId: DispatchId;
  attempt: DispatchAttempt;
  dispatchedAt: Timestamp;
};
