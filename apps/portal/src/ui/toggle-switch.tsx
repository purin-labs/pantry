import React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import "./toggle-switch.css";

export type SwitchProps = Readonly<{
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The id of the element that names the switch. */
  "aria-labelledby"?: string;
  /** The id of the element that describes the switch. */
  "aria-describedby"?: string;
  "aria-label"?: string;
  /** The switch shows that its change runs. */
  busy?: boolean;
}>;

/**
 * An on/off switch: the Base UI Switch with Portal styles. A change takes
 * effect at once, so a page uses it for a setting that saves on change.
 */
export function Switch(props: SwitchProps): React.ReactNode {
  return (
    <BaseSwitch.Root
      className="pantry-toggle-switch"
      checked={props.checked}
      onCheckedChange={(checked) => props.onCheckedChange(checked)}
      disabled={props.disabled === true || props.busy === true}
      aria-labelledby={props["aria-labelledby"]}
      aria-describedby={props["aria-describedby"]}
      aria-label={props["aria-label"]}
      aria-busy={props.busy === true ? true : undefined}
      data-busy={props.busy === true ? "" : undefined}
    >
      <BaseSwitch.Thumb className="pantry-toggle-switch-thumb" />
    </BaseSwitch.Root>
  );
}
