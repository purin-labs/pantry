import type { ActorId } from "./ActorId";
import type { ApplicationId } from "./ApplicationId";
import type { PrincipalId } from "./PrincipalId";
import type { SessionId } from "./SessionId";
import type { SystemComponentId } from "./SystemComponentId";

export type EventPrincipal =
  | { kind: "human"; principalId: PrincipalId }
  | { kind: "agent"; actorId: ActorId; sessionId: SessionId }
  | { kind: "application"; applicationId: ApplicationId }
  | { kind: "system"; componentId: SystemComponentId };
