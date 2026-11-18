import type { AdapterCapability } from "./AdapterCapability";
import type { EffectId } from "./EffectId";
import type { EffectKind } from "./EffectKind";
import type { EffectReceiptId } from "./EffectReceiptId";
import type { EventBody } from "./EventBody";
import type { Timestamp } from "./Timestamp";

export type SettledEffect<Receipt> = {
  effectId: EffectId;
  kind: EffectKind;
  capability: AdapterCapability;
  receiptId: EffectReceiptId;
  receipt: EventBody<Receipt>;
  settledAt: Timestamp;
};
