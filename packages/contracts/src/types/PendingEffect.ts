import type { AdapterCapability } from "./AdapterCapability";
import type { EffectId } from "./EffectId";
import type { EffectKind } from "./EffectKind";
import type { EventBody } from "./EventBody";
import type { IdempotencyKey } from "./IdempotencyKey";

export type PendingEffect<Request> = {
  effectId: EffectId;
  kind: EffectKind;
  capability: AdapterCapability;
  idempotencyKey: IdempotencyKey;
  request: EventBody<Request>;
};
