import React from "react";
import { Select } from "@purin-labs/ui/select";

// Select choices and parts for the commerce entity plane (route.tsx).

export type CommerceSelectItem = Readonly<{ value: string; label: string }>;

export const COMMERCE_TABLE_DENSITIES: readonly CommerceSelectItem[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
  { value: "spacious", label: "Spacious" },
];

export const COMMERCE_CANCELLATION_REASONS: readonly CommerceSelectItem[] = [
  { value: "customer_requested", label: "Customer requested" },
  { value: "fraud_suspected", label: "Fraud suspected" },
  { value: "inventory_unavailable", label: "Inventory unavailable" },
];

export const COMMERCE_CANCELLATION_REFUNDS: readonly CommerceSelectItem[] = [
  { value: "full", label: "Full refund" },
  { value: "none", label: "No refund" },
];

/** The orders of the Supplier Directory; the table's column sort before it. */
export const SUPPLIER_SORTS: readonly CommerceSelectItem[] = [
  { value: "name", label: "Sort by name" },
  { value: "lead_time", label: "Sort by lead time" },
  { value: "open_requests", label: "Sort by open requests" },
];

export function commerceOptionItem(
  option: Readonly<{ id: string; label: string }>,
): CommerceSelectItem {
  return { value: option.id, label: option.label };
}

/**
 * The trigger and the list of a Select that offers every item. `label` names
 * the trigger when no visible label does.
 */
export function renderCommerceSelectParts(
  items: readonly CommerceSelectItem[],
  label?: string,
): React.ReactNode {
  return (
    <>
      <Select.Trigger aria-label={label}>
        <Select.Value />
      </Select.Trigger>
      <Select.Popup>{items.map(renderCommerceSelectItem)}</Select.Popup>
    </>
  );
}

function renderCommerceSelectItem(item: CommerceSelectItem): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}
