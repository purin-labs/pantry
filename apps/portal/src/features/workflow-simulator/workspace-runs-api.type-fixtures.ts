import type { PreparedWorkspaceRun } from "./workspace-runs-api";

declare const inline: Extract<PreparedWorkspaceRun, { kind: "inline" }>;
declare const artifacts: Extract<PreparedWorkspaceRun, { kind: "artifacts" }>;

// @ts-expect-error A staged publication requires its verified files.
export const missingFiles: PreparedWorkspaceRun = {
  kind: "artifacts",
  snapshot: inline.snapshot,
  id: inline.id,
  bytes: inline.bytes,
};

// @ts-expect-error A spread cannot turn an artifact publication into an inline write.
export const mixedPublication: PreparedWorkspaceRun = {
  ...artifacts,
  kind: "inline",
};
