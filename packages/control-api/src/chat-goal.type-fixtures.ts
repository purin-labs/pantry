import type { ChatGoalSupport } from "./chat-goal.ts";

// @ts-expect-error A supported route cannot carry an unsupported-route reason.
const mixedSupport: ChatGoalSupport = {
  kind: "supported",
  backend: "pi",
  code: "missing_authority",
};
const failure = { code: "missing_authority" };
// @ts-expect-error Spreading failure fields cannot create supported state.
const spreadSupport: ChatGoalSupport = {
  kind: "supported",
  backend: "pi",
  ...failure,
};
void mixedSupport;
void spreadSupport;
