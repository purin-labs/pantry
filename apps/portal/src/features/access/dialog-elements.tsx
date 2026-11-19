import React from "react";

import type { AccessControlOption } from "@purin-labs/control-api/portal/access-models";
import { Select } from "../../ui/select";

export { cancelDialog, DialogHeading, syncDialog } from "../../dialog";

export function findOption(
  options: readonly AccessControlOption[],
  refId: string,
): AccessControlOption | null {
  for (const option of options) {
    if (option.refId === refId) return option;
  }
  return null;
}

/** The Select item value and label of an access option. */
export function optionItem(
  option: AccessControlOption,
): Readonly<{ value: string; label: string }> {
  return { value: option.refId, label: `${option.label} · ${option.detail}` };
}

export function renderOption(option: AccessControlOption): React.ReactNode {
  return (
    <Select.Item
      key={option.refId}
      value={option.refId}
      disabled={option.availability !== "available"}
    >
      {option.label} · {option.detail}
    </Select.Item>
  );
}
