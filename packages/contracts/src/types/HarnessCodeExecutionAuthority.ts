import type { EffectReceiptId } from "./EffectReceiptId";
import type { Sha256Digest } from "./Sha256Digest";

export type HarnessCodeExecutionAuthority = {
  kind: "code_execution";
  receiptId: EffectReceiptId;
  resultDigest: Sha256Digest;
};
