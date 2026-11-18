import type { CommandId } from "./CommandId";
import type { ConnectorId } from "./ConnectorId";
import type { ConnectorIngressId } from "./ConnectorIngressId";
import type { EventId } from "./EventId";

export type CaseTriggerSource =
  | {
      kind: "connector";
      connectorId: ConnectorId;
      ingressId: ConnectorIngressId;
    }
  | { kind: "cue"; eventId: EventId }
  | { kind: "api"; commandId: CommandId };
