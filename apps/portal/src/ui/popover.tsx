import React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { withClass } from "./class-name";
import "./popover.css";

// The Portal popover: the Base UI Popover parts
// (https://base-ui.com/react/components/popover) with Portal styles in
// popover.css. Trigger tracks any enclosing modal <dialog>, and Popup adds
// Portal and Positioner so a popover inside a dialog renders in its top layer.

type PopoverContextValue = {
  readonly container: HTMLElement | null;
  readonly setContainer: (container: HTMLElement | null) => void;
};

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function Root<Payload = unknown>(
  props: BasePopover.Root.Props<Payload>,
): React.ReactNode {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const context = React.useMemo(
    () => ({ container, setContainer }),
    [container],
  );
  return (
    <PopoverContext.Provider value={context}>
      <BasePopover.Root {...props} />
    </PopoverContext.Provider>
  );
}

function Trigger<Payload = unknown>({
  className,
  ref,
  ...props
}: BasePopover.Trigger.Props<Payload>): React.ReactNode {
  const popover = React.useContext(PopoverContext);
  const setContainer = popover?.setContainer;
  const findContainer = React.useCallback(
    (node: HTMLButtonElement | null) => {
      setContainer?.(node?.closest("dialog") ?? null);
      if (typeof ref === "function") {
        return ref(node);
      }
      if (ref) {
        ref.current = node;
      }
      return undefined;
    },
    [ref, setContainer],
  );
  return (
    <BasePopover.Trigger
      className={withClass("pantry-popover-trigger", className)}
      ref={findContainer}
      {...props}
    />
  );
}

function Popup({
  className,
  children,
  side = "bottom",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  ...props
}: BasePopover.Popup.Props &
  Pick<
    BasePopover.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >): React.ReactNode {
  const popover = React.useContext(PopoverContext);
  return (
    <BasePopover.Portal container={popover?.container ?? undefined}>
      <BasePopover.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionPadding={12}
        className="pantry-popover-positioner"
      >
        <BasePopover.Popup
          className={withClass("pantry-popover-popup", className)}
          {...props}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

function Title({
  className,
  ...props
}: BasePopover.Title.Props): React.ReactNode {
  return (
    <BasePopover.Title
      className={withClass("pantry-popover-title", className)}
      {...props}
    />
  );
}

function Description({
  className,
  ...props
}: BasePopover.Description.Props): React.ReactNode {
  return (
    <BasePopover.Description
      className={withClass("pantry-popover-description", className)}
      {...props}
    />
  );
}

function Close({
  className,
  ...props
}: BasePopover.Close.Props): React.ReactNode {
  return (
    <BasePopover.Close
      className={withClass("pantry-popover-close", className)}
      {...props}
    />
  );
}

export const Popover = {
  Root,
  Trigger,
  Popup,
  Title,
  Description,
  Close,
} as const;
