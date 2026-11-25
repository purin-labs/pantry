import React from "react";
import type {
  AttributeValue,
  CommerceEntity,
} from "@purin-labs/commerce-contracts";
import { StatusChip } from "@purin-labs/ui/page-components";
import type { CrmColumn } from "@purin-labs/ui/index";
import {
  COMMERCE_VALUE_ABSENT,
  commerceAttributeLabel,
  commerceStatusChip,
  formatCommerceAttributeValue,
  formatMoney,
  isNumericCommerceValue,
} from "./presentation";

/**
 * The table column for one attribute of a page of commerce records. Money in
 * one currency sorts and sums by its amount; a time sorts by when it was, not
 * by its text; any other number only displays.
 */
export function commerceEntityAttributeColumn(
  entities: readonly CommerceEntity[],
  attributeId: string,
): CrmColumn<CommerceEntity> {
  const values = entities.flatMap(
    entityAttributeValues.bind(null, attributeId),
  );
  const first = values[0];
  const base = {
    id: `attribute-${attributeId}`,
    label: commerceAttributeLabel(attributeId, undefined),
    width: columnWidth(first),
    render: renderCommerceEntityAttribute.bind(null, attributeId),
  };
  const currency = singleCurrency(values);
  if (currency !== null)
    return {
      ...base,
      align: "end",
      kind: "number",
      value: entityMoneyAmount.bind(null, attributeId),
      format: formatAmountIn.bind(null, currency),
    };
  if (first !== undefined && isNumericCommerceValue(first))
    return { ...base, align: "end", kind: "display" };
  return {
    ...base,
    align: "start",
    kind: "text",
    value:
      first?.kind === "timestamp"
        ? entityTimestamp.bind(null, attributeId)
        : commerceEntityAttributeValue.bind(null, attributeId),
  };
}

/**
 * The attributes present on a page, in the order that the records declare
 * them, with the state (`lifecycle`) last: a row reads from its facts to the
 * state that it is in, whatever order a source lists them in.
 */
export function entityTableAttributeIds(
  entities: readonly CommerceEntity[],
): readonly string[] {
  const ids: string[] = [];
  for (const entity of entities) {
    for (const attribute of entity.attributes) {
      const id = String(attribute.attributeId);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  const state = ids.indexOf("lifecycle");
  return state === -1
    ? ids
    : [...ids.slice(0, state), ...ids.slice(state + 1), "lifecycle"];
}

export function findEntityAttribute(
  entity: CommerceEntity,
  attributeId: string,
) {
  for (const attribute of entity.attributes) {
    if (attribute.attributeId === attributeId) return attribute;
  }
  return undefined;
}

/** Narrow columns for short values, so a five-column table fits 920 pixels. */
function columnWidth(value: AttributeValue | undefined): number {
  switch (value?.kind) {
    case "timestamp":
      return 160;
    case "money":
      return 120;
    default:
      return 180;
  }
}

function entityAttributeValues(
  attributeId: string,
  entity: CommerceEntity,
): AttributeValue[] {
  const attribute = findEntityAttribute(entity, attributeId);
  return attribute === undefined ? [] : [attribute.value];
}

/** The currency of a money column, or null when it holds other values or mixes currencies. */
function singleCurrency(values: readonly AttributeValue[]): string | null {
  let currency: string | null = null;
  for (const value of values) {
    if (value.kind !== "money") return null;
    const next = String(value.value.currency);
    if (currency !== null && currency !== next) return null;
    currency = next;
  }
  return currency;
}

function entityMoneyAmount(
  attributeId: string,
  entity: CommerceEntity,
): number | null {
  const value = findEntityAttribute(entity, attributeId)?.value;
  return value?.kind === "money" ? value.value.amountMinor : null;
}

function formatAmountIn(currency: string, amountMinor: number): string {
  return formatMoney(amountMinor, currency);
}

function entityTimestamp(
  attributeId: string,
  entity: CommerceEntity,
): string | null {
  const value = findEntityAttribute(entity, attributeId)?.value;
  return value?.kind === "timestamp" ? value.value : null;
}

function commerceEntityAttributeValue(
  attributeId: string,
  entity: CommerceEntity,
): string | null {
  const attribute = findEntityAttribute(entity, attributeId);
  return attribute === undefined
    ? null
    : formatCommerceAttributeValue(attribute.value, undefined);
}

function renderCommerceEntityAttribute(
  attributeId: string,
  entity: CommerceEntity,
): React.ReactNode {
  const attribute = findEntityAttribute(entity, attributeId);
  const chip =
    attribute === undefined
      ? null
      : commerceStatusChip(attribute.value, undefined);
  if (chip !== null) return <StatusChip status={chip} />;
  return (
    commerceEntityAttributeValue(attributeId, entity) ?? COMMERCE_VALUE_ABSENT
  );
}
