import type { EffectReceiptId } from "./EffectReceiptId";
import type { Sha256Digest } from "./Sha256Digest";

export type HarnessProviderEffectAuthority = {
  kind: "provider_effect";
  receiptId: EffectReceiptId;
  resultDigest: Sha256Digest;
};
