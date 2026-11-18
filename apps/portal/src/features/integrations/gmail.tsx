import React from "react";
import { useLocation } from "react-router";
import type { CredentialInventory } from "@seams/control-api/portal/credential-inventory";
import {
  EmptyState,
  ProviderTile,
  StatusChip,
  type StatusChipStatus,
} from "../../page-components";
import {
  MutationLedger,
  type OrganisationMutation,
} from "../../mutation-state";
import type { ProviderAttemptDiagnostics } from "../../provider-onboarding";
import { emailReplyIsOpenable, gmailMailboxStatus, gmailMailboxSummary, type MailboxInstallationOption } from "../../pages/agent-mailbox";
import type { AgentMailboxView, EmailReplyQueueItem, EmailOperationalQueueItem } from "@seams/control-api/portal/agent-mailbox";
import { PROVIDER_PRESENTATION } from "../../integration-catalogue";
import { ConnectionDialog } from "./connection-dialog";
import type { EmailReviewMutation } from "../email-review/review";
import { assertNever } from "@seams/std";
import { matchesRequestedIntegrationAccountId } from "./integrations-page";
import {
  GmailConnectionSetup,
  GmailMailboxDetail,
} from "./mailbox";
import {
  GMAIL_VIEW_FOCUS_ID,
  integrationAccountIsConnected,
  integrationLifecycleStatus,
  isFullMailboxGmailAccount,
  isSendOnlyGmailAccount,
  mutationBlocked,
  mutationFeedbackMessage,
  providerConnectionState,
} from "./settings-support";
import type { IntegrationAccount, OrganisationInferenceSelection } from "@seams/control-api/portal/settings";
import type { IntegrationsPageActions, PendingProviderAuthorization, SettingsMutationFeedback } from "./settings-types";

export type GmailIntegrationPanelProps = {
  readonly accounts: readonly IntegrationAccount[];
  /** The `account` query parameter: one mailbox's view, or null for the list. */
  readonly selectedAccountId: string | null;
  readonly accessPath: string;
  readonly inboxPath: string;
  readonly agentsPath: string;
  readonly credentialInventory: CredentialInventory | null;
  readonly agentMailboxes: readonly AgentMailboxView[];
  readonly emailReplies: readonly EmailReplyQueueItem[];
  readonly emailOperational: readonly EmailOperationalQueueItem[];
  readonly installations: readonly MailboxInstallationOption[];
  readonly inferenceSelection: OrganisationInferenceSelection;
  readonly canManage: boolean;
  readonly mutations: MutationLedger;
  readonly pendingAuthorization: PendingProviderAuthorization | null;
  readonly pendingConfirm: string | null;
  readonly requestConfirm: (key: string) => void;
  readonly lastAttempt: ProviderAttemptDiagnostics | null;
  readonly actions: IntegrationsPageActions;
  readonly feedback: SettingsMutationFeedback;
};

/**
 * One Gmail connection as the Email dialog lists it. A full mailbox carries
 * the agent's view of it. A send-only account, or a mailbox whose agent view
 * the workspace cannot read yet, carries the connection alone.
 */
export type GmailMailboxEntry =
  | {
      readonly kind: "mailbox";
      readonly integrationAccountId: string;
      readonly address: string;
      readonly mailbox: AgentMailboxView;
      readonly account: IntegrationAccount | null;
    }
  | {
      readonly kind: "connection";
      readonly integrationAccountId: string;
      readonly address: string;
      readonly account: IntegrationAccount;
    };

/**
 * The Email dialog. With no mailbox selected it lists every connection. With
 * one selected it shows that mailbox alone, so that no control on screen can
 * change another mailbox.
 */
