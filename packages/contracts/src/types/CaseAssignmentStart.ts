import type { CommandId } from "./CommandId";
import type { SessionId } from "./SessionId";
import type { Timestamp } from "./Timestamp";

export type CaseAssignmentStart = {
  startId: CommandId;
  sessionId: SessionId;
  acceptedAt: Timestamp;
};
