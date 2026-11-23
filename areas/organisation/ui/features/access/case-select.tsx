import React from "react";
import type { AccessControlOption } from "@purin-labs/control-api/portal/access-models";
import { Select } from "@purin-labs/ui/select";

const NO_CASE = { value: "", label: "Select a current Case" } as const;

/**
 * The Case choice of Related Cases and On screen: the Cases that the reader
 * may see, and an empty choice. A Case with no current revision is shown
 * and cannot be chosen.
 */
export function CaseSelect(props: {
  readonly id: string;
  readonly cases: readonly AccessControlOption[];
  readonly value: string;
  readonly onChange: (value: string | null) => void;
  readonly disabled: boolean;
  readonly triggerRef?: React.Ref<HTMLButtonElement>;
}): React.ReactNode {
  return (
    <label htmlFor={props.id}>
      Case
      <Select.Root
        items={[NO_CASE, ...props.cases.map(caseItem)]}
        value={props.value}
        onValueChange={props.onChange}
        disabled={props.disabled}
      >
        <Select.Trigger id={props.id} ref={props.triggerRef}>
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>
          <Select.Item value={NO_CASE.value}>{NO_CASE.label}</Select.Item>
          {props.cases.map(renderCaseOption)}
        </Select.Popup>
      </Select.Root>
    </label>
  );
}

function caseItem(
  option: AccessControlOption,
): Readonly<{ value: string; label: string }> {
  return { value: option.refId, label: option.label };
}

function renderCaseOption(option: AccessControlOption): React.ReactNode {
  return (
    <Select.Item
      key={option.refId}
      value={option.refId}
      disabled={option.revision === null}
    >
      {option.label}
    </Select.Item>
  );
}