export function GmailIntegrationPanel(
  props: GmailIntegrationPanelProps,
): React.ReactNode {
  const location = useLocation();
  const entries = gmailMailboxEntries(props.accounts, props.agentMailboxes);
  const selectedId =
    props.selectedAccountId ??
    emailReviewAccountId(
      location.hash,
      props.emailReplies,
      props.emailOperational,
    );
  const selected =
    selectedId === null
      ? null
      : (entries.find(matchesGmailMailboxEntry.bind(null, selectedId)) ?? null);
  const shownId = selected === null ? null : selected.integrationAccountId;
  const previousShownId = React.useRef<string | null | undefined>(undefined);
  React.useEffect(
    focusGmailViewAfterSwitch.bind(null, previousShownId, shownId),
    [shownId],
  );
  React.useEffect(focusEmailReviewFromLocationHash, [
    props.emailReplies,
    props.emailOperational,
    shownId,
  ]);
  if (selected === null) {
    return (
      <GmailMailboxList
        panel={props}
        entries={entries}
        pathname={location.pathname}
        search={location.search}
      />
    );
  }
  return (
    <GmailMailboxDetail
      key={selected.integrationAccountId}
      panel={props}
      entry={selected}
      listHref={gmailMailboxHref(location.pathname, location.search, null)}
    />
  );
}

export function gmailMailboxEntries(
  accounts: readonly IntegrationAccount[],
  mailboxes: readonly AgentMailboxView[],
): readonly GmailMailboxEntry[] {
  const entries: GmailMailboxEntry[] = [];
  const listed = new Set<string>();
  for (const mailbox of mailboxes) {
    listed.add(mailbox.integrationAccountId);
    entries.push({
      kind: "mailbox",
      integrationAccountId: mailbox.integrationAccountId,
      address: mailbox.observedAddress,
      mailbox,
      account:
        accounts.find(
          matchesRequestedIntegrationAccountId.bind(
            null,
            mailbox.integrationAccountId,
          ),
        ) ?? null,
    });
  }
  for (const account of accounts) {
    if (listed.has(account.integrationAccountId)) continue;
    entries.push({
      kind: "connection",
      integrationAccountId: account.integrationAccountId,
      address: account.displayName,
      account,
    });
  }
  return entries;
}

export function matchesGmailMailboxEntry(
  integrationAccountId: string,
  entry: GmailMailboxEntry,
): boolean {
  return entry.integrationAccountId === integrationAccountId;
}

/**
 * The link for one mailbox's view, or for the list when `accountId` is null.
 * It keeps every other query parameter and drops the hash, so the list link
 * also leaves a review that the hash had opened.
 */
export function gmailMailboxHref(
  pathname: string,
  search: string,
  accountId: string | null,
): string {
  const parameters = new URLSearchParams(search);
  if (accountId === null) parameters.delete("account");
  else parameters.set("account", accountId);
  const query = parameters.toString();
  return query.length === 0 ? pathname : `${pathname}?${query}`;
}

/**
 * A link to one review (`#email-review-<proposal>`) names no mailbox. Reviews
 * live in a mailbox's own view, so the link opens the mailbox that owns the
 * proposal.
 */
export function emailReviewAccountId(
  hash: string,
  replies: readonly EmailReplyQueueItem[],
  operational: readonly EmailOperationalQueueItem[],
): string | null {
  const encodedId = hash.slice(1);
  if (!encodedId.startsWith("email-review-")) return null;
  let proposalId: string;
  try {
    proposalId = decodeURIComponent(encodedId).slice("email-review-".length);
  } catch {
    return null;
  }
  for (const proposal of [...replies, ...operational]) {
    if (proposal.proposalId === proposalId)
      return proposal.integrationAccountId;
  }
  return null;
}

/**
 * A click on a row or on the back link removes the element that had focus.
 * Focus moves to the new view, so a keyboard or screen-reader user lands on
 * it. The first render leaves focus where the dialog put it.
 */
export function focusGmailViewAfterSwitch(
  previous: React.RefObject<string | null | undefined>,
  shownId: string | null,
): void {
  const switched =
    previous.current !== undefined && previous.current !== shownId;
  previous.current = shownId;
  if (switched) document.getElementById(GMAIL_VIEW_FOCUS_ID)?.focus();
}

export function emailDraftsWaiting(
  replies: readonly EmailReplyQueueItem[],
  operational: readonly EmailOperationalQueueItem[],
  integrationAccountId: string,
): number {
  let waiting = 0;
  for (const proposal of [...replies, ...operational]) {
    if (
      proposal.integrationAccountId === integrationAccountId &&
      emailReplyIsOpenable(proposal.lifecycleKind)
    )
      waiting += 1;
  }
  return waiting;
}

