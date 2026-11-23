import React from "react";
import { ProviderTile, formatRelativeTime } from "@purin-labs/ui/page-components";
import { PROVIDER_PRESENTATION } from "../../integration-catalogue";
import {
  LastAttemptNotice,
  ProviderConnectAction,
  providerAttemptFailureCopy,
  type ProviderAttemptDiagnostics,
  type ProviderConnectionState,
} from "../../provider-onboarding";
import { gmailPauseCopy } from "@purin-labs/area-inbox/ui/pages/agent-mailbox";
import type { AgentMailboxView } from "@purin-labs/control-api/portal/agent-mailbox";
import { ConsentPoint } from "./connect-consent-dialog";
import { EmailReviewSurface } from "@purin-labs/area-inbox/ui/features/email-review/review";
import { mailboxCanTurnOn, turnOnHint } from "@purin-labs/area-inbox/ui/features/mail-setup/model";
import {
  MailboxModelConsent,
  useMailboxModelConsent,
} from "@purin-labs/area-inbox/ui/features/mail-setup/model-consent";
import {
  useMailboxSetup,
  type MailboxSetupControl,
} from "@purin-labs/area-inbox/ui/features/mail-setup/use-mailbox-setup";
import {
  type IntegrationAccountCommands,
  integrationAccountCommands,
  renderConnectionProblem,
} from "./accounts";
import {
  type GmailIntegrationPanelProps,
  type GmailMailboxEntry,
  gmailMailboxEntrySummary,
  settingsEmailReviewBusy,
  settingsEmailReviewFeedback,
} from "./gmail";
import {
  GMAIL_VIEW_FOCUS_ID,
  mutationBlocked,
  renderMutationFeedback,
} from "./settings-support";
import type { IntegrationsPageActions } from "./settings-types";
import { RemoveConfirm } from "./remove-confirm";

/**
 * The email onboarding card, built like the consent sheet: three short points
 * and one action. The points are the consent, so the action opens Google
 * itself. The send-only choice is one secondary button.
 */
