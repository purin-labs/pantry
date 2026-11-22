import React from "react";
import { X } from "lucide-react";
import { cancelDialog, syncDialog } from "./dialog";
import "./side-drawer.css";

export type SideDrawerProps = {
  readonly open: boolean;
  readonly title: React.ReactNode;
  readonly close: () => void;
  /** Rendered only while the drawer is open. Wrap plain content in
   * `.side-drawer-body`; a form that scrolls its own fields may skip it. */
  readonly children?: React.ReactNode;
  /** The main action, pinned to the bottom edge. */
  readonly footer?: React.ReactNode;
  readonly className?: string;
  /** For a caller that queries inside the drawer, such as focusing the first
   * invalid field after a refused save. */
  readonly dialogRef?: React.RefObject<HTMLDialogElement | null>;
};

/**
 * A full-height panel that opens from the inline end. It is a modal
 * `<dialog>`: Escape and a click on the backdrop call `close`, and focus goes
 * back to the control that opened it. On a phone it fills the screen.
 */
export function SideDrawer(props: SideDrawerProps): React.ReactNode {
  const ownRef = React.useRef<HTMLDialogElement>(null);
  const dialog = props.dialogRef ?? ownRef;
  const headingId = React.useId();
  React.useEffect(() => {
    syncDialog(dialog, props.open);
  }, [dialog, props.open]);
  return (
    <dialog
      ref={dialog}
      className={`side-drawer ${props.className ?? ""}`}
      aria-labelledby={headingId}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.close();
      }}
      onCancel={cancelDialog.bind(null, props.close)}
    >
      {props.open ? (
        <>
          <header className="side-drawer-header">
            <h2 id={headingId}>{props.title}</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close"
              onClick={props.close}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          {props.children}
          {props.footer === undefined ? null : (
            <footer className="side-drawer-footer">{props.footer}</footer>
          )}
        </>
      ) : null}
    </dialog>
  );
}
