import type { AuthorityPartitionKey } from "./AuthorityPartitionKey";
import type { PolicyVersion } from "./PolicyVersion";
import type { Sha256Digest } from "./Sha256Digest";

export type AuthorityPartition = {
  digest: Sha256Digest;
  key: AuthorityPartitionKey;
  selectedGrantSetDigest: Sha256Digest;
  capabilityKeys: Array<string>;
  policyVersion: PolicyVersion;
};
