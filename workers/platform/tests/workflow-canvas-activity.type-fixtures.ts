import type { CollaborationAgentActivity } from "@purin-labs/collaboration";

// @ts-expect-error An active operation requires an authenticated agent identity.
const missingAgent: CollaborationAgentActivity = { operationId: "move", target: "pack" };
// @ts-expect-error An active operation requires a target.
const missingTarget: CollaborationAgentActivity = { agent: { sessionId: "session", displayName: "Urk" }, operationId: "move" };
const anonymous = { agent: { sessionId: "session" }, operationId: "move", target: "pack" };
// @ts-expect-error Spreads cannot omit the authenticated display name.
const anonymousSpread: CollaborationAgentActivity = { ...anonymous };
void [missingAgent, missingTarget, anonymousSpread];
