import type { ArtifactRef } from "./ArtifactRef";
import type { CaseEntryId } from "./CaseEntryId";
import type { Sha256Digest } from "./Sha256Digest";

export type CaseContextEntryRef =
  | {
      kind: "inline_preview";
      entryId: CaseEntryId;
      digest: Sha256Digest;
      preview: string;
    }
  | {
      kind: "artifact";
      entryId: CaseEntryId;
      digest: Sha256Digest;
      artifact: ArtifactRef;
    };
