import type {
  CommerceList,
  CommerceListEntry,
  ListEntryAttributeDefinition,
  ListEntryAttributeValue,
} from "@seams/commerce-contracts";
import { parseCommerceTimestamp } from "./entity-plane/index.ts";

export type PurchaseRequestUpdate = Readonly<{
  owner: string;
  purchaseRequestId: string;
  expectedDeliveryAt: string | null;
  notes: string | null;
}>;

/** The Replenishment Queue entry's values after a person or agent updates it. */
export function purchaseRequestAttributeValues(
  list: CommerceList,
  entry: CommerceListEntry,
  update: PurchaseRequestUpdate,
): ListEntryAttributeValue[] {
  const replacedIds = new Set<string>([
    "status",
    "owner",
    "purchase_request_id",
    "expected_delivery_at",
    "notes",
  ]);
  const values = entry.attributeValues.filter(
    (attribute) => !replacedIds.has(String(attribute.attributeId)),
  );
  values.push(textValue(list, "owner", update.owner, "short_text"));
  values.push(
    textValue(list, "purchase_request_id", update.purchaseRequestId, "short_text"),
  );
  values.push(
    statusValue(list, update.expectedDeliveryAt === null ? "requested" : "expected"),
  );
  if (update.expectedDeliveryAt !== null)
    values.push(
      timestampValue(list, "expected_delivery_at", update.expectedDeliveryAt),
    );
  if (update.notes !== null)
    values.push(textValue(list, "notes", update.notes, "long_text"));
  return values;
}

function textValue(
  list: CommerceList,
  attributeId: string,
  text: string,
  kind: "short_text" | "long_text",
): ListEntryAttributeValue {
  return { ...valueBase(list, attributeId), value: { kind, value: text } };
}

function timestampValue(
  list: CommerceList,
  attributeId: string,
  timestamp: string,
): ListEntryAttributeValue {
  return {
    ...valueBase(list, attributeId),
    value: { kind: "timestamp", value: parseCommerceTimestamp(timestamp) },
  };
}

function statusValue(
  list: CommerceList,
  status: string,
): ListEntryAttributeValue {
  const definition = listAttribute(list, "status");
  const option =
    definition.definition.kind.kind === "status"
      ? definition.definition.kind.options.find((item) => item.id === status)
      : undefined;
  if (option === undefined)
    throw new Error("The purchase-request status is unavailable.");
  return {
    ...valueBase(list, "status"),
    value: { kind: "status", value: option.id },
  };
}

function valueBase(list: CommerceList, attributeId: string) {
  const definition = listAttribute(list, attributeId);
  return {
    attributeId: definition.attributeId,
    scope: definition.definition.scope,
    definitionRevision: definition.definition.revision,
    sensitivity: definition.definition.sensitivity,
  };
}

function listAttribute(
  list: CommerceList,
  attributeId: string,
): ListEntryAttributeDefinition {
  const definition = list.entryAttributeDefinitions.find(
    (candidate) => candidate.attributeId === attributeId,
  );
  if (definition === undefined)
    throw new Error(`The ${attributeId} field is unavailable.`);
  return definition;
}
