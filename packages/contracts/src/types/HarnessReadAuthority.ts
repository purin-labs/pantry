import type { Sha256Digest } from "./Sha256Digest";

export type HarnessReadAuthority = { kind: "read"; resultDigest: Sha256Digest };
