import React from "react";

import { cancelDialog, DialogHeading, syncDialog } from "./dialog-elements";

/**
 * Confirms the baseline materializer before it runs, naming exactly what the
 * recommended profile grants and what it deliberately leaves closed.
 */
export function ApplyDefaultsDialog(
  props: Readonly<{
    open: boolean;
    busy: boolean;
    close: () => void;
    apply: () => void;
  }>,
): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(syncDialog.bind(null, dialog, props.open), [props.open]);
  return (
    <dialog
      className="access35-dialog"
      ref={dialog}
      aria-labelledby="access35-defaults-dialog-title"
      onCancel={cancelDialog.bind(null, props.close)}
    >
      <form method="dialog" onSubmit={submitDefaults.bind(null, props.apply)}>
        <DialogHeading
          id="access35-defaults-dialog-title"
          title="Apply recommended access"
          close={props.close}
        />
        <p>
          The recommended profile sets the safe baseline for ordinary agent
          work:
        </p>
        <ul className="access35-defaults-effects">
          <li>
            Owners and admins may read Case context and discover connected
            integrations.
          </li>
          <li>
            Each selected Slack agent conversation keeps the capabilities for
            ordinary Case work.
          </li>
          <li>
            Provider data, files, payments, and outside effects stay closed
            until granted exactly.
          </li>
        </ul>
        <p>
          Reapplying is safe. It never restores access you deliberately revoked.
        </p>
        <div className="access35-dialog-actions">
          <button
            type="button"
            className="secondary"
            autoFocus
            onClick={props.close}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="connection-primary-action"
            disabled={props.busy}
          >
            {props.busy
              ? "Applying recommended access…"
              : "Apply recommended access"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function submitDefaults(
  apply: () => void,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  apply();
}