export function GmailConnectionSetup(props: {
  readonly connected: boolean;
  readonly sendOnlyConnected: boolean;
  readonly state: ProviderConnectionState;
  readonly lastAttempt: ProviderAttemptDiagnostics | null;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  return (
    <section
      className="provider-consent"
      aria-label={
        props.connected ? "Add another mailbox" : "Connect a Gmail mailbox"
      }
    >
      <ul className="connect-consent-points">
        <ConsentPoint
          title="The agent answers new mail"
          detail="Routine replies go out after you turn the mailbox on. Sensitive replies wait as drafts for you."
        />
        <ConsentPoint
          title="Use a shop address"
          detail="Not a personal inbox. Purin Pantry can read all mail in the account."
          mark="caution"
        />
        <ConsentPoint
          title="You stay in control"
          detail="Turn the mailbox off or remove it at any time."
        />
      </ul>
      <ProviderConnectAction
        id="gmail-setup"
        service="Google"
        label="Continue with Google"
        state={props.state}
        disabled={false}
        connect={props.actions.connectGmail}
        cancel={props.actions.cancelProviderAuthorization}
        help={null}
        waitingHint="Finish the sign-in in the Google window. This page updates by itself."
      />
      {props.lastAttempt === null ? null : (
        <LastAttemptNotice
          attempt={props.lastAttempt}
          copy={providerAttemptFailureCopy(
            "Google",
            props.lastAttempt.reasonCode,
          )}
        />
      )}
      <p className="connection-fine-print">
        Purin keeps no message text, attachments or reply text. Your AI model
        provider reads the mail that the agent answers, under its own data
        terms.
      </p>
      <div className="connection-actions provider-onboarding-actions">
        <button
          type="button"
          onClick={props.actions.connectGmailSendOnly}
          disabled={
            props.state.kind === "opening" || props.state.kind === "waiting"
          }
          aria-describedby="gmail-send-only-help"
        >
          {props.sendOnlyConnected
            ? "Add another send-only Gmail"
            : "Connect send-only Gmail"}
        </button>
        <p id="gmail-send-only-help" className="notice-text">
          Only to send the messages you approve. Purin Pantry reads no mail.
        </p>
      </div>
    </section>
  );
}

/**
 * One mailbox's own view, in one column: the switch, what holds the mailbox
 * back, the emails that wait for review, and one remove action. Every
 * control names or carries this mailbox's account and no other mailbox
 * renders, so an action cannot reach the wrong one.
 */
export function GmailMailboxDetail(props: {
  readonly panel: GmailIntegrationPanelProps;
  readonly entry: GmailMailboxEntry;
  readonly listHref: string;
  /** The back link's label; the dialog's list of mailboxes by default. */
  readonly backLabel?: string;
  /** A page of its own: the address is the page's heading. */
  readonly page?: boolean;
}): React.ReactNode {
  const panel = props.panel;
  const entry = props.entry;
  const mailbox = entry.kind === "mailbox" ? entry.mailbox : null;
  const commands =
    entry.account === null || !panel.canManage
      ? null
      : integrationAccountCommands(
          panel.actions,
          {
            mutations: panel.mutations,
            pendingAuthorization: panel.pendingAuthorization,
            pendingConfirm: panel.pendingConfirm,
            requestConfirm: panel.requestConfirm,
            feedback: panel.feedback,
          },
          entry.account,
          entry.address,
        );
  const busy = mutationBlocked(panel.mutations, {
    kind: "agent_mailbox",
    integrationAccountId: entry.integrationAccountId,
  });
  // A person who can change the mailbox sees what it still needs. The setup
  // is read for a mailbox whose Gmail connection works.
  const setup = useMailboxSetup(
    panel.actions.readMailboxSetup,
    mailbox !== null &&
      panel.canManage &&
      mailbox.connectionLifecycle === "active"
      ? mailbox.integrationAccountId
      : null,
    mailbox === null
      ? ""
      : `${mailbox.binding?.mailboxBindingId ?? ""}:${String(mailbox.binding?.currentRevision ?? 0)}:${mailbox.policy.kind}`,
    !busy,
  );
  const ownsProposal = proposalBelongsToAccount.bind(
    null,
    entry.integrationAccountId,
  );
  return (
    <article
      className="mailbox-detail"
      data-presentation={props.page === true ? "page" : undefined}
      aria-labelledby={GMAIL_VIEW_FOCUS_ID}
    >
      <a className="mailbox-back" href={props.listHref}>
        <span aria-hidden="true">←</span> {props.backLabel ?? "Mailboxes"}
      </a>
      <header
        className="mailbox-detail-head"
        id={`integration-account-${entry.integrationAccountId}`}
      >
        <ProviderTile
          provider={PROVIDER_PRESENTATION.gmail.tile}
          label="Gmail"
        />
        <div>
          {props.page === true ? (
            <h1 id={GMAIL_VIEW_FOCUS_ID} tabIndex={-1}>
              {entry.address}
            </h1>
          ) : (
            <h3 id={GMAIL_VIEW_FOCUS_ID} tabIndex={-1}>
              {entry.address}
            </h3>
          )}
          {/* The sentence starts with the state, so the view needs no chip. */}
          <p>{gmailMailboxEntrySummary(panel.installations, entry)}</p>
        </div>
      </header>
      {mailbox === null || !panel.canManage ? null : (
        <GmailMailboxSwitch
          mailbox={mailbox}
          busy={busy}
          setup={setup}
          actions={panel.actions}
        />
      )}
      {renderMutationFeedback(panel.feedback, {
        kind: "agent_mailbox",
        integrationAccountId: entry.integrationAccountId,
      })}
      {renderMutationFeedback(panel.feedback, {
        kind: "integration_account",
        integrationAccountId: entry.integrationAccountId,
      })}
      <GmailMailboxRepair
        entry={entry}
        commands={commands}
        busy={busy}
        canManage={panel.canManage}
        actions={panel.actions}
      />
      <EmailReviewSurface
        queue={{
          replies: panel.emailReplies.filter(ownsProposal),
          operational: panel.emailOperational.filter(ownsProposal),
        }}
        canManage={panel.canManage}
        context="workspace"
        actions={panel.actions}
        isBusy={settingsEmailReviewBusy.bind(null, panel.mutations)}
        feedback={settingsEmailReviewFeedback.bind(null, panel.feedback)}
      />
      {panel.canManage ? (
        <GmailRemoveSection
          address={entry.address}
          mailbox={mailbox}
          commands={commands}
          busy={busy}
          actions={panel.actions}
        />
      ) : null}
    </article>
  );
}

function proposalBelongsToAccount(
  integrationAccountId: string,
  proposal: { readonly integrationAccountId: string },
): boolean {
  return proposal.integrationAccountId === integrationAccountId;
}

/**
 * The one control of the mailbox. While it is off, Turn on makes every change
 * that the mailbox needs and turns it on with the default limits, in one
 * press. Purin must have reviewed the workspace's AI model for email, and
 * the checkbox above Turn on accepts its data terms. While it is on, Turn
 * off stops it. Finish setup shows only when someone removed access that
 * the agent needs, and Continue only when the model changed or its review
 * ended, so its terms need a new acceptance.
 */
function GmailMailboxSwitch(props: {
  readonly mailbox: AgentMailboxView;
  readonly busy: boolean;
  readonly setup: MailboxSetupControl;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const mailbox = props.mailbox;
  const setup = props.setup.state;
  const plan = setup.kind === "ready" ? setup.plan : null;
  const consent = useMailboxModelConsent(plan);
  const hintId = `mailbox-switch-hint-${mailbox.integrationAccountId}`;
  const settling = props.busy || props.setup.reading;
  const press = (turnOn: boolean): (() => void) | undefined =>
    plan === null
      ? undefined
      : props.actions.setUpMailbox.bind(null, {
          integrationAccountId: mailbox.integrationAccountId,
          address: mailbox.observedAddress,
          agent: plan.agent,
          turnOn,
          accepted: consent.accepted,
        });
  const consentField =
    consent.review === null ? null : (
      <MailboxModelConsent
        review={consent.review}
        accepted={consent.accepted !== null}
        disabled={settling}
        onChange={consent.setAccepted}
      />
    );
  if (mailbox.policy.kind === "enabled") {
    const unfinished = plan !== null && plan.next !== null;
    return (
      <div className="mailbox-switch">
        <div className="connection-actions">
          <button
            type="button"
            data-account-id={mailbox.integrationAccountId}
            onClick={props.actions.disableMailbox}
            disabled={props.busy}
          >
            Turn off
          </button>
          {consent.review === null && unfinished ? (
            <button
              type="button"
              aria-describedby={hintId}
              onClick={press(false)}
              disabled={settling}
            >
              Finish setup
            </button>
          ) : null}
        </div>
        {consent.review !== null ? (
          <>
            <p className="notice-text" id={hintId}>
              The agent answers no new mail until you accept the terms of the AI
              model again. The model changed, or Purin&apos;s review of it
              ended.
            </p>
            {consentField}
            <div className="connection-actions">
              <button
                type="button"
                className="connection-primary-action"
                onClick={press(false)}
                disabled={consent.accepted === null || settling}
              >
                Continue
              </button>
            </div>
          </>
        ) : plan !== null && plan.model.kind === "not_reviewed" ? (
          <p className="notice-text" id={hintId}>
            {turnOnHint(plan)} The agent answers no new mail with it.
          </p>
        ) : unfinished && plan !== null ? (
          <p className="notice-text" id={hintId}>
            {plan.agent.name} lost access that it needs to answer mail. Finish
            setup gives it back.
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="mailbox-switch">
      {consentField}
      <button
        type="button"
        className="connection-primary-action"
        aria-describedby={hintId}
        onClick={press(true)}
        disabled={
          plan === null || !mailboxCanTurnOn(plan, consent.accepted) || settling
        }
      >
        Turn on
      </button>
      <p className="notice-text" id={hintId}>
        {plan !== null
          ? turnOnHint(plan)
          : setup.kind === "failed"
            ? "Purin Pantry could not check what this mailbox needs."
            : setup.kind === "absent"
              ? "Reconnect Gmail first. Purin Pantry reads no mail while Gmail refuses it."
              : "Purin Pantry checks what this mailbox needs."}
      </p>
      {setup.kind === "failed" ? (
        <div className="connection-actions">
          <button type="button" onClick={props.setup.retry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What holds the mailbox back, with the one action that repairs it. A mail
 * sync that Gmail stopped comes first, with Restart. A Gmail connection that
 * Google refuses comes next, with Reconnect, because no resume works before
 * it. A pause comes last, with Resume. A mailbox that works shows nothing
 * here.
 */
function GmailMailboxRepair(props: {
  readonly entry: GmailMailboxEntry;
  readonly commands: IntegrationAccountCommands | null;
  readonly busy: boolean;
  readonly canManage: boolean;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const account = props.entry.account;
  const mailbox = props.entry.kind === "mailbox" ? props.entry.mailbox : null;
  // Gmail no longer serves the point where the mail sync stopped. The
  // sign-in still works, so the sync starts again from now.
  if (
    mailbox !== null &&
    mailbox.policy.kind === "enabled" &&
    account !== null &&
    account.lifecycle.kind === "degraded" &&
    account.lifecycle.reasonCode === "gmail_history_expired"
  ) {
    return (
      <div className="notice notice-warning mailbox-banner" role="status">
        <p>
          Gmail stopped the mail sync. Restart it to read new mail from now.
          Mail that arrived in between stays in Gmail, unread.
        </p>
        {props.canManage ? (
          <div className="connection-actions">
            <button
              type="button"
              data-account-id={mailbox.integrationAccountId}
              onClick={props.actions.reconnectMailbox}
              disabled={props.busy}
            >
              Restart mail sync
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  if (account !== null && gmailRefuses(account.lifecycle.kind)) {
    return (
      <div className="notice notice-warning mailbox-banner" role="status">
        {renderConnectionProblem(account)}
        {props.commands === null ? null : (
          <div className="connection-actions">
            {props.commands.primary}
            {props.commands.cancel}
          </div>
        )}
      </div>
    );
  }
  const paused =
    mailbox?.runtime?.processing.kind === "paused"
      ? mailbox.runtime.processing
      : null;
  if (mailbox === null || paused === null) return null;
  const reason = paused.reason;
  // Gmail refused the sign-in and works again after a reconnect. The mail
  // sync starts again from where it stopped, so no mail is skipped.
  if (reason.kind === "authorization_expired") {
    return (
      <div className="notice notice-warning mailbox-banner" role="status">
        <p>
          Gmail is connected again. Resume to read the new mail that waits in
          Gmail.
        </p>
        {props.canManage ? (
          <div className="connection-actions">
            <button
              type="button"
              data-account-id={mailbox.integrationAccountId}
              onClick={props.actions.reconnectMailbox}
              disabled={props.busy}
            >
              Resume
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="notice notice-warning mailbox-banner" role="status">
      <p>
        {gmailPauseCopy(reason)} Paused {formatRelativeTime(paused.pausedAt)}.
        New mail stays in Gmail, unread.
      </p>
      {props.canManage ? (
        <div className="connection-actions">
          <button
            type="button"
            data-account-id={mailbox.integrationAccountId}
            onClick={props.actions.resumeMailbox}
            disabled={props.busy}
          >
            Resume
          </button>
          {reason.providerMessageId === null ? null : (
            <button
              type="button"
              data-account-id={mailbox.integrationAccountId}
              data-message-id={reason.providerMessageId}
              onClick={props.actions.skipAndResumeMailbox}
              disabled={props.busy}
            >
              Skip this message and resume
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Google refuses Purin Pantry, so only a new Google sign-in repairs it. */
function gmailRefuses(lifecycle: string): boolean {
  return (
    lifecycle === "degraded" ||
    lifecycle === "reauth_required" ||
    lifecycle === "disabled"
  );
}

/**
 * The one action that cuts a mailbox off. It is destructive, so it confirms
 * in place and names every consequence before it runs. Turn off already
 * pauses a mailbox, so no second, softer remove action exists. A send-only
 * connection has no mailbox: it shows the account's own remove action.
 */
function GmailRemoveSection(props: {
  readonly address: string;
  readonly mailbox: AgentMailboxView | null;
  readonly commands: IntegrationAccountCommands | null;
  readonly busy: boolean;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const mailbox = props.mailbox;
  if (mailbox === null) {
    const disconnect = props.commands === null ? [] : props.commands.danger;
    if (disconnect.length === 0) return null;
    return (
      <section className="mailbox-section mailbox-danger" aria-label="Remove">
        {disconnect}
      </section>
    );
  }
  return (
    <section className="mailbox-section mailbox-danger" aria-label="Remove">
      <RemoveConfirm
        label={`Remove ${props.address}…`}
        question={`Remove ${props.address}?`}
        consequence="Purin Pantry stops reading mail, cancels emails waiting to send, deletes the drafts it made and its Google sign-in. To use this mailbox again, connect it again."
        confirmLabel={`Remove ${props.address}`}
        busy={props.busy}
        onConfirm={props.actions.revokeMailbox}
        data={{ "account-id": mailbox.integrationAccountId }}
      />
    </section>
  );
}
