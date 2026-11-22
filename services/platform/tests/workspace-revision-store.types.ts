import type { PreparedWorkspaceRevisionMutation } from "@purin-labs/agent/workspace-revision-store";

const rawPreparedMutation = {};

// @ts-expect-error Prepared revisions can only come from the verified R2 boundary.
const invalidPreparedMutation: PreparedWorkspaceRevisionMutation =
  rawPreparedMutation;

void invalidPreparedMutation;
