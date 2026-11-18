import type { ByteLength } from "./ByteLength";
import type { HarnessBuildId } from "./HarnessBuildId";
import type { HarnessCheckpointFormatVersion } from "./HarnessCheckpointFormatVersion";
import type { ObjectKey } from "./ObjectKey";
import type { Sha256Digest } from "./Sha256Digest";
import type { Timestamp } from "./Timestamp";

export type HarnessCheckpointBlobRef = {
  objectKey: ObjectKey;
  sha256: Sha256Digest;
  byteLength: ByteLength;
  formatVersion: HarnessCheckpointFormatVersion;
  harnessBuild: HarnessBuildId;
  createdAt: Timestamp;
};
