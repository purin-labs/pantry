import type { Timestamp } from "./Timestamp";
import type { TurnIdentity } from "./TurnIdentity";

export type AdmittedTurn = { identity: TurnIdentity; admittedAt: Timestamp };
