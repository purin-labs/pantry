import React from "react";

/**
 * The "Archive workspace" button and its typed confirmation: the person types
 * the Organisation name before the archive button enables.
 */
export function ArchiveConfirm(props: {
  readonly organisationName: string;
  readonly busy: boolean;
  readonly onArchive: () => Promise<void>;
  /** The text of the button that archives. Default: "Confirm archive". */
  readonly confirmLabel?: string;
}): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const trigger = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();
  if (!open) {
    return (
      <button
        type="button"
        className="danger-button"
        ref={trigger}
        aria-expanded="false"
        aria-controls={panelId}
        onClick={setArchiveConfirmOpen.bind(null, setOpen)}
      >
        Archive workspace
      </button>
    );
  }
  const matches = typed.trim() === props.organisationName;
  return (
    <div
      className="archive-confirm"
      id={panelId}
      role="group"
      aria-label="Archive workspace confirmation"
    >
      <label>
        <span>
          Type <strong>{props.organisationName}</strong> to confirm
        </span>
        <input
          value={typed}
          onChange={setArchiveConfirmText.bind(null, setTyped)}
          placeholder={props.organisationName}
          autoFocus
        />
      </label>
      <div className="archive-confirm-actions">
        <button
          type="button"
          className="danger-button"
          disabled={!matches || props.busy}
          onClick={runArchive.bind(null, props.onArchive)}
        >
          {props.confirmLabel ?? "Confirm archive"}
        </button>
        <button
          type="button"
          onClick={closeArchiveConfirm.bind(null, setOpen, setTyped, trigger)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function runArchive(action: () => Promise<void>): void {
  void action();
}

function setArchiveConfirmOpen(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(true);
}

function setArchiveConfirmText(
  setTyped: React.Dispatch<React.SetStateAction<string>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  setTyped(event.currentTarget.value);
}

function closeArchiveConfirm(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setTyped: React.Dispatch<React.SetStateAction<string>>,
  trigger: React.RefObject<HTMLButtonElement | null>,
): void {
  setOpen(false);
  setTyped("");
  window.requestAnimationFrame(focusArchiveTrigger.bind(null, trigger));
}

function focusArchiveTrigger(
  trigger: React.RefObject<HTMLButtonElement | null>,
): void {
  trigger.current?.focus();
}
