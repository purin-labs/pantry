import type {
  PortalChatCleanupRequest,
  PortalChatErasure,
} from "@purin-labs/agent/actors/portal-chat-cleanup";
import type { SessionDO } from "../src/actors/agent-session";

declare const actor: SessionDO;
declare const request: PortalChatCleanupRequest;
declare const pending: Extract<PortalChatErasure, { kind: "pending" }>;
const { placement, placementFenceToken, ...unscoped } = request;
// @ts-expect-error Erasure admission requires captured placement and its fence.
actor.erasePortalChatSession(unscoped);
const { sessionId, ...unidentified } = request;
// @ts-expect-error The physical Actor must verify the logical session identity.
actor.erasePortalChatSession(unidentified);
// @ts-expect-error Completed erasure cannot retain objects awaiting deletion.
const invalid: PortalChatErasure = {
  kind: "erased",
  organisationId: request.requestingOrganisationId,
  sessionId: request.sessionId,
  objectKeys: [],
};
// @ts-expect-error Copying pending cleanup cannot produce a completed checkpoint.
const copied: PortalChatErasure = { ...pending, kind: "erased" };
