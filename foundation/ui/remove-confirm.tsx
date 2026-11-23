import React from "react";
import { Button } from "./button";
import "./remove-confirm.css";

export type RemoveConfirmProps = {
  /** The idle button, for example "Remove shop@example.com…". */
  readonly label: string;
  /** The question, for example "Remove shop@example.com?". */
  readonly question: string;
  /** What stops, and how to get it back. */
  readonly consequence: string;
  /** The button that runs the action, for example "Remove". */
  readonly confirmLabel: string;
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
 * The one action that removes or cuts something off. It is destructive, so
 * the first press asks in place and names what stops; only the second press
 * runs it. No dialog opens on top of the page or the drawer.
 */
export function RemoveConfirm(props: RemoveConfirmProps): React.ReactNode {
  const [confirming, setConfirming] = React.useState(false);
  if (!confirming) {
    return (
      <Button
        variant="danger"
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
    <div
      className="pantry-remove-confirm"
      role="group"
      aria-label={props.question}
    >
      <p className="pantry-remove-confirm-copy">
        <strong>{props.question}</strong> {props.consequence}
      </p>
      <Button
        variant="danger"
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
