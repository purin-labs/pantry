import type { SignatureAlgorithmV1 } from "./SignatureAlgorithmV1";
import type { SigningKeyId } from "./SigningKeyId";

export type SignerDescriptorV1 = {
  keyId: SigningKeyId;
  algorithm: SignatureAlgorithmV1;
};
