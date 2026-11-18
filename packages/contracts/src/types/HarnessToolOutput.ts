import type { ArtifactRef } from "./ArtifactRef";
import type { HarnessHistoryContent } from "./HarnessHistoryContent";
import type { Sha256Digest } from "./Sha256Digest";

export type HarnessToolOutput =
  | {
      kind: "inline";
      content: Array<HarnessHistoryContent>;
      digest: Sha256Digest;
    }
  | {
      kind: "artifact";
      artifact: ArtifactRef;
      preview: string;
      digest: Sha256Digest;
    };
