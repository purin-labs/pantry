import type { CustomCommerceEntity } from "@seams/contracts";
import { fields, parseSettings, type Settings } from "./bakery.ts";
import { isRecord } from "@seams/std";

const parsed: unique symbol = Symbol("validated scenario copy");

export type ScenarioCopy = Readonly<{
  [parsed]: true;
  id: string;
  name: string;
  note: string;
  procedureId: string;
  fingerprint: string;
  settings: Settings;
}>;

export function parseScenarioCopy(
  raw: Readonly<Record<string, unknown>>,
): ScenarioCopy | null {
  if (
    Object.keys(raw).length !== 6 ||
    !text(raw.id, 128) ||
    !text(raw.name, 80) ||
    !text(raw.note, 2000) ||
    !text(raw.procedureId, 128) ||
    typeof raw.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.fingerprint) ||
    !isRecord(raw.settings) ||
    Object.keys(raw.settings).length !== fields.length
  ) {
    return null;
  }
  for (const field of fields) {
    if (typeof raw.settings[field.key] !== "number") {
      return null;
    }
  }
  const result = parseSettings(raw.settings);
  if (result.kind !== "valid") {
    return null;
  }
  return {
    [parsed]: true,
    id: raw.id,
    name: raw.name,
    note: raw.note,
    procedureId: raw.procedureId,
    fingerprint: raw.fingerprint,
    settings: result.settings,
  };
}

export function scenarioFromEntity(
  entity: CustomCommerceEntity,
  procedureId: string,
): ScenarioCopy | null {
  if (
    entity.reference.typeId !== "bakery_scenario" ||
    entity.typeRevision !== 2 ||
    entity.state.state !== "active"
  ) {
    return null;
  }
  const attributes: Record<string, unknown> = {};
  for (const item of entity.attributes) {
    if (
      Object.hasOwn(attributes, item.attributeId) ||
      item.scope.kind !== "custom" ||
      item.scope.entityTypeId !== "bakery_scenario" ||
      item.scope.typeRevision !== 2 ||
      item.definitionRevision !== 1
    ) {
      return null;
    }
    switch (item.attributeId) {
      case "timing_note":
        if (item.value.kind !== "long_text") {
          return null;
        }
        attributes[item.attributeId] = item.value.value;
        break;
      case "source_fingerprint":
        if (item.value.kind !== "short_text") {
          return null;
        }
        attributes[item.attributeId] = item.value.value;
        break;
      default:
        if (item.value.kind !== "integer") {
          return null;
        }
        attributes[item.attributeId] = Number(item.value.value);
    }
  }
  const {
    timing_note: note,
    source_fingerprint: fingerprint,
    ...settings
  } = attributes;
  return parseScenarioCopy({
    id: entity.reference.entityId,
    name: entity.displayName,
    note,
    procedureId,
    fingerprint,
    settings,
  });
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}
