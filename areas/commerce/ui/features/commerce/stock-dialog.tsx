import React from "react";

/**
 * The parts that the stock dialogs share: receive supplies, count or adjust
 * stock, and request production.
 */

/** The item that the dialog changes, and its facts. */
export function StockDialogContext(
  props: Readonly<{
    label: string;
    name: string;
    detail: string;
    children?: React.ReactNode;
  }>,
): React.ReactNode {
  return (
    <section className="stock-dialog-context" aria-label={props.label}>
      <div>
        <strong>{props.name}</strong>
        <span>{props.detail}</span>
      </div>
      {props.children}
    </section>
  );
}

/** A dialog that could not load: the reason, Close and Try again. */
export function StockDialogRetry(
  props: Readonly<{ message: string; close: () => void; retry: () => void }>,
): React.ReactNode {
  return (
    <>
      <div className="stock-dialog-body">
        <p role="alert">{props.message}</p>
      </div>
      <footer className="stock-dialog-actions">
        <button type="button" onClick={props.close}>
          Close
        </button>
        <button type="button" onClick={props.retry}>
          Try again
        </button>
      </footer>
    </>
  );
}

/** A dialog whose change is done: what happened, and Done. */
export function StockDialogDone(
  props: Readonly<{ close: () => void; children: React.ReactNode }>,
): React.ReactNode {
  return (
    <>
      <div className="stock-dialog-body">{props.children}</div>
      <footer className="stock-dialog-actions">
        <button
          type="button"
          className="connection-primary-action"
          onClick={props.close}
        >
          Done
        </button>
      </footer>
    </>
  );
}

/**
 * Cancel, or Discard changes once the person tried to close the dialog with
 * unsaved changes.
 */
export function StockDialogCancel(
  props: Readonly<{
    discard: boolean;
    discardChanges: () => void;
    close: () => void;
    label?: string;
  }>,
): React.ReactNode {
  return props.discard ? (
    <button type="button" className="danger" onClick={props.discardChanges}>
      Discard changes
    </button>
  ) : (
    <button type="button" onClick={props.close}>
      {props.label ?? "Cancel"}
    </button>
  );
}
