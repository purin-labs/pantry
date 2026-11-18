import type { PreparedWorkspaceRun } from "./workspace-runs-api";
import type { Variant } from "@seams/type-utils";

declare const inline: Variant<PreparedWorkspaceRun, "inline">;
declare const artifacts: Variant<PreparedWorkspaceRun, "artifacts">;

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