export function formatDraftsWaiting(waiting: number): string {
  if (waiting === 0) return "No drafts waiting";
  return `${waiting} ${waiting === 1 ? "draft" : "drafts"} waiting`;
}

/** The assigned agent's name, or null when the list of agents lacks it. */
export function mailboxAgentName(
  installations: readonly MailboxInstallationOption[],
  mailbox: AgentMailboxView,
): string | null {
  if (mailbox.binding === null) return null;
  return (
    installations.find(
      matchesMailboxInstallation.bind(null, mailbox.binding.installationId),
    )?.label ?? null
  );
}

export function matchesMailboxInstallation(
  installationId: string,
  option: MailboxInstallationOption,
): boolean {
  return option.installationId === installationId;
}

export function gmailMailboxEntryStatus(entry: GmailMailboxEntry): StatusChipStatus {
  if (entry.kind === "mailbox") return gmailMailboxStatus(entry.mailbox);
  if (entry.account.lifecycle.kind !== "active")
    return integrationLifecycleStatus(entry.account.lifecycle.kind);
  return isSendOnlyGmailAccount(entry.account)
    ? { kind: "neutral", label: "Send only" }
    : { kind: "neutral", label: "Connected" };
}

export function gmailMailboxEntrySummary(
  installations: readonly MailboxInstallationOption[],
  entry: GmailMailboxEntry,
): string {
  if (entry.kind === "mailbox") {
    return gmailMailboxSummary(
      entry.mailbox,
      mailboxAgentName(installations, entry.mailbox),
    );
  }
  return isSendOnlyGmailAccount(entry.account)
    ? "Send only. Seams Pantry sends email from this address after you approve it. It reads no mail."
    : "Connected. Mailbox settings are not available for this account yet.";
}

/** The second line of a list row: who answers the mail, and what waits. */
export function gmailMailboxRowDetail(
  panel: GmailIntegrationPanelProps,
  entry: GmailMailboxEntry,
): string {
  const waiting = formatDraftsWaiting(
    emailDraftsWaiting(
      panel.emailReplies,
      panel.emailOperational,
      entry.integrationAccountId,
    ),
  );
  if (entry.kind === "connection") {
    return isSendOnlyGmailAccount(entry.account)
      ? `Sends approved email · ${waiting}`
      : "No mailbox settings yet";
  }
  if (entry.mailbox.binding === null) return `No agent · ${waiting}`;
  const agent = mailboxAgentName(panel.installations, entry.mailbox);
  return `${agent ?? "Agent assigned"} · ${waiting}`;
}

/**
 * The list view: one row for each connection and nothing that changes a
 * mailbox. A row opens that mailbox's own view.
 */
