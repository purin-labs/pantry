import type { CommandId } from "./CommandId";
import type { EffectReceiptId } from "./EffectReceiptId";
import type { EventId } from "./EventId";
import type { IngressObservationId } from "./IngressObservationId";
import type { MigrationId } from "./MigrationId";
import type { ScheduleId } from "./ScheduleId";

export type CausationRef =
  | { kind: "ingress"; observationId: IngressObservationId }
  | { kind: "schedule"; scheduleId: ScheduleId }
  | { kind: "command"; commandId: CommandId }
  | { kind: "event"; eventId: EventId }
  | { kind: "effect_receipt"; receiptId: EffectReceiptId }
  | { kind: "migration"; migrationId: MigrationId };
