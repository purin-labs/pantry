import type { ActorId } from "./ActorId";

export type ActorRefV1 =
  | { kind: "human"; userId: ActorId }
  | { kind: "agent"; agentId: ActorId; sessionId: ActorId }
  | { kind: "application"; applicationId: ActorId; installationId: ActorId }
  | { kind: "system"; component: ActorId; operation: ActorId };
