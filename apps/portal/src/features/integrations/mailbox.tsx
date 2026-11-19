import { Select } from "../../ui/select";
import React from "react";
import {
  Check,
  Circle,
} from "lucide-react";
import { Link } from "react-router";
import { findCredentialAccountRecord } from "../../credential-inventory";
import {
  Notice,
  ProviderTile,
  StatusChip,
  formatRelativeTime,
} from "../../page-components";
import { PROVIDER_PRESENTATION } from "../../integration-catalogue";
import {
  LastAttemptNotice,
  ProviderConnectAction,
  providerAttemptFailureCopy,
  type ProviderAttemptDiagnostics,
  type ProviderConnectionState,
} from "../../provider-onboarding";
import { DEFAULT_MAILBOX_POLICY, mailboxAuthorizationNotice, gmailPauseCopy, type MailboxInstallationOption } from "../../pages/agent-mailbox";
import type { AgentMailboxView, MailboxProcessingView } from "@purin-labs/control-api/portal/agent-mailbox";
import { ConsentPoint } from "./connect-consent-dialog";
import { EmailReviewSurface } from "../email-review/review";
import type { Variant } from "@purin-labs/type-utils";
import {
  encodeMailboxSetupAgentChoice,
  parseMailboxSetupAgentChoice,
  type MailboxSetupPlan,
} from "@purin-labs/control-api";
import {
  ACCESS_REQUIREMENTS,
  actionHint,
  agentSentence,
  mailboxSetupAction,
  modelSentence,
  requirementIsMet,
} from "../mail-setup/model";
import {
  useMailboxSetup,
  type MailboxSetupControl,
} from "../mail-setup/use-mailbox-setup";
import {
  CredentialRecoveryActions,
  type IntegrationAccountCommands,
  integrationAccountCommands,
  isCredentialReplacementCandidate,
  renderConnectionProblem,
  renderIntegrationAccountDetails,
} from "./accounts";
import {
  type GmailIntegrationPanelProps,
  type GmailMailboxEntry,
  emailDraftsWaiting,
  formatDraftsWaiting,
  gmailMailboxEntryStatus,
  gmailMailboxEntrySummary,
  mailboxAgentName,
  settingsEmailReviewBusy,
  settingsEmailReviewFeedback,
} from "./gmail";
import type { MailboxSetupRequest } from "./mailbox-actions";
import {
  GMAIL_VIEW_FOCUS_ID,
  integrationAccountBusy,
  mutationBlocked,
  renderConnectionRecency,
  renderMutationFeedback,
} from "./settings-support";
import type { IntegrationsPageActions } from "./settings-types";
import type { OrganisationInferenceSelection } from "@purin-labs/control-api/portal/settings";
import { inferenceRouteName } from "./slack";

