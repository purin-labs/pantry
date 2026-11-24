import React from "react";
import type {
  AttributeDefinitionId,
  CommerceListEntry,
  ListEntryAttributeDefinition,
} from "@purin-labs/commerce-contracts";
import { Select } from "@purin-labs/ui/select";
import { StatusChip } from "@purin-labs/ui/page-components";
import type { StatusChipStatus } from "@purin-labs/ui/status-chip";
import {
  COMMERCE_VALUE_ABSENT,
  commerceAttributeLabel,
  commerceStatusChip,
  formatCommerceAttributeValue,
  isNumericCommerceValue,
} from "./presentation";
import type {
  CommerceCollectionRow,
  CommercePublishedCollectionModel,
} from "./models";
import type {
  CommerceBoardListColumn,
  CommerceBoardListFact,
  CommerceBoardListLane,
} from "./board-list";

/**
 * The lanes and rows of a board view, read from its published model. Pure
 * reads: the route owns the moves and the drawers.
 */

export type CommerceBoardLaneOption = Readonly<{
  id: string;
  label: string;
  acceptsMoves: boolean;
  rows: readonly CommerceCollectionRow[];
}>;

export function commerceBoardListLane(
  lane: CommerceBoardLaneOption,
): CommerceBoardListLane {
  return { id: lane.id, label: lane.label, count: lane.rows.length };
}

export function boardRowSummary(
  cardAttributeIds: readonly AttributeDefinitionId[],
  text: (attributeId: string) => string,
): Readonly<{
  secondary: string | null;
  columns: readonly CommerceBoardListColumn[];
}> {
  const [first, ...rest] = cardAttributeIds.map(String);
  const columns: CommerceBoardListColumn[] = [];
  for (let index = 0; index < 3; index += 1) {
    const id = rest[index];
    columns.push(
      id === undefined
        ? { id: `none-${index}`, text: "", numeric: false }
        : { id, text: text(id) || COMMERCE_VALUE_ABSENT, numeric: false },
    );
  }
  const secondary = first === undefined ? "" : text(first);
  return { secondary: secondary.length === 0 ? null : secondary, columns };
}

export function commerceBoardLaneChip(
  model: CommercePublishedCollectionModel,
  row: CommerceCollectionRow,
  lane: CommerceBoardLaneOption,
): StatusChipStatus {
  const laneAttributeId = model.board?.configuration.laneAttributeId;
  if (laneAttributeId === undefined) return { kind: "neutral", label: lane.label };
  const attribute = findListEntryAttribute(row.entry, laneAttributeId);
  const definition = listAttributeDefinition(model, String(laneAttributeId));
  const chip =
    attribute === undefined
      ? null
      : commerceStatusChip(attribute.value, definition?.definition.kind);
  return chip ?? { kind: "neutral", label: lane.label };
}

export function commerceBoardFact(
  model: CommercePublishedCollectionModel,
  names: ReadonlyMap<string, string>,
  row: CommerceCollectionRow,
  attributeId: AttributeDefinitionId,
): CommerceBoardListFact {
  const attribute = findListEntryAttribute(row.entry, attributeId);
  const definition = listAttributeDefinition(model, String(attributeId));
  const label = commerceAttributeLabel(String(attributeId), definition);
  if (attribute === undefined)
    return {
      id: String(attributeId),
      label,
      value: COMMERCE_VALUE_ABSENT,
      numeric: false,
    };
  const chip = commerceStatusChip(attribute.value, definition?.definition.kind);
  return {
    id: String(attributeId),
    label,
    value:
      chip === null ? (
        resolveCommerceReferenceName(
          names,
          formatCommerceAttributeValue(
            attribute.value,
            definition?.definition.kind,
          ),
        )
      ) : (
        <StatusChip status={chip} />
      ),
    numeric: isNumericCommerceValue(attribute.value),
  };
}

/** A card fact as plain text, or "" when the entry has no value for it. */
export function commerceBoardFactText(
  model: CommercePublishedCollectionModel,
  names: ReadonlyMap<string, string>,
  row: CommerceCollectionRow,
  attributeId: string,
): string {
  const attribute = row.entry.attributeValues.find(
    attributeHasId.bind(null, attributeId),
  );
  if (attribute === undefined) return "";
  const definition = listAttributeDefinition(model, attributeId);
  const chip = commerceStatusChip(attribute.value, definition?.definition.kind);
  if (chip !== null) return chip.label;
  return resolveCommerceReferenceName(
    names,
    formatCommerceAttributeValue(attribute.value, definition?.definition.kind),
  );
}

function attributeHasId(
  attributeId: string,
  attribute: CommerceListEntry["attributeValues"][number],
): boolean {
  return String(attribute.attributeId) === attributeId;
}

/** A stored identifier shows as the record's name once that name is known. */
export function resolveCommerceReferenceName(
  names: ReadonlyMap<string, string>,
  value: string,
): string {
  return names.get(value) ?? value;
}

function findListEntryAttribute(
  entry: CommerceListEntry,
  attributeId: AttributeDefinitionId,
) {
  for (const attribute of entry.attributeValues) {
    if (attribute.attributeId === attributeId) return attribute;
  }
  return undefined;
}

export function commerceBoardLaneOptions(
  model: CommercePublishedCollectionModel,
): readonly CommerceBoardLaneOption[] {
  if (model.board === null || model.list === null) return [];
  const laneAttributeId = model.board.configuration.laneAttributeId;
  const definition = findListEntryDefinition(
    model.list.entryAttributeDefinitions,
    laneAttributeId,
  );
  if (definition === undefined || definition.definition.kind.kind !== "status")
    return [];
  const rowsByLane = new Map<string, readonly CommerceCollectionRow[]>();
  for (const lane of model.board.lanes) rowsByLane.set(lane.key, lane.rows);
  const lanes: CommerceBoardLaneOption[] = [];
  for (const option of definition.definition.kind.options) {
    const id = String(option.id);
    lanes.push({
      id,
      label: option.label,
      acceptsMoves: true,
      rows: rowsByLane.get(id) ?? [],
    });
    rowsByLane.delete(id);
  }
  for (const [id, rows] of rowsByLane) {
    lanes.push({
      id,
      label: id === "unassigned" ? "Unassigned" : `Unavailable value (${id})`,
      acceptsMoves: false,
      rows,
    });
  }
  return lanes;
}

export function findListEntryDefinition(
  definitions: readonly ListEntryAttributeDefinition[],
  attributeId: AttributeDefinitionId,
): ListEntryAttributeDefinition | undefined {
  for (const definition of definitions) {
    if (definition.attributeId === attributeId) return definition;
  }
  return undefined;
}

export function renderCommerceBoardLaneOption(
  option: CommerceBoardLaneOption,
): React.ReactNode {
  return option.acceptsMoves ? (
    <Select.Item key={option.id} value={option.id}>
      {option.label}
    </Select.Item>
  ) : null;
}

/**
 * The published definition for one of a list's entry attributes, which carries
 * the label a merchant reads and the option labels a status resolves through.
 */
export function listAttributeDefinition(
  model: CommercePublishedCollectionModel,
  attributeId: string,
): ListEntryAttributeDefinition | undefined {
  if (model.list === null) return undefined;
  for (const definition of model.list.entryAttributeDefinitions) {
    if (String(definition.attributeId) === attributeId) return definition;
  }
  return undefined;
}
