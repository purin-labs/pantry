import type { SessionCapabilityProfile } from "./SessionCapabilityProfile";
import type { Sha256Digest } from "./Sha256Digest";

export type SessionAuthority = {
  capabilityProfile: SessionCapabilityProfile;
  authorityPartitionDigest: Sha256Digest;
};
