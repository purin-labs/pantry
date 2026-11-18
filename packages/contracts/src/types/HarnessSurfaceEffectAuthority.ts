import type { EffectReceiptId } from "./EffectReceiptId";
import type { Sha256Digest } from "./Sha256Digest";

export type HarnessSurfaceEffectAuthority = {
  kind: "surface_effect";
  receiptId: EffectReceiptId;
  resultDigest: Sha256Digest;
};
