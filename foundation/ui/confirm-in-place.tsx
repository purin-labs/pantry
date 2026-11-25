import React from "react";
import { Button } from "./button";
import "./confirm-in-place.css";

export type ConfirmInPlaceProps = {
  /** The idle button, for example "Remove shop@example.com…". */
  readonly label: string;
  /** The question, for example "Remove shop@example.com?". */
  readonly question: string;
  /** What changes, and how to undo it. */
  readonly consequence: string;
  /** The button that runs the action, for example "Remove". */
  readonly confirmLabel: string;
  /**
   * `danger` (the default) for an action that removes or cuts something off.
   * `primary` or `secondary` for one that only needs a check first, such as
   * a resume after a pause.
   */
  readonly variant?: "danger" | "primary" | "secondary";
  readonly busy: boolean;
  readonly onConfirm: (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void | Promise<void>;
  /**
   * `data-*` attributes for the button that runs the action. A page action
   * reads the record it changes from them, for example `account-id`.
   */
  readonly data?: Readonly<Record<string, string>>;
};

/**
 * An action that must be checked before it runs. The first press asks in
 * place and names what changes; only the second press runs it. No dialog
 * opens on top of the page or the drawer.
 */
export function ConfirmInPlace(props: ConfirmInPlaceProps): React.ReactNode {
  const [confirming, setConfirming] = React.useState(false);
  const variant = props.variant ?? "danger";
  if (!confirming) {
    return (
      <Button
        variant={variant}
        disabled={props.busy}
        onClick={setFlag.bind(null, setConfirming, true)}
      >
        {props.label}
      </Button>
    );
  }
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(props.data ?? {}))
    attributes[`data-${key}`] = value;
  return (
    <div className="pantry-confirm" role="group" aria-label={props.question}>
      <p className="pantry-confirm-copy">
        <strong>{props.question}</strong> {props.consequence}
      </p>
      <Button
        variant={variant === "secondary" ? "primary" : variant}
        {...attributes}
        disabled={props.busy}
        onClick={runConfirmed.bind(null, props.onConfirm)}
      >
        {props.confirmLabel}
      </Button>
      <Button
        variant="secondary"
        disabled={props.busy}
        onClick={setFlag.bind(null, setConfirming, false)}
      >
        Cancel
      </Button>
    </div>
  );
}

function setFlag(set: (value: boolean) => void, value: boolean): void {
  set(value);
}

function runConfirmed(
  action: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  void action(event);
}
