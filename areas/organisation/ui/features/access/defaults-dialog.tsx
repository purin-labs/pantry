import React from "react";
import { Check, Lock } from "lucide-react";

import { cancelDialog, DialogHeading, syncDialog } from "./dialog-elements";
import "./defaults-dialog.css";

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
        <div className="access35-defaults-groups">
          <section
            className="access35-defaults-on"
            aria-labelledby="access35-defaults-on-title"
          >
            <h3 id="access35-defaults-on-title">Turns on</h3>
            <ul>
              <li>
                <Check aria-hidden="true" size={18} />
                <span>
                  Owners and admins can read Case context and see connected
                  integrations.
                </span>
              </li>
              <li>
                <Check aria-hidden="true" size={18} />
                <span>
                  The Slack agent conversations that you selected keep ordinary
                  Case work.
                </span>
              </li>
            </ul>
          </section>
          <section aria-labelledby="access35-defaults-off-title">
            <h3 id="access35-defaults-off-title">Stays off</h3>
            <ul>
              <li>
                <Lock aria-hidden="true" size={18} />
                <span>
                  Provider data, files, payments and outside effects, until you
                  grant each one.
                </span>
              </li>
            </ul>
          </section>
        </div>
        <p className="access35-defaults-note">
          Applying it again never restores access that you removed.
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
