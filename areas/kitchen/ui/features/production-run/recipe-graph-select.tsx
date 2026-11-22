import React from "react";
import { Select } from "@purin-labs/ui/select";

// The dropdowns of the recipe workflow graph. Each one renders its items as
// its options, so the trigger label and the list cannot drift. It lives
// beside recipe-workflow-graph.tsx, which may not grow (pnpm lint:file-size).

export type GraphChoice = Readonly<{
  value: string;
  label: string;
  disabled?: boolean;
}>;

type Props = Readonly<{
  items: readonly GraphChoice[];
  name?: string;
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  onValueChange?: (value: string | null) => void;
  variant?: "default" | "ghost";
  "aria-label"?: string;
}>;

export function GraphSelect({
  items,
  variant,
  "aria-label": label,
  ...root
}: Props): React.ReactNode {
  return (
    <Select.Root items={items} {...root}>
      <Select.Trigger variant={variant} aria-label={label}>
        <Select.Value />
      </Select.Trigger>
      <Select.Popup>{items.map(graphItem)}</Select.Popup>
    </Select.Root>
  );
}

/** A choice whose label is its value, such as a lot, a place or a program. */
export function graphChoice(value: string): GraphChoice {
  return { value, label: value };
}

function graphItem(item: GraphChoice): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value} disabled={item.disabled}>
      {item.label}
    </Select.Item>
  );
}
