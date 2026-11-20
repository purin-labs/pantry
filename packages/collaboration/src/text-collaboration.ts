import type { CollaborationAgentActivity } from "./agent-presence.ts";
import type { CollaborationParticipant } from "./wire.ts";

export type TextCollaborationServerMessage<
  Update,
  StateVector,
  PresenceSelection,
  Metadata,
  FailureCode extends string,
> =
  | Readonly<{
      kind: "sync_response";
      serverStateVector: StateVector;
      missingUpdate: Update;
      metadata: Metadata;
      access: "read" | "edit";
      sessionId: string;
    }>
  | Readonly<{ kind: "update_accepted"; updateId: string }>
  | Readonly<{ kind: "update_broadcast"; update: Update }>
  | Readonly<{
      kind: "presence_changed";
      agents: readonly CollaborationAgentActivity[];
      participants: readonly CollaborationParticipant<PresenceSelection>[];
    }>
  | Readonly<{ kind: "failure"; code: FailureCode }>;
