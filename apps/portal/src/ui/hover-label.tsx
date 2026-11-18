import React from "react";
import { Tooltip } from "@base-ui/react/tooltip";

import "./hover-label.css";

/** The pause before a label shows, as for the chat's response actions. */
const LABEL_DELAY = 350;

/**
 * A short label that shows below a control while the pointer rests on it or
 * while it has keyboard focus. The control keeps its own accessible name.
 */
export function HoverLabel(
  props: Readonly<{
    label: string;
    children: React.ReactNode;
    className?: string;
  }>,
): React.ReactNode {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={LABEL_DELAY}
        render={
          <div
            className={
              props.className === undefined
                ? "hover-label-anchor"
                : `hover-label-anchor ${props.className}`
            }
          />
        }
      >
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          className="hover-label-positioner"
        >
          <Tooltip.Popup className="hover-label">{props.label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
