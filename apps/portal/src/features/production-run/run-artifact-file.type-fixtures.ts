import type { RunArtifactFile } from "@purin-labs/production-simulation/runs/run-artifact-file";

declare const verified: RunArtifactFile;
// @ts-expect-error A spread loses the file's validated source and cannot create another verified artifact.
export const forged: RunArtifactFile = { ...verified };
export const contentOnly: RunArtifactFile = {
  digest: verified.digest,
  // @ts-expect-error An artifact string cannot replace a verified file.
  content: "bytes",
};
