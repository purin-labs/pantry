import React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { withClass } from "./class-name";
import "./switch.css";

export type SwitchProps = BaseSwitch.Root.Props &
  React.RefAttributes<HTMLElement>;

/**
 * The Portal on/off toggle built on Base UI Switch
 * (https://base-ui.com/react/components/switch). Renders `<span role="switch">`
 * with a hidden checkbox input for forms.
 */
export function Switch({ className, ...props }: SwitchProps): React.ReactNode {
  return (
    <BaseSwitch.Root
      className={withClass("pantry-switch", className)}
      {...props}
    >
      <BaseSwitch.Thumb className="pantry-switch-thumb" />
    </BaseSwitch.Root>
  );
}
