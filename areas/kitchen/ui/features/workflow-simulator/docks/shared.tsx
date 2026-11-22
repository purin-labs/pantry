import React from "react";
import { X } from "lucide-react";
import type { TaskSnapshot } from "@purin-labs/production-simulation/recipes/bakery/schedule";

export function taskStatusLabel(kind: TaskSnapshot["kind"]): string {
  switch (kind) {
    case "queued":
      return "Waiting";
    case "running":
      return "In progress";
    case "completed":
      return "Done";
    case "recovery-required":
      return "Recovery required";
    case "failed":
      return "Failed";
  }
}

type SegmentedControlOption<T extends string> = Readonly<{
  value: T;
  label: string;
  onSelect: () => void;
}>;

const lastSegmentIndexByGroup = new Map<string, number>();

export function SegmentedControl<T extends string>(props: {
  readonly ariaLabel: string;
  readonly value: T;
  readonly options: readonly SegmentedControlOption<T>[];
  readonly role?: "tablist" | "group";
}): React.ReactNode {
  const role = props.role ?? "tablist";
  const targetIndex = Math.max(
    0,
    props.options.findIndex((item) => item.value === props.value),
  );
  const previousIndex = lastSegmentIndexByGroup.get(props.ariaLabel);
  const [displayIndex, setDisplayIndex] = React.useState<number>(
    previousIndex ?? targetIndex,
  );

  React.useLayoutEffect(() => {
    lastSegmentIndexByGroup.set(props.ariaLabel, targetIndex);
    if (displayIndex === targetIndex) return;
    const frame = requestAnimationFrame(() => {
      setDisplayIndex(targetIndex);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.ariaLabel, targetIndex, displayIndex]);

  return (
    <div
      className="workflow-segmented-control"
      role={role}
      aria-label={props.ariaLabel}
      style={
        {
          "--segment-count": props.options.length,
          "--segment-index": displayIndex,
        } as React.CSSProperties
      }
    >
      <span className="workflow-segmented-thumb" aria-hidden="true" />
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role={role === "tablist" ? "tab" : undefined}
            className="workflow-segmented-option"
            data-active={active}
            aria-selected={role === "tablist" ? active : undefined}
            aria-pressed={active}
            onClick={option.onSelect}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function DockHeader(props: {
  readonly label: string;
  readonly onClose: () => void;
  readonly id?: string;
  readonly closeLabel?: string;
}): React.ReactNode {
  const headingId =
    props.id ?? `workflow-heading-${props.label.replaceAll(" ", "-")}`;
  return (
    <div className="workflow-dock-header">
      <h2 tabIndex={-1} id={headingId}>
        {props.label}
      </h2>
      <button
        className="workflow-dock-close"
        aria-label={props.closeLabel ?? `Close ${props.label}`}
        onClick={props.onClose}
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
