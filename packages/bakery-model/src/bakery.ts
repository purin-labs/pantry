import type {
  CommerceEntity,
  CommerceRelationship,
} from "@purin-labs/commerce-contracts";
import { sha256Hex } from "@purin-labs/std";

export type StationId = "stage" | "portion" | "bake" | "cool" | "pack";

export type Operation = StationId | "demould" | "finishCooling";

export type SettingsField =
  | "batchCount"
  | "workerCount"
  | "rackTrays"
  | "ovenTrays"
  | "traysPerBatch"
  | "piecesPerTray"
  | "loadWindow"
  | "loadSeconds"
  | "unloadSeconds"
  | Operation
  | "horizonMinutes"
  | "outageStart"
  | "outageEnd";

export const fields: readonly {
  key: SettingsField;
  label: string;
  min: number;
  max: number;
  value: number;
}[] = [
  { key: "batchCount", label: "Financier batches", min: 1, max: 6, value: 3 },
  { key: "workerCount", label: "Workers", min: 1, max: 3, value: 2 },
  {
    key: "rackTrays",
    label: "Cooling rack capacity (trays)",
    min: 1,
    max: 16,
    value: 8,
  },
  {
    key: "ovenTrays",
    label: "Usable oven capacity (trays)",
    min: 1,
    max: 6,
    value: 4,
  },
  { key: "traysPerBatch", label: "Trays per batch", min: 1, max: 4, value: 2 },
  {
    key: "piecesPerTray",
    label: "Financiers per tray",
    min: 1,
    max: 96,
    value: 24,
  },
  {
    key: "loadWindow",
    label: "Maximum oven loading window (minutes)",
    min: 0,
    max: 30,
    value: 2,
  },
  {
    key: "loadSeconds",
    label: "Oven loading per batch (seconds)",
    min: 1,
    max: 300,
    value: 60,
  },
  {
    key: "unloadSeconds",
    label: "Oven unloading per batch (seconds)",
    min: 1,
    max: 300,
    value: 60,
  },
  {
    key: "stage",
    label: "Stage rested batter (minutes)",
    min: 1,
    max: 60,
    value: 2,
  },
  {
    key: "portion",
    label: "Portion moulds (minutes)",
    min: 1,
    max: 60,
    value: 6,
  },
  { key: "bake", label: "Baking (minutes)", min: 1, max: 60, value: 16 },
  {
    key: "cool",
    label: "Cooling in moulds (minutes)",
    min: 1,
    max: 60,
    value: 5,
  },
  { key: "demould", label: "Demoulding (minutes)", min: 1, max: 60, value: 3 },
  {
    key: "finishCooling",
    label: "Cooling after demoulding (minutes)",
    min: 1,
    max: 60,
    value: 20,
  },
  { key: "pack", label: "Packing (minutes)", min: 1, max: 60, value: 8 },
  {
    key: "horizonMinutes",
    label: "Shift length (minutes)",
    min: 30,
    max: 720,
    value: 120,
  },
  {
    key: "outageStart",
    label: "Outage starts (minutes after 06:00)",
    min: 0,
    max: 719,
    value: 10,
  },
  {
    key: "outageEnd",
    label: "Outage ends (minutes after 06:00)",
    min: 1,
    max: 720,
    value: 30,
  },
];
const validated: unique symbol = Symbol("validated simulator settings");

export type Settings = Readonly<Record<SettingsField, number>> & {
  readonly [validated]: true;
};

export type SettingsResult =
  | {
      readonly kind: "valid";
      readonly settings: Settings;
      readonly field?: never;
      readonly message?: never;
    }
  | {
      readonly kind: "invalid";
      readonly field: SettingsField;
      readonly message: string;
      readonly settings?: never;
    };

export function parseSettings(
  raw: Readonly<Record<string, unknown>>,
): SettingsResult {
  const values: Record<SettingsField, number> = {
    batchCount: 0,
    workerCount: 0,
    rackTrays: 0,
    ovenTrays: 0,
    traysPerBatch: 0,
    piecesPerTray: 0,
    loadWindow: 0,
    loadSeconds: 0,
    unloadSeconds: 0,
    stage: 0,
    portion: 0,
    bake: 0,
    cool: 0,
    demould: 0,
    finishCooling: 0,
    pack: 0,
    horizonMinutes: 0,
    outageStart: 0,
    outageEnd: 0,
  };
  for (const field of fields) {
    const input = raw[field.key];
    let value = NaN;
    if (typeof input === "number") {
      value = input;
    } else if (typeof input === "string" && input.trim() !== "") {
      value = Number(input);
    }
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      return {
        kind: "invalid",
        field: field.key,
        message: `Enter a whole number from ${field.min} to ${field.max}.`,
      };
    }
    values[field.key] = value;
  }
  if (
    values.outageEnd <= values.outageStart ||
    values.outageEnd > values.horizonMinutes
  ) {
    return {
      kind: "invalid",
      field: "outageEnd",
      message: "End the outage after its start and within the shift.",
    };
  }
  if (
    values.traysPerBatch > values.ovenTrays ||
    values.traysPerBatch > values.rackTrays
  ) {
    return {
      kind: "invalid",
      field: "traysPerBatch",
      message:
        "Each whole batch must fit in both the oven and the cooling rack.",
    };
  }
  return {
    kind: "valid",
    settings: Object.freeze({ ...values, [validated]: true as const }),
  };
}

export function sampleSettings(): Settings {
  const raw: Record<string, number> = {};
  for (const field of fields) {
    raw[field.key] = field.value;
  }
  const result = parseSettings(raw);
  if (result.kind === "invalid") {
    throw new Error(result.message);
  }
  return result.settings;
}

export function bakeryProcedureKey(
  entities: readonly CommerceEntity[],
  relationships: readonly CommerceRelationship[],
): string {
  const versions: string[] = [];
  for (const entity of entities) {
    if (
      entity.reference.origin === "custom" &&
      ["bakery_procedure", "bakery_operation", "bakery_equipment"].includes(
        entity.reference.typeId,
      )
    ) {
      versions.push(
        JSON.stringify([
          "entity",
          entity.reference.typeId,
          entity.reference.entityId,
          entity.revision,
        ]),
      );
    }
  }
  for (const edge of relationships) {
    if (
      edge.origin === "custom" &&
      edge.definition.definitionId !== "bakery_scenario_procedure"
    ) {
      versions.push(
        JSON.stringify([
          "relationship",
          edge.relationshipId,
          edge.revision,
          edge.definition,
          edge.source,
          edge.target,
        ]),
      );
    }
  }
  return JSON.stringify(versions.sort());
}

export function bakeryFingerprint(key: string): Promise<string> {
  return sha256Hex(key);
}

export const financierOperations: readonly Readonly<{
  station: StationId;
  operation: Operation;
  attended: boolean;
}>[] = [
  { station: "stage", operation: "stage", attended: true },
  { station: "portion", operation: "portion", attended: true },
  { station: "bake", operation: "bake", attended: false },
  { station: "cool", operation: "cool", attended: false },
  { station: "cool", operation: "demould", attended: true },
  { station: "cool", operation: "finishCooling", attended: false },
  { station: "pack", operation: "pack", attended: true },
];
