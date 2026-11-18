import React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  Info,
  Mails,
  MoreHorizontal,
  OctagonAlert,
  Settings,
  Settings2,
} from "lucide-react";
import type { MailOrganizationView } from "@seams/control-api";
import {
  mailProcessingView,
  type MailProcessingState,
} from "./processing-state";
import { cancelDialog, DialogHeading, syncDialog } from "../../dialog";
import { GlideHighlight } from "../../ui/glide-highlight";
import "../../ui/action-menu.css";

type Props = Readonly<{
  processing: MailProcessingState;
  canManage: boolean;
  integrationsPath: string;
  /** The settings of the open mailbox, where its limits are set. */
  settingsHref: string | null;
  onToggle: (enabled: boolean) => void;
  /** Opens the rules. Focus returns to the given control when they close. */
  onRules: (opener: HTMLElement | null) => void;
  /** Shows all mail of the mailbox, or Gmail's Spam. */
  onView: (view: "all" | "spam") => void;
}>;

export function MailProcessingMenu(props: Props): React.ReactNode {
  const [infoOpen, setInfoOpen] = React.useState(false);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  /** The choice that moves focus, run when the menu has closed. */
  const selected = React.useRef<Choice | null>(null);
  React.useLayoutEffect(
    syncProcessingDialog.bind(null, dialog, trigger, infoOpen),
    [infoOpen],
  );
  const close = setInfoOpen.bind(null, false);
  const view = mailProcessingView(props.processing);
  const enabled = view?.rules.kind === "published";
  const canResume =
    view?.rules.kind === "paused" &&
    (view.readiness === "ready" || view.readiness === "history_expired");
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button
            ref={trigger}
            type="button"
            className="mail-icon-button"
            aria-label="Inbox options"
          >
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="action-menu mail-processing-menu"
            aria-label="Inbox options"
            align="end"
            sideOffset={6}
            collisionPadding={12}
            onCloseAutoFocus={finishMenuFocus.bind(
              null,
              dialog,
              trigger,
              selected,
              props,
            )}
          >
            <GlideHighlight target="[data-highlighted]" />
            <Menu.Group className="action-menu-section">
              <Menu.Label className="action-menu-heading">Show</Menu.Label>
              <Menu.Item
                className="action-menu-item"
                onSelect={choose.bind(null, selected, "all")}
              >
                <Mails size={16} aria-hidden="true" /> All mail
              </Menu.Item>
              <Menu.Item
                className="action-menu-item"
                onSelect={choose.bind(null, selected, "spam")}
              >
                <OctagonAlert size={16} aria-hidden="true" /> Spam
              </Menu.Item>
            </Menu.Group>
            <Menu.Label className="action-menu-heading">Inbox</Menu.Label>
            {view === null ? (
              <Menu.Item className="action-menu-item" disabled>
                <span className="action-menu-copy">
                  <span>Automatic mailbox processing</span>
                  <small>JEV applies published rules to new emails.</small>
                </span>
                <span className="mail-processing-state">
                  {props.processing.kind === "unavailable"
                    ? "Unavailable"
                    : "Checking…"}
                </span>
              </Menu.Item>
            ) : (
              <Menu.CheckboxItem
                className="action-menu-item"
                checked={enabled}
                disabled={
                  props.processing.kind !== "ready" ||
                  !props.canManage ||
                  (!enabled && !canResume)
                }
                onCheckedChange={changeProcessing.bind(null, props.onToggle)}
                aria-describedby="mail-processing-menu-note"
              >
                <span
                  className="action-menu-icon mail-processing-check"
                  aria-hidden="true"
                >
                  <Menu.ItemIndicator>
                    <Check size={16} />
                  </Menu.ItemIndicator>
                </span>
                <span className="action-menu-copy">
                  <span>Automatic mailbox processing</span>
                  <small>JEV applies published rules to new emails.</small>
                </span>
                <span className="mail-processing-state">
                  {props.processing.kind === "updating"
                    ? "Updating…"
                    : enabled
                      ? "On"
                      : "Off"}
                </span>
              </Menu.CheckboxItem>
            )}
            <p id="mail-processing-menu-note" className="action-menu-heading">
              {processingNote(props)}
            </p>
            <Menu.Item
              className="action-menu-item"
              onSelect={setInfoOpen.bind(null, true)}
            >
              <Info size={16} aria-hidden="true" /> Email processing and privacy
            </Menu.Item>
            <Menu.Item
              className="action-menu-item"
              onSelect={choose.bind(null, selected, "rules")}
            >
              <Settings2 size={16} aria-hidden="true" /> Review Inbox rules
            </Menu.Item>
            {props.settingsHref === null ? null : (
              <Menu.Item className="action-menu-item" asChild>
                <a href={props.settingsHref}>
                  <Settings size={16} aria-hidden="true" /> Mailbox settings
                </a>
              </Menu.Item>
            )}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <dialog
        ref={dialog}
        className="connection-dialog mail-processing-dialog"
        aria-labelledby="mail-processing-dialog-title"
        onCancel={cancelDialog.bind(null, close)}
      >
        <DialogHeading
          id="mail-processing-dialog-title"
          title="Email processing and privacy"
          close={close}
        />
        <div className="connection-dialog-content">
          <p>
            JEV receives email evidence through TypeSafe to categorize and
            prioritize new mail using your published rules. Resuming starts with
            future arrivals. Saved rules and classifications remain when you
            pause; older mail is classified only when you request it.
          </p>
          <p>
            Matching reply rules can delegate work to the assigned mailbox
            agent. That work uses the model provider selected in Integrations,
            such as OpenAI through your ChatGPT connection. Prepared replies
            require your approval before sending.
          </p>
          <p>
            Email evidence sent to TypeSafe or your agent’s model provider is
            subject to that provider’s terms, data settings and service
            providers. Training settings and retention are separate controls;
            disabling training does not establish a deletion period.
          </p>
          <p>
            A fixed retention period and complete downstream-provider list for
            the current ChatGPT Pro/Codex pilot have not been verified. This
            disclosure records that uncertainty; your processing choices remain
            under your control.
          </p>
          <p>
            This toggle controls JEV rules. General mailbox-agent processing is
            managed separately in Integrations. Gmail browsing remains available
            while JEV is off.
          </p>
          <div className="mail-processing-dialog-actions">
            <a href={props.integrationsPath}>Manage integrations</a>
            <button type="button" onClick={close}>
              Close
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

function processingNote(props: Props): string {
  if (props.processing.kind === "loading")
    return "Loading processing settings…";
  if (props.processing.kind === "unavailable")
    return "Processing status is unavailable. Refresh the Inbox to retry.";
  if (props.processing.kind === "updating")
    return "Updating processing settings…";
  if (!props.canManage)
    return "A mailbox administrator manages automatic processing.";
  const view: MailOrganizationView = props.processing.view;
  if (view.rules.kind === "empty")
    return "Publish Inbox rules to start automatic processing.";
  if (view.rules.kind === "published")
    return "Turn off to pause JEV classification and rule follow-up.";
  if (view.readiness === "typesafe_unavailable")
    return "Connect TypeSafe in Integrations to resume.";
  if (view.readiness === "eligibility_required")
    return "Review and publish rules for the current mailbox connection.";
  return "Turn on to resume the saved rules for future arrivals.";
}

function changeProcessing(
  onToggle: Props["onToggle"],
  checked: boolean | "indeterminate",
): void {
  if (typeof checked === "boolean") onToggle(checked);
}

type Choice = "rules" | "all" | "spam";

function choose(
  selected: React.RefObject<Choice | null>,
  choice: Choice,
): void {
  selected.current = choice;
}

/** The chosen view or panel takes focus, so the trigger does not take it. */
function finishMenuFocus(
  dialog: React.RefObject<HTMLDialogElement | null>,
  trigger: React.RefObject<HTMLButtonElement | null>,
  selected: React.RefObject<Choice | null>,
  props: Props,
  event: Event,
): void {
  const choice = selected.current;
  selected.current = null;
  if (choice !== null) {
    event.preventDefault();
    if (choice === "rules") props.onRules(trigger.current);
    else props.onView(choice);
  } else if (dialog.current?.open) event.preventDefault();
}

function syncProcessingDialog(
  dialog: React.RefObject<HTMLDialogElement | null>,
  trigger: React.RefObject<HTMLButtonElement | null>,
  open: boolean,
): void {
  const wasOpen = dialog.current?.open === true;
  syncDialog(dialog, open);
  if (wasOpen && !open) trigger.current?.focus();
}