export function GmailMailboxList(props: {
  readonly panel: GmailIntegrationPanelProps;
  readonly entries: readonly GmailMailboxEntry[];
  readonly pathname: string;
  readonly search: string;
}): React.ReactNode {
  const panel = props.panel;
  const connected = panel.accounts
    .filter(isFullMailboxGmailAccount)
    .some(integrationAccountIsConnected);
  const state = providerConnectionState(
    panel.mutations,
    panel.pendingAuthorization,
    panel.feedback,
    "gmail",
  );
  // The setup sheet opens by itself while no full mailbox is connected, a
  // Google sign-in is in progress, or the last attempt failed. The person can
  // close it; "Add mailbox" opens it again.
  const needsSetup =
    !connected || state.kind !== "idle" || panel.lastAttempt !== null;
  const [adding, setAdding] = React.useState<boolean | null>(null);
  // The sheet opens after the Email dialog around it, so that it shows above
  // that dialog. Layout effects open a child dialog before its parent.
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => setShown(true), []);
  const mailboxCount = panel.accounts
    .filter(isFullMailboxGmailAccount)
    .filter(integrationAccountIsConnected).length;
  const seenMailboxCount = React.useRef(mailboxCount);
  React.useEffect(() => {
    // A new mailbox closes a sheet that the person opened.
    if (mailboxCount > seenMailboxCount.current) setAdding(null);
    seenMailboxCount.current = mailboxCount;
  }, [mailboxCount]);
  const addMailbox = panel.canManage ? (
    <button
      type="button"
      className="connection-primary-action"
      onClick={() => setAdding(true)}
    >
      Add mailbox
    </button>
  ) : null;
  return (
    <>
      {props.entries.length === 0 || addMailbox === null ? null : (
        <div className="mailbox-list-heading">
          <h3>Mailboxes</h3>
          {addMailbox}
        </div>
      )}
      {props.entries.length === 0 ? null : (
        <ul
          className="mailbox-list"
          id={GMAIL_VIEW_FOCUS_ID}
          aria-label="Mailboxes"
          tabIndex={-1}
        >
          {props.entries.map(
            renderGmailMailboxRow.bind(
              null,
              panel,
              props.pathname,
              props.search,
            ),
          )}
        </ul>
      )}
      {!connected && !panel.canManage ? (
        <EmptyState
          title="No mailbox is connected"
          detail="A workspace admin can connect a Gmail mailbox for an agent to read and answer."
        />
      ) : null}
      {props.entries.length === 0 && addMailbox !== null ? (
        <EmptyState
          title="No mailbox yet"
          detail="Connect a Gmail support address. The agent reads its mail and prepares replies."
          action={addMailbox}
        />
      ) : null}
      {panel.canManage ? (
        <ConnectionDialog
          open={shown && (adding ?? needsSetup)}
          title={connected ? "Add another mailbox" : "Add a mailbox"}
          tile={
            <ProviderTile
              provider={PROVIDER_PRESENTATION.gmail.tile}
              label="Gmail"
            />
          }
          className="mailbox-add-sheet"
          close={() => setAdding(false)}
        >
          <GmailConnectionSetup
            connected={connected}
            state={state}
            lastAttempt={panel.lastAttempt}
            actions={panel.actions}
            sendOnlyConnected={panel.accounts.some(isSendOnlyGmailAccount)}
          />
        </ConnectionDialog>
      ) : null}
    </>
  );
}

export function renderGmailMailboxRow(
  panel: GmailIntegrationPanelProps,
  pathname: string,
  search: string,
  entry: GmailMailboxEntry,
): React.ReactNode {
  return (
    <li key={entry.integrationAccountId}>
      <a
        className="mailbox-row"
        href={gmailMailboxHref(pathname, search, entry.integrationAccountId)}
      >
        <span className="mailbox-row-identity">
          <strong>{entry.address}</strong>
          <span>{gmailMailboxRowDetail(panel, entry)}</span>
        </span>
        <StatusChip status={gmailMailboxEntryStatus(entry)} />
      </a>
    </li>
  );
}

export function settingsEmailReviewBusy(
  mutations: MutationLedger,
  mutation: EmailReviewMutation,
): boolean {
  return mutationBlocked(mutations, emailReviewOrganisationMutation(mutation));
}

export function settingsEmailReviewFeedback(
  feedback: SettingsMutationFeedback,
  mutation: EmailReviewMutation,
): string | null {
  return mutationFeedbackMessage(
    feedback,
    emailReviewOrganisationMutation(mutation),
  );
}

export function emailReviewOrganisationMutation(
  mutation: EmailReviewMutation,
): OrganisationMutation {
  switch (mutation.kind) {
    case "reply":
      return {
        kind: "email_reply",
        proposalId: mutation.proposalId,
        operation: mutation.operation,
      };
    case "operational":
      return {
        kind: "email_operational",
        proposalId: mutation.proposalId,
        operation: mutation.operation,
      };
    default:
      return assertNever(mutation, "Unexpected settings state");
  }
}

export function focusEmailReviewFromLocationHash(): void {
  const encodedId = window.location.hash.slice(1);
  if (!encodedId.startsWith("email-review-")) return;
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return;
  }
  const review = document.getElementById(id);
  if (!(review instanceof HTMLElement)) return;
  review.focus();
}
