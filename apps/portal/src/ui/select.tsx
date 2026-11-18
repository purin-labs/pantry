import React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { withClass } from "./class-name";
import "./select.css";

// The Portal dropdown: the Base UI Select parts
// (https://base-ui.com/react/components/select) with the Portal styles in
// select.css. It is the one dropdown of the Portal; `pnpm lint:portal-select`
// refuses a raw <select> and a direct @base-ui/react/select import.
//
//   <Select.Root items={ITEMS} value={value} onValueChange={choose}>
//     <Select.Trigger aria-label="Layout">
//       <Select.Value placeholder="Choose a layout" />
//     </Select.Trigger>
//     <Select.Popup>
//       {ITEMS.map((item) => (
//         <Select.Item key={item.value} value={item.value}>
//           {item.label}
//         </Select.Item>
//       ))}
//     </Select.Popup>
//   </Select.Root>
//
// The parts keep the Base UI names and props. Trigger adds the caret, and
// Popup adds the Portal, Positioner, List and scroll arrows, so that no page
// places them itself. Pass `items` (value and label pairs) to Root, so that
// Value shows the label of the chosen item, not its value. Browser journeys
// find a trigger by its role and name or by
// `.pantry-select-trigger[data-name="…"]` (the Root's name), read its value in
// `data-value`, and find an item by `.pantry-select-item[data-value="…"]`.

// A popup inside a modal <dialog> must render inside it: the dialog sits in
// the top layer, above anything portalled to the body.
type SelectContext = {
  readonly name: string | undefined;
  readonly container: HTMLElement | null;
  readonly setContainer: (container: HTMLElement | null) => void;
};
const SelectContext = React.createContext<SelectContext | null>(null);

function Root<Value, Multiple extends boolean | undefined = false>(
  props: BaseSelect.Root.Props<Value, Multiple>,
): React.ReactNode {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const name = props.name;
  const context = React.useMemo(
    () => ({ name, container, setContainer }),
    [name, container],
  );
  return (
    <SelectContext.Provider value={context}>
      <BaseSelect.Root {...props} />
    </SelectContext.Provider>
  );
}

/**
 * `size="sm"` is for dense panels. `variant="ghost"` is for a toolbar or a
 * table cell: no box until hover, and a smaller caret. `variant="swatch"` is
 * a round 28px button that shows only its children (a colour or a picture of
 * the value) and no caret; name the value in its `aria-label`.
 */
function Trigger({
  className,
  size = "default",
  variant = "default",
  children,
  ref,
  render = renderTrigger,
  ...props
}: BaseSelect.Trigger.Props & {
  readonly size?: "sm" | "default";
  readonly variant?: "default" | "ghost" | "swatch";
}): React.ReactNode {
  const select = React.useContext(SelectContext);
  const setContainer = select?.setContainer;
  const findContainer = React.useCallback(
    (node: HTMLButtonElement | null) => {
      setContainer?.(node?.closest("dialog") ?? null);
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
      return undefined;
    },
    [ref, setContainer],
  );
  return (
    <BaseSelect.Trigger
      data-size={size}
      data-variant={variant}
      data-name={select?.name}
      className={withClass("pantry-select-trigger", className)}
      ref={findContainer}
      render={render}
      {...props}
    >
      {children}
      <BaseSelect.Icon className="pantry-select-icon">
        <ChevronDown aria-hidden="true" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

function renderTrigger(
  props: React.ComponentPropsWithRef<"button">,
  state: BaseSelect.Trigger.State,
): React.ReactElement {
  return <button {...props} data-value={valueText(state.value)} />;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value);
}

function Value({ className, ...props }: BaseSelect.Value.Props): React.ReactNode {
  return (
    <BaseSelect.Value
      className={withClass("pantry-select-value", className)}
      {...props}
    />
  );
}

function Popup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: BaseSelect.Popup.Props &
  Pick<
    BaseSelect.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >): React.ReactNode {
  const select = React.useContext(SelectContext);
  return (
    <BaseSelect.Portal container={select?.container ?? undefined}>
      <BaseSelect.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        collisionPadding={12}
        className="pantry-select-positioner"
      >
        <BaseSelect.Popup
          data-align-trigger={alignItemWithTrigger}
          className={withClass("pantry-select-popup", className)}
          {...props}
        >
          <BaseSelect.ScrollUpArrow className="pantry-select-scroll pantry-select-scroll-up">
            <ChevronUp aria-hidden="true" />
          </BaseSelect.ScrollUpArrow>
          <BaseSelect.List className="pantry-select-list">
            {children}
          </BaseSelect.List>
          <BaseSelect.ScrollDownArrow className="pantry-select-scroll pantry-select-scroll-down">
            <ChevronDown aria-hidden="true" />
          </BaseSelect.ScrollDownArrow>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

function Item({
  className,
  children,
  ...props
}: BaseSelect.Item.Props): React.ReactNode {
  return (
    <BaseSelect.Item
      data-value={typeof props.value === "string" ? props.value : undefined}
      className={withClass("pantry-select-item", className)}
      {...props}
    >
      <BaseSelect.ItemText className="pantry-select-item-text">
        {children}
      </BaseSelect.ItemText>
      <BaseSelect.ItemIndicator
        className="pantry-select-item-indicator"
        render={<span />}
      >
        <Check aria-hidden="true" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

function Group({ className, ...props }: BaseSelect.Group.Props): React.ReactNode {
  return (
    <BaseSelect.Group
      className={withClass("pantry-select-group", className)}
      {...props}
    />
  );
}

function GroupLabel({
  className,
  ...props
}: BaseSelect.GroupLabel.Props): React.ReactNode {
  return (
    <BaseSelect.GroupLabel
      className={withClass("pantry-select-group-label", className)}
      {...props}
    />
  );
}

function Separator({
  className,
  ...props
}: BaseSelect.Separator.Props): React.ReactNode {
  return (
    <BaseSelect.Separator
      className={withClass("pantry-select-separator", className)}
      {...props}
    />
  );
}

export const Select = {
  Root,
  Trigger,
  Value,
  Popup,
  Item,
  Group,
  GroupLabel,
  Separator,
} as const;