/**
 * The email onboarding card, built like the consent sheet: three short points
 * and one action. The points are the consent, so the action opens Google
 * itself. The data handling waits behind a disclosure. The send-only choice
 * is a secondary button.
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
          title="Use a support address"
          detail="Not a personal inbox. Seams Pantry can read all mail in the account."
          mark="caution"
        />
        <ConsentPoint
          title="You stay in control"
          detail="Remove access at any time. During the pilot, sign in again every 7 days."
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
          For sending only: Seams Pantry sends the messages you approve and
          cannot read your mail.
        </p>
      </div>
      <div className="connection-fine-print">
        <p>
          Until the mailbox is on, new mail stays in Gmail untouched. Seams
          Pantry then reads only the mail that your mailbox rules or an access
          grant allow.
        </p>
        <GmailRetentionDisclosure />
      </div>
    </section>
  );
}

function GmailRetentionDisclosure(): React.ReactNode {
  return (
    <p>
      Seams does not keep message text, attachments or reply text. Gmail keeps
      your mail, drafts and sent mail under your Google Workspace rules. Your AI
      account processes the mail that Seams Pantry reads under its own data
      terms. This processing does not use dedicated secure hardware.
    </p>
  );
}

/**
 * One mailbox's own view. Every control here names or carries this mailbox's
 * account and no other mailbox renders, so an action cannot reach the wrong
 * one.
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
  const limitsFormId = `mailbox-limits-${entry.integrationAccountId}`;
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
  // Built like the wide permission screen: the mailbox and what it does on
  // the left, what it is allowed to do on a band on the right. On a narrow
  // sheet the setup comes right after the switch.
  return (
    <article
      className="mailbox-detail"
      data-presentation={props.page === true ? "page" : undefined}
      data-layout={mailbox === null ? undefined : "split"}
      aria-labelledby={GMAIL_VIEW_FOCUS_ID}
    >
      <div className="mailbox-detail-main">
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
            <p>{gmailMailboxEntrySummary(panel.installations, entry)}</p>
          </div>
          <StatusChip status={gmailMailboxEntryStatus(entry)} />
        </header>
        {mailbox === null ? null : (
          <GmailMailboxProcessing
            panel={panel}
            mailbox={mailbox}
            busy={busy}
            limitsFormId={limitsFormId}
            setup={setup}
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
      </div>
      {mailbox === null ? null : (
        <div className="mailbox-detail-aside">
          <GmailMailboxSetup
            panel={panel}
            mailbox={mailbox}
            busy={busy}
            setup={setup}
          />
        </div>
      )}
      <div className="mailbox-detail-rest">
        <EmailReviewSurface
          queue={{
            replies: panel.emailReplies.filter(
              proposalBelongsToAccount.bind(null, entry.integrationAccountId),
            ),
            operational: panel.emailOperational.filter(
              proposalBelongsToAccount.bind(null, entry.integrationAccountId),
            ),
          }}
          canManage={panel.canManage}
          context="workspace"
          actions={panel.actions}
          isBusy={settingsEmailReviewBusy.bind(null, panel.mutations)}
          feedback={settingsEmailReviewFeedback.bind(null, panel.feedback)}
        />
        {mailbox === null || !panel.canManage ? null : (
          <GmailLimitsSection
            mailbox={mailbox}
            busy={busy}
            formId={limitsFormId}
            inferenceSelection={panel.inferenceSelection}
            actions={panel.actions}
          />
        )}
        <GmailConnectionSection
          panel={panel}
          entry={entry}
          commands={commands}
          busy={busy}
        />
        {panel.canManage ? (
          <GmailDangerSection
            address={entry.address}
            mailbox={mailbox}
            commands={commands}
            busy={busy}
            actions={panel.actions}
          />
        ) : null}
      </div>
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
 * The processing state of a full mailbox: the switch, and a banner when the
 * authorization or a limit holds processing back.
 */
function GmailMailboxProcessing(props: {
  readonly panel: GmailIntegrationPanelProps;
  readonly mailbox: AgentMailboxView;
  readonly busy: boolean;
  readonly limitsFormId: string;
  readonly setup: MailboxSetupControl;
}): React.ReactNode {
  const panel = props.panel;
  const mailbox = props.mailbox;
  const paused =
    mailbox.runtime?.processing.kind === "paused"
      ? mailbox.runtime.processing
      : null;
  // An expired authorization is stated in full by its own notice, and
  // resuming cannot clear it (only reconnecting can), so the pause banner
  // would repeat the problem and offer the wrong control.
  const authorizationPaused = paused?.reason.kind === "authorization_expired";
  return (
    <>
      {panel.canManage ? (
        <GmailProcessingSwitch
          mailbox={mailbox}
          busy={props.busy}
          limitsFormId={props.limitsFormId}
          setup={props.setup}
          actions={panel.actions}
        />
      ) : null}
      {renderMailboxAuthorizationWarning(mailbox)}
      {paused === null || authorizationPaused ? null : (
        <GmailPauseBanner
          mailbox={mailbox}
          paused={paused}
          busy={props.busy}
          canManage={panel.canManage}
          actions={panel.actions}
        />
      )}
    </>
  );
}

/**
 * The one control that turns email processing on or off, with the mailbox in
 * its label. While the mailbox is off, the control also makes the changes
 * that the mailbox still needs, so that one press is enough. Turning on
 * carries the limit values on screen. Turning off uses the disable action.
 */
