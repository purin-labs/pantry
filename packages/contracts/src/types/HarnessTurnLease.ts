import type { HarnessTurnLeaseId } from "./HarnessTurnLeaseId";
import type { RequestAuthority } from "./RequestAuthority";
import type { RuntimeLease } from "./RuntimeLease";
import type { RuntimeRevision } from "./RuntimeRevision";
import type { SessionIdentity } from "./SessionIdentity";
import type { Sha256Digest } from "./Sha256Digest";
import type { Timestamp } from "./Timestamp";
import type { TurnIdentity } from "./TurnIdentity";

export type HarnessTurnLease = {
  leaseId: HarnessTurnLeaseId;
  session: SessionIdentity;
  turn: TurnIdentity;
  runtimeLease: RuntimeLease;
  runtimeRevision: RuntimeRevision;
  requestAuthority: RequestAuthority;
  authorityPartitionDigest: Sha256Digest;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
};
