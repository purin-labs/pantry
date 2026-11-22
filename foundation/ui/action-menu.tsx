import React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { GlideHighlight } from "./glide-highlight";
import "./action-menu.css";

export type ActionMenuItem = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: React.ReactNode;
  /** Display text for a keyboard shortcut; the menu does not bind the key. */
  readonly shortcut?: string;
  readonly tone?: "neutral" | "danger";
  readonly disabled?: boolean;
  readonly onSelect: () => void;
};
export type ActionMenuSection = {
  readonly id: string;
  readonly label?: string;
  readonly items: readonly ActionMenuItem[];
};
export type ActionMenuProps = {
  readonly className?: string;
  /** Accessible name of the menu. */
  readonly label: string;
  /** The one element that opens the menu, usually a button. */
  readonly trigger: React.ReactElement;
  readonly sections: readonly ActionMenuSection[];
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
};

/**
 * A dropdown of actions, grouped in optional labelled sections. One highlight
 * glides between items; choosing an item runs it at once, blinks its highlight
 * and fades the menu out.
 */
export function ActionMenu(props: ActionMenuProps): React.ReactNode {
  const trigger = React.useRef<HTMLButtonElement>(null);
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  React.useLayoutEffect(
    findMenuContainer.bind(null, trigger, setContainer),
    [],
  );
  return (
    <Menu.Root>
      <Menu.Trigger asChild ref={trigger}>
        {props.trigger}
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Content
          className={`action-menu ${props.className ?? ""}`}
          aria-label={props.label}
          side={props.side ?? "bottom"}
          align={props.align ?? "start"}
          sideOffset={6}
          collisionPadding={12}
        >
          <GlideHighlight target="[data-highlighted]" />
          {props.sections.map(renderSection)}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function findMenuContainer(
  trigger: React.RefObject<HTMLButtonElement | null>,
  setContainer: React.Dispatch<React.SetStateAction<HTMLElement | null>>,
): void {
  setContainer(trigger.current?.closest("dialog") ?? null);
}

function renderSection(section: ActionMenuSection): React.ReactNode {
  return (
    <Menu.Group key={section.id} className="action-menu-section">
      {section.label === undefined ? null : (
        <Menu.Label className="action-menu-heading">{section.label}</Menu.Label>
      )}
      <div className="action-menu-items">{section.items.map(renderItem)}</div>
    </Menu.Group>
  );
}

function renderItem(item: ActionMenuItem): React.ReactNode {
  return (
    <Menu.Item
      key={item.id}
      className="action-menu-item"
      data-tone={item.tone ?? "neutral"}
      disabled={item.disabled ?? false}
      onSelect={item.onSelect}
    >
      {item.icon === undefined ? null : (
        <span className="action-menu-icon" aria-hidden="true">
          {item.icon}
        </span>
      )}
      <span className="action-menu-copy">
        <span>{item.label}</span>
        {item.description === undefined ? null : (
          <small>{item.description}</small>
        )}
      </span>
      {item.shortcut === undefined ? null : <kbd>{item.shortcut}</kbd>}
    </Menu.Item>
  );
}