function GmailProcessingSwitch(props: {
  readonly mailbox: AgentMailboxView;
  readonly busy: boolean;
  readonly limitsFormId: string;
  readonly setup: MailboxSetupControl;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const mailbox = props.mailbox;
  if (mailbox.policy.kind === "enabled") {
    return (
      <div className="mailbox-switch">
        <button
          type="button"
          data-account-id={mailbox.integrationAccountId}
          onClick={props.actions.disableMailbox}
          disabled={props.busy}
        >
          Turn off for {mailbox.observedAddress}
        </button>
      </div>
    );
  }
  const hintId = `mailbox-switch-hint-${mailbox.integrationAccountId}`;
  const setup = props.setup.state;
  if (setup.kind !== "ready") {
    return (
      <div className="mailbox-switch">
        <button
          type="button"
          className="connection-primary-action"
          aria-describedby={hintId}
          disabled
        >
          Turn on for {mailbox.observedAddress}
        </button>
        <p className="notice-text" id={hintId}>
          {setup.kind === "failed"
            ? "Pantry could not check what this mailbox needs. Try again under Setup."
            : setup.kind === "absent"
              ? "Reconnect this mailbox first. Seams Pantry reads no mail while Gmail refuses it."
              : "Seams Pantry checks what this mailbox needs."}
        </p>
      </div>
    );
  }
  const plan = setup.plan;
  const action = mailboxSetupAction(plan);
  const request = (limitsFormId: string | null): MailboxSetupRequest => ({
    integrationAccountId: mailbox.integrationAccountId,
    address: mailbox.observedAddress,
    agent: plan.agent,
    limitsFormId,
  });
  return (
    <div className="mailbox-switch">
      {action === "turn_on" || action === "wait_for_model" ? (
        <button
          type="button"
          className="connection-primary-action"
          aria-describedby={hintId}
          onClick={submitMailboxLimitsForm.bind(null, props.limitsFormId)}
          disabled={
            props.busy || props.setup.reading || action === "wait_for_model"
          }
        >
          Turn on for {mailbox.observedAddress}
        </button>
      ) : (
        <button
          type="button"
          className="connection-primary-action"
          aria-describedby={hintId}
          onClick={props.actions.setUpMailbox.bind(
            null,
            request(
              action === "set_up_and_turn_on" ? props.limitsFormId : null,
            ),
          )}
          disabled={props.busy || props.setup.reading}
        >
          {props.busy
            ? "Setting up…"
            : action === "set_up_and_turn_on"
              ? `Set up and turn on for ${mailbox.observedAddress}`
              : `Set up ${mailbox.observedAddress}`}
        </button>
      )}
      <p className="notice-text" id={hintId}>
        {actionHint(plan, action)}
      </p>
    </div>
  );
}

/**
 * Submits the limits form from the switch, which sits outside the form. A
 * closed Limits section cannot show which field is invalid, so it opens first.
 */
function submitMailboxLimitsForm(formId: string): void {
  const form = document.getElementById(formId);
  if (!(form instanceof HTMLFormElement)) return;
  const section = form.closest("details");
  if (section !== null && !form.checkValidity()) section.open = true;
  form.requestSubmit();
}

/**
 * The authorization window is stated in the console rather than left to a
 * calendar reminder, because an expired Gmail grant produces no visible error
 * on its own: replies simply stop. While it is comfortably valid the date
 * sits in the Connection section; as the deadline approaches, and once
 * processing has stopped, it is a banner in the mailbox's main view.
 */
function renderMailboxAuthorizationWarning(
  mailbox: AgentMailboxView,
): React.ReactNode {
  const notice = mailboxAuthorizationNotice(mailbox, Date.now());
  if (notice === null || notice.tone === "info") return null;
  return (
    <Notice tone="warning" announcement="polite">
      <strong>{notice.headline}.</strong> {notice.detail}
    </Notice>
  );
}

function GmailPauseBanner(props: {
  readonly mailbox: AgentMailboxView;
  readonly paused: Variant<MailboxProcessingView, "paused">;
  readonly busy: boolean;
  readonly canManage: boolean;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const reason = props.paused.reason;
  return (
    <div className="notice notice-warning mailbox-banner" role="status">
      <p>
        {gmailPauseCopy(reason)} Paused{" "}
        {formatRelativeTime(props.paused.pausedAt)}. New mail stays in Gmail.
        The agent has not read it.
      </p>
      {props.canManage ? (
        <div className="connection-actions">
          <button
            type="button"
            data-account-id={props.mailbox.integrationAccountId}
            onClick={props.actions.resumeMailbox}
            disabled={props.busy}
          >
            Resume processing
          </button>
          {reason.providerMessageId === null ? null : (
            <button
              type="button"
              data-account-id={props.mailbox.integrationAccountId}
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

/**
 * Setup as four short rows: who answers, what they may do, which model reads
 * the mail, and where drafts go. A person who can change the mailbox sees
 * what is done and what the setup action still does.
 */
function GmailMailboxSetup(props: {
  readonly panel: GmailIntegrationPanelProps;
  readonly mailbox: AgentMailboxView;
  readonly busy: boolean;
  readonly setup: MailboxSetupControl;
}): React.ReactNode {
  const panel = props.panel;
  const mailbox = props.mailbox;
  const titleId = `mailbox-setup-${mailbox.integrationAccountId}`;
  const waiting = emailDraftsWaiting(
    panel.emailReplies,
    panel.emailOperational,
    mailbox.integrationAccountId,
  );
  const setup = props.setup.state;
  const plan = setup.kind === "ready" ? setup.plan : null;
  const accessDone =
    plan !== null &&
    ACCESS_REQUIREMENTS.every((requirement) =>
      requirementIsMet(plan, requirement.id),
    );
  return (
    <section className="mailbox-setup" aria-labelledby={titleId}>
      <h4 id={titleId}>Setup</h4>
      {/* The region stays mounted, so the failure is announced when it
          appears. */}
      <div role="status">
        {setup.kind === "failed" ? (
          <div className="notice notice-warning mailbox-banner">
            <p>Pantry could not check what this mailbox needs.</p>
            <div className="connection-actions">
              <button type="button" onClick={props.setup.retry}>
                Try again
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <dl>
        <div>
          <dt>Agent</dt>
          <dd>
            {plan === null ? (
              <p>
                {mailbox.binding === null
                  ? "No agent"
                  : (mailboxAgentName(panel.installations, mailbox) ??
                    "Agent assigned")}
              </p>
            ) : (
              <MailboxAgentChoice
                panel={panel}
                mailbox={mailbox}
                plan={plan}
                busy={props.busy}
                setup={props.setup}
              />
            )}
          </dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>
            {plan === null ? (
              <p>
                The agent needs “Read Case context”. The workspace needs the
                actions “Propose an email reply” and “Read a connected mailbox”
                set to Enabled.{" "}
                <Link to={panel.accessPath}>Check them in Access</Link>.
              </p>
            ) : accessDone ? (
              <p>
                {plan.agent.name} has the access it needs. You can change it in{" "}
                <Link to={panel.accessPath}>Access</Link>.
              </p>
            ) : (
              <>
                <ul className="mailbox-setup-list">
                  {ACCESS_REQUIREMENTS.map((requirement) => (
                    <MailboxSetupItem
                      key={requirement.id}
                      met={requirementIsMet(plan, requirement.id)}
                      label={requirement.label(plan.agent.name)}
                    />
                  ))}
                </ul>
                <p className="notice-text">
                  You can change each of them later in{" "}
                  <Link to={panel.accessPath}>Access</Link>.
                </p>
              </>
            )}
          </dd>
        </div>
        {plan === null ? null : (
          <div>
            <dt>AI model</dt>
            <dd>
              <ul className="mailbox-setup-list">
                <MailboxSetupItem
                  met={plan.model.kind === "approved"}
                  label={modelSentence(plan)}
                />
              </ul>
            </dd>
          </div>
        )}
        <div>
          <dt>Drafts</dt>
          <dd>
            <p>
              {waiting === 0 ? null : `${formatDraftsWaiting(waiting)}. `}
              <Link to={panel.inboxPath}>Review and edit drafts in Inbox</Link>.
              A correction teaches the agent only when you make it there.
            </p>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** One line of the setup: what it is, and if it is done. */
function MailboxSetupItem(props: {
  readonly met: boolean;
  readonly label: string;
}): React.ReactNode {
  return (
    <li data-state={props.met ? "met" : "missing"}>
      {props.met ? (
        <Check className="mailbox-setup-mark" size={16} aria-hidden="true" />
      ) : (
        <Circle className="mailbox-setup-mark" size={16} aria-hidden="true" />
      )}
      <span>{props.label}</span>
      <span className="mailbox-setup-state">
        {props.met ? "Done" : "Not yet"}
      </span>
    </li>
  );
}

/**
 * The agent of the mailbox. The list names each agent of the workspace. An
 * agent that is not active yet can be chosen: the setup makes it active. A
 * workspace with no agent gets one from Pantry.
 */
function MailboxAgentChoice(props: {
  readonly panel: GmailIntegrationPanelProps;
  readonly mailbox: AgentMailboxView;
  readonly plan: MailboxSetupPlan;
  readonly busy: boolean;
  readonly setup: MailboxSetupControl;
}): React.ReactNode {
  const { panel, mailbox, plan } = props;
  const chosen = encodeMailboxSetupAgentChoice(plan.agent.choice);
  const options = panel.installations.map(mailboxAgentOption);
  if (!options.some((option) => option.value === chosen))
    options.push({ value: chosen, label: plan.agent.name });
  const on = mailbox.policy.kind === "enabled";
  return (
    <>
      {options.length < 2 ? null : (
        <div className="inline-form">
          <label>
            <span className="visually-hidden">
              Agent for {mailbox.observedAddress}
            </span>
            <Select.Root
              items={options}
              value={chosen}
              disabled={props.busy}
              onValueChange={(value) => {
                if (value === null) return;
                const choice = parseMailboxSetupAgentChoice(value);
                if (choice !== null) props.setup.choose(choice);
              }}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {options.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
        </div>
      )}
      <p>{agentSentence(plan.agent)}</p>
      {on && plan.next !== null ? (
        <div className="connection-actions">
          <button
            type="button"
            onClick={panel.actions.setUpMailbox.bind(null, {
              integrationAccountId: mailbox.integrationAccountId,
              address: mailbox.observedAddress,
              agent: plan.agent,
              limitsFormId: null,
            })}
            disabled={props.busy || props.setup.reading}
          >
            {plan.agent.state === "assigned"
              ? "Finish the setup"
              : `Change the agent to ${plan.agent.name}`}
          </button>
        </div>
      ) : null}
      {on && plan.agent.state !== "assigned" ? (
        <p className="notice-text">
          A change applies to new email threads. Open Cases keep their agent.
        </p>
      ) : null}
      {options.length < 2 && plan.agent.state !== "absent" ? (
        <p className="notice-text">
          To give this mailbox another agent,{" "}
          <Link to={panel.agentsPath}>add one on Agents</Link>.
        </p>
      ) : null}
    </>
  );
}

function mailboxAgentOption(option: MailboxInstallationOption): {
  value: string;
  label: string;
} {
  return option.kind === "ready"
    ? {
        value: encodeMailboxSetupAgentChoice({
          kind: "installation",
          installationId: option.installationId,
        }),
        label: option.label,
      }
    : {
        value: encodeMailboxSetupAgentChoice({
          kind: "definition",
          agentDefinitionId: option.agentDefinitionId,
        }),
        label: option.label,
      };
}

/**
 * The five limits. The form always sends `processingEnabled=on`, because a
 * policy that is off stores no limits. While the mailbox is off, the switch
 * submits this form to turn it on. While it is on, Save limits publishes the
 * policy again and processing stays on.
 */
function GmailLimitsSection(props: {
  readonly mailbox: AgentMailboxView;
  readonly busy: boolean;
  readonly formId: string;
  readonly inferenceSelection: OrganisationInferenceSelection;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const policy = props.mailbox.policy;
  const current = policy.kind === "enabled" ? policy : null;
  const usage =
    current === null || props.mailbox.runtime === null
      ? null
      : props.mailbox.runtime.usage;
  return (
    <section className="mailbox-section" aria-label="Limits">
      <h4>Limits</h4>
      <div className="mailbox-section-body">
        <p className="notice-text">
          Seams Pantry pauses this mailbox when it reaches a limit. Most shops
          can keep these numbers.
        </p>
        <form
          key={`${props.mailbox.integrationAccountId}-v${current?.policyVersion ?? 0}`}
          id={props.formId}
          className="setup-form"
          onSubmit={props.actions.publishMailboxPolicy}
        >
          <input
            type="hidden"
            name="integrationAccountId"
            value={props.mailbox.integrationAccountId}
          />
          <input type="hidden" name="processingEnabled" value="on" />
          <label>
            <span>Emails in progress at one time</span>
            <input
              name="maxActiveCases"
              type="number"
              min="1"
              step="1"
              defaultValue={
                current?.maxActiveCases ?? DEFAULT_MAILBOX_POLICY.maxActiveCases
              }
              required
            />
            {usage === null ? null : (
              <span className="field-hint">{usage.activeCases} active now</span>
            )}
          </label>
          <label>
            <span>New emails per hour</span>
            <input
              name="maxMessagesPerHour"
              type="number"
              min="1"
              step="1"
              defaultValue={
                current?.maxMessagesPerHour ??
                DEFAULT_MAILBOX_POLICY.maxMessagesPerHour
              }
              required
            />
            {usage === null ? null : (
              <span className="field-hint">
                {usage.admittedLastHour} in the last hour
              </span>
            )}
          </label>
          <label>
            <span>Daily AI allowance (tokens)</span>
            <input
              name="dailyTokenBudget"
              type="number"
              min="1"
              step="1"
              defaultValue={
                current?.dailyTokenBudget ??
                DEFAULT_MAILBOX_POLICY.dailyTokenBudget
              }
              required
            />
            {usage === null ? null : (
              <span className="field-hint">
                {usage.tokensConsumed.toLocaleString()} used today ·{" "}
                {usage.tokensReserved.toLocaleString()} reserved
              </span>
            )}
          </label>
          <MegabyteField
            label="Largest email (MB)"
            name="maxMessageBytes"
            bytes={
              current?.maxMessageBytes ?? DEFAULT_MAILBOX_POLICY.maxMessageBytes
            }
          />
          <MegabyteField
            label="Largest attachment (MB)"
            name="maxAttachmentBytes"
            bytes={
              current?.maxAttachmentBytes ??
              DEFAULT_MAILBOX_POLICY.maxAttachmentBytes
            }
          />
          <div className="setup-form-actions">
            {current === null ? (
              <p className="notice-text">
                Seams Pantry saves these limits when you turn on{" "}
                {props.mailbox.observedAddress}.
              </p>
            ) : (
              <button type="submit" disabled={props.busy}>
                Save limits
              </button>
            )}
          </div>
        </form>
        <p className="notice-text">
          New emails use {inferenceRouteName(props.inferenceSelection)}, under
          that provider's data terms.
        </p>
      </div>
    </section>
  );
}

const BYTES_PER_MEGABYTE = 1_048_576;

/**
 * A size limit in megabytes. The policy stores bytes, so a hidden field carries
 * the value that the form submits.
 */
function MegabyteField(props: {
  readonly label: string;
  readonly name: string;
  readonly bytes: number;
}): React.ReactNode {
  const [megabytes, setMegabytes] = React.useState(
    String(props.bytes / BYTES_PER_MEGABYTE),
  );
  return (
    <label>
      <span>{props.label}</span>
      <input
        type="number"
        min="0.001"
        step="any"
        value={megabytes}
        onChange={updateMegabytes.bind(null, setMegabytes)}
        required
      />
      <input
        type="hidden"
        name={props.name}
        value={Math.round(Number(megabytes) * BYTES_PER_MEGABYTE)}
      />
    </label>
  );
}

function updateMegabytes(
  setMegabytes: React.Dispatch<React.SetStateAction<string>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  setMegabytes(event.currentTarget.value);
}

/**
 * The Gmail connection behind the mailbox: when its authorization ends, the
 * actions that repair it, and what the connection allows.
 */
function GmailConnectionSection(props: {
  readonly panel: GmailIntegrationPanelProps;
  readonly entry: GmailMailboxEntry;
  readonly commands: IntegrationAccountCommands | null;
  readonly busy: boolean;
}): React.ReactNode {
  const panel = props.panel;
  const account = props.entry.account;
  const mailbox = props.entry.kind === "mailbox" ? props.entry.mailbox : null;
  const notice =
    mailbox === null ? null : mailboxAuthorizationNotice(mailbox, Date.now());
  const record =
    account === null
      ? null
      : findCredentialAccountRecord(
          panel.credentialInventory,
          account.integrationAccountId,
        );
  const canRestartSync =
    mailbox !== null && mailbox.policy.kind === "enabled" && panel.canManage;
  return (
    <section className="mailbox-section" aria-label="Connection">
      <h4>Connection</h4>
      <div className="mailbox-section-body connection-card">
        {mailbox === null ? null : (
          <p className="notice-text">
            During the Gmail pilot, reconnect this mailbox every week.
          </p>
        )}
        {notice !== null && notice.tone === "info" ? (
          <p className="notice-text">
            <strong>{notice.headline}.</strong> {notice.detail}
          </p>
        ) : null}
        {account === null ? null : renderConnectionProblem(account)}
        {account === null ? null : renderConnectionRecency(account)}
        {props.commands === null && !canRestartSync ? null : (
          <div className="connection-actions">
            {props.commands?.primary}
            {props.commands?.cancel}
            {props.commands?.secondary}
            {mailbox !== null && canRestartSync ? (
              <button
                type="button"
                data-account-id={mailbox.integrationAccountId}
                onClick={panel.actions.reconnectMailbox}
                disabled={props.busy}
              >
                Restart mail sync
              </button>
            ) : null}
          </div>
        )}
        {canRestartSync ? (
          <p className="notice-text">
            Restart mail sync if new mail stops arriving. Seams Pantry starts
            again from now.
          </p>
        ) : null}
        {account === null ? null : renderIntegrationAccountDetails(account)}
        {/* A full mailbox has Remove access below, which does this and more. */}
        {account === null ||
        record === null ||
        mailbox !== null ||
        !panel.canManage ? null : (
          <CredentialRecoveryActions
            account={account}
            record={record}
            candidates={panel.accounts.filter(
              isCredentialReplacementCandidate.bind(
                null,
                account.integrationAccountId,
              ),
            )}
            busy={integrationAccountBusy(
              panel.mutations,
              panel.pendingAuthorization,
              account.integrationAccountId,
            )}
            rotate={panel.actions.rotateCredential}
            revoke={panel.actions.revokeCredential}
          />
        )}
      </div>
    </section>
  );
}

/**
 * The actions that cut a mailbox off. Each label names the mailbox. Disconnect
 * confirms on a second click like every connection; revoke is destructive and
 * therefore confirms in place, naming every consequence before it runs.
 */
function GmailDangerSection(props: {
  readonly address: string;
  readonly mailbox: AgentMailboxView | null;
  readonly commands: IntegrationAccountCommands | null;
  readonly busy: boolean;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const [confirmingRevoke, setConfirmingRevoke] = React.useState(false);
  const mailbox = props.mailbox;
  const disconnect = props.commands === null ? [] : props.commands.danger;
  if (mailbox === null && disconnect.length === 0) return null;
  return (
    <section className="mailbox-section mailbox-danger" aria-label="Remove">
      <h4>Remove</h4>
      <div className="mailbox-section-body">
        <p className="notice-text">
          {mailbox === null
            ? "Disconnect turns off this connection until you reconnect it."
            : "Disconnect turns off this connection until you reconnect it. Remove access takes away Seams Pantry's access to this mailbox."}
        </p>
        {mailbox !== null && confirmingRevoke ? (
          <div
            className="connection-actions"
            role="group"
            aria-label={`Confirm revoking ${props.address}`}
          >
            <div className="connection-confirm-copy">
              <p className="notice-text">
                <strong>Remove access to {props.address}?</strong>
              </p>
              <p className="notice-text">
                Seams Pantry stops reading new email, cancels emails waiting
                to send, tries to delete the drafts it made, and deletes its
                sign-in for this mailbox. A draft that Pantry cannot delete
                stays in Gmail and shows as Cleanup needed. A short record of
                past actions stays under your workspace retention rules.
              </p>
            </div>
            <button
              type="button"
              className="danger-button"
              data-account-id={mailbox.integrationAccountId}
              onClick={props.actions.revokeMailbox}
              disabled={props.busy}
            >
              Remove access to {props.address}
            </button>
            <button
              type="button"
              onClick={stopConfirmingMailboxRevoke.bind(
                null,
                setConfirmingRevoke,
              )}
              disabled={props.busy}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="connection-actions mailbox-danger-actions">
            {disconnect}
            {mailbox === null ? null : (
              <button
                type="button"
                className="danger-button"
                onClick={startConfirmingMailboxRevoke.bind(
                  null,
                  setConfirmingRevoke,
                )}
                disabled={props.busy}
              >
                Remove access to {props.address}…
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function startConfirmingMailboxRevoke(
  setConfirmingRevoke: (value: boolean) => void,
): void {
  setConfirmingRevoke(true);
}

function stopConfirmingMailboxRevoke(
  setConfirmingRevoke: (value: boolean) => void,
): void {
  setConfirmingRevoke(false);
}
