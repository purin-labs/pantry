import type { Signature } from "./Signature";
import type { SignatureAlgorithmV1 } from "./SignatureAlgorithmV1";
import type { SigningKeyId } from "./SigningKeyId";

export type ManifestSignerV1 = {
  keyId: SigningKeyId;
  algorithm: SignatureAlgorithmV1;
  signature: Signature;
};
