import React from "react";

/**
 * Modal dialog for agent console creation flows. Uses the native dialog
 * element with showModal(), so focus trapping, inertness of the page behind,
 * and Escape-to-close come from the platform: the same pattern the workspace
 * command palette uses.
 */
export function AgentModal(props: {
  readonly title: string;
  readonly description: string | null;
  readonly close: () => void;
  readonly children: React.ReactNode;
  readonly footer: React.ReactNode;
  /** A flow with its own look adds a class next to `agent-modal`. */
  readonly className?: string;
}): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(openAgentModal.bind(null, dialog), []);
  return (
    <dialog
      className={
        props.className === undefined
          ? "agent-modal"
          : `agent-modal ${props.className}`
      }
      aria-label={props.title}
      onCancel={cancelAgentModal.bind(null, props.close)}
      onClick={closeAgentModalFromBackdrop.bind(null, props.close)}
      ref={dialog}
    >
      <div className="agent-modal-panel">
        <div className="agent-modal-header">
          <div>
            <h3>{props.title}</h3>
            {props.description === null ? null : <p>{props.description}</p>}
          </div>
          <button
            type="button"
            className="agent-modal-close"
            aria-label="Close"
            onClick={closeAgentModal.bind(null, props.close)}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="agent-modal-body">{props.children}</div>
        <div className="agent-modal-footer">{props.footer}</div>
      </div>
    </dialog>
  );
}

function openAgentModal(
  dialog: React.RefObject<HTMLDialogElement | null>,
): () => void {
  const trigger = document.activeElement;
  dialog.current?.showModal();
  return closeOpenAgentModal.bind(null, dialog, trigger);
}

function closeOpenAgentModal(
  dialog: React.RefObject<HTMLDialogElement | null>,
  trigger: Element | null,
): void {
  if (dialog.current?.open === true) dialog.current.close();
  if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
}

function cancelAgentModal(
  close: () => void,
  event: React.SyntheticEvent<HTMLDialogElement>,
): void {
  event.preventDefault();
  close();
}

function closeAgentModal(close: () => void): void {
  close();
}

/**
 * The dialog element fills the viewport, so a click that lands on the dialog
 * itself rather than the panel is a backdrop click.
 */
function closeAgentModalFromBackdrop(
  close: () => void,
  event: React.MouseEvent<HTMLDialogElement>,
): void {
  if (event.target === event.currentTarget) close();
}

function CloseIcon(): React.ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m4 4 8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
