import React from "react";
import type { Blocker } from "react-router";
import type { VariantBy } from "@purin-labs/type-utils";
import { syncDialog, cancelDialog } from "../../dialog";

export function DraftLeaveDialog(
  props: Readonly<{
    blocker: VariantBy<Blocker, "state", "blocked">;
    draftName: string;
  }>,
): React.ReactNode {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useLayoutEffect(syncDialog.bind(null, ref, true), []);
  return (
    <dialog
      ref={ref}
      className="access35-dialog"
      aria-labelledby="draft-leave-title"
      onCancel={cancelDialog.bind(null, props.blocker.reset)}
    >
      <h2 id="draft-leave-title">Leave this {props.draftName}?</h2>
      <p>Your unsaved changes may be lost.</p>
      <div className="access35-dialog-actions">
        <button type="button" autoFocus onClick={props.blocker.reset}>
          Keep editing
        </button>
        <button type="button" onClick={props.blocker.proceed}>
          Leave page
        </button>
      </div>
    </dialog>
  );
}
