import { Select } from "../ui/select";
import React from "react";

import {
  EmptyState,
  Notice,
  ProviderTile,
  StatusChip,
  formatRelativeTime,
  type StatusChipStatus,
} from "../page-components";
import { ConsentPoint } from "../features/integrations/connect-consent-dialog";
import {
  LastAttemptNotice,
  ProviderConnectAction,
  providerAttemptFailureCopy,
  type ProviderAttemptDiagnostics,
  type ProviderAttemptFailureCopy,
  type ProviderConnectionState,
} from "../provider-onboarding";
import { WHATSAPP_DEFAULT_POLICY_DRAFT } from "../whatsapp";
import {
  type WhatsAppSurface,
  parseWhatsAppPolicyDraft,
  type WhatsAppAccountView,
  type WhatsAppPolicyDraft,
  type WhatsAppPolicyView,
  type WhatsAppRuntimeView,
} from "@seams/control-api/portal/whatsapp";
import type { WhatsAppProviderHealth } from "@seams/control-api";
/**
 * The WhatsApp setup: connect a number, assign an agent and publish the ingress
 * policy. Conversations and reply approvals are in the Inbox (Plan 83), so this
 * page holds no customer content.
 */

export type WhatsAppInstallationOption = {
  readonly installationId: string;
  readonly label: string;
};

export type WhatsAppPanelActions = {
  readonly connect: () => Promise<void>;
  /** Closes the Meta window Pantry is waiting on and returns to idle. */
  readonly cancelConnection: () => void;
  readonly select: (integrationAccountId: string) => Promise<void>;
  readonly bindAgent: (
    integrationAccountId: string,
    installationId: string,
  ) => Promise<void>;
  readonly publishPolicy: (
    integrationAccountId: string,
    draft: WhatsAppPolicyDraft,
  ) => Promise<void>;
  readonly disable: (integrationAccountId: string) => Promise<void>;
  readonly reconnect: (integrationAccountId: string) => Promise<void>;
  readonly revoke: (integrationAccountId: string) => Promise<void>;
  readonly resume: (integrationAccountId: string) => Promise<void>;
};

export type WhatsAppInferenceSelection =
  | { readonly kind: "claude_oauth" }
  | { readonly kind: "codex_subscription" }
  | { readonly kind: "satyr_platform" }
  | { readonly kind: "organisation_openai_api_key" }
  | { readonly kind: "organisation_anthropic_api_key" };

export type WhatsAppConnectionActionState = ProviderConnectionState;

export type WhatsAppPanelProps = {
  readonly surface: WhatsAppSurface | undefined;
  readonly installations: readonly WhatsAppInstallationOption[] | undefined;
  readonly inferenceSelection: WhatsAppInferenceSelection;
  readonly connectionAction: WhatsAppConnectionActionState;
  /** The last connection attempt that failed at Meta, until a later one succeeds. */
  readonly lastAttempt: ProviderAttemptDiagnostics | null;
  readonly canManage: boolean;
  readonly actions: WhatsAppPanelActions;
};

const EMPTY_SURFACE: WhatsAppSurface = {
  applicationConfigured: false,
  accounts: [],
  replies: [],
};

export function WhatsAppIntegrationPanel(
  props: WhatsAppPanelProps,
): React.ReactNode {
  const surface = props.surface ?? EMPTY_SURFACE;
  const installations = props.installations ?? [];
  const hasAccounts = surface.accounts.length > 0;
  const discovered = surface.accounts.filter(isDiscoveredNumber).length;
  const setup: WhatsAppConnectionSetupFacts = {
    applicationConfigured: surface.applicationConfigured,
    connectionAction: props.connectionAction,
    lastAttempt: props.lastAttempt,
    inferenceProvider: inferenceProviderLabel(props.inferenceSelection),
    actions: props.actions,
  };
  return (
    <>
      {surface.applicationConfigured ? null : (
        <Notice tone="warning" announcement="none">
          WhatsApp connections aren&rsquo;t available on this Seams Pantry
          deployment yet. That is a setup step on the Seams side, not something
          to fix in your account. Numbers already connected keep working.
        </Notice>
      )}
      {discovered > 0 && props.canManage ? (
        <Notice tone="success" announcement="polite">
          Meta shared {discovered === 1 ? "a number" : `${discovered} numbers`}{" "}
          with Seams Pantry. Choose which to use. Message handling stays off
          until you enable it.
        </Notice>
      ) : null}
      {!hasAccounts ? (
        props.canManage ? (
          <WhatsAppConnectionSetup kind="first_connection" {...setup} />
        ) : (
          <EmptyState
            title="No WhatsApp number is connected"
            detail="A workspace admin can connect an eligible WhatsApp Business Platform number."
          />
        )
      ) : (
        [...surface.accounts]
          .sort(compareDiscoveredFirst)
          .map(
            renderWhatsAppAccountCard.bind(
              null,
              installations,
              props.canManage,
              props.actions,
            ),
          )
      )}
      {!hasAccounts ? null : (
        <p className="notice-text">
          Customer conversations and the agent&rsquo;s replies are in the Inbox.
        </p>
      )}
      {props.canManage && hasAccounts ? (
        <WhatsAppConnectionSetup kind="additional_connection" {...setup} />
      ) : null}
    </>
  );
}

function isDiscoveredNumber(account: WhatsAppAccountView): boolean {
  return account.selectedAt === null;
}

/** Numbers still waiting to be chosen sort above configured ones, so the next action is on top. */
function compareDiscoveredFirst(
  left: WhatsAppAccountView,
  right: WhatsAppAccountView,
): number {
  return Number(isDiscoveredNumber(right)) - Number(isDiscoveredNumber(left));
}

function renderWhatsAppAccountCard(
  installations: readonly WhatsAppInstallationOption[],
  canManage: boolean,
  actions: WhatsAppPanelActions,
  account: WhatsAppAccountView,
): React.ReactNode {
  return (
    <WhatsAppAccountCard
      key={account.integrationAccountId}
      account={account}
      installations={installations}
      canManage={canManage}
      actions={actions}
    />
  );
}

type WhatsAppConnectionSetupFacts = {
  readonly applicationConfigured: boolean;
  readonly connectionAction: WhatsAppConnectionActionState;
  readonly lastAttempt: ProviderAttemptDiagnostics | null;
  readonly inferenceProvider: string;
  readonly actions: WhatsAppPanelActions;
};

type WhatsAppConnectionSetupProps = WhatsAppConnectionSetupFacts &
  (
    | { readonly kind: "first_connection" }
    | { readonly kind: "additional_connection" }
  );

/**
 * The connection sheet: what the person needs and what happens, one action, and
 * the data handling in small print under it.
 */
function WhatsAppConnectionSetup(
  props: WhatsAppConnectionSetupProps,
): React.ReactNode {
  const firstConnection = props.kind === "first_connection";
  const id = firstConnection
    ? "whatsapp-first-connection"
    : "whatsapp-additional-connection";
  return (
    <section
      className={
        firstConnection
          ? "provider-consent whatsapp-onboarding"
          : "provider-consent whatsapp-onboarding whatsapp-onboarding-compact"
      }
      aria-labelledby={`${id}-title`}
    >
      <h4 id={`${id}-title`} className="visually-hidden">
        {firstConnection ? "Connect WhatsApp" : "Add another number"}
      </h4>
      <ul className="connect-consent-points">
        <ConsentPoint
          title="Have your Meta login ready"
          detail="You need full control of your business in Meta."
        />
        <ConsentPoint
          title="Use a number that can get a code"
          detail="Meta sends a code to confirm the phone number."
        />
        <ConsentPoint
          title="Nothing happens until you turn it on"
          detail="After you connect, choose the number and an agent, then turn it on."
        />
      </ul>
      {firstConnection ? (
        <Notice tone="warning" announcement="none">
          Meta limits this to the test businesses of Seams for now. It opens to
          everyone after Meta approves Seams.
        </Notice>
      ) : null}
      <ProviderConnectAction
        id={id}
        service="Meta"
        label={firstConnection ? "Connect WhatsApp" : "Add number"}
        state={props.connectionAction}
        disabled={!props.applicationConfigured}
        connect={props.actions.connect}
        cancel={props.actions.cancelConnection}
        help={
          props.applicationConfigured
            ? "Opens Meta in a new window. Seams Pantry never sees your Facebook password."
            : "Connections open when Seams finishes its Meta setup. You do not need to do anything yet."
        }
        waitingHint="Finish in the Meta window: sign in, choose the business and phone number, and approve access. This page updates as soon as Meta responds."
      />
      {props.lastAttempt === null ? null : (
        <LastAttemptNotice
          attempt={props.lastAttempt}
          copy={whatsappAttemptFailureCopy(props.lastAttempt.reasonCode)}
        />
      )}
      <div className="connection-fine-print">
        <p>
          Meta gives access only to the business and number you approve. Seams
          keeps that access encrypted, and it never appears in the browser.
        </p>
        <WhatsAppProcessingDisclosure
          inferenceProvider={props.inferenceProvider}
        />
      </div>
    </section>
  );
}

/**
 * Meta's reasons, in the operator's words. The one that matters most is the
 * sign-in that ends without a Business Portfolio or WhatsApp Business
 * Account: the same outcome follows from skipping the asset step and from
 * Meta not yet allowing new businesses to onboard through Pantry, and the
 * callback cannot tell them apart, so the copy names both without blaming
 * the operator. A shared account with no usable number is its own case.
 */
export function whatsappAttemptFailureCopy(
  reasonCode: string,
): ProviderAttemptFailureCopy {
  switch (reasonCode) {
    case "provider_asset_missing":
      return {
        summary:
          "Meta finished the sign-in without sharing a Business Portfolio and WhatsApp Business Account that Seams Pantry can use.",
        nextStep:
          "Try again and choose a Business Portfolio, WhatsApp Business Account, and phone number before finishing. If Meta says Seams can't onboard customers right now, that is a pending approval on the Seams side, not a problem with your account; contact support and quote the reference below.",
      };
    case "provider_account_ineligible":
      return {
        summary:
          "The WhatsApp Business Account Meta shared has no phone number that Seams Pantry can use.",
        nextStep:
          "Add a phone number to that account in WhatsApp Manager, then try again.",
      };
    case "provider_scope_missing":
      return {
        summary:
          "Meta didn't grant every WhatsApp permission that Seams Pantry needs.",
        nextStep: "Try again and approve all the requested permissions.",
      };
    default:
      return providerAttemptFailureCopy("Meta", reasonCode);
  }
}

/**
 * The enablement disclosure. It describes the actual temporary processing
 * boundary rather than a marketing retention label, and it names the
 * inference provider the organisation selected.
 */
export function WhatsAppProcessingDisclosure(props: {
  readonly inferenceProvider: string;
}): React.ReactNode {
  return (
    <>
      <p>
        Seams Pantry receives new text messages after you turn on this number.
        It does not import earlier chats or browse your WhatsApp inbox. While a
        support Case is open, Seams stores its text messages for up to 24 hours
        after the customer's latest message. Seams deletes a proposed reply
        sooner when it is sent, rejected, replaced or expired. WhatsApp keeps
        messages under Meta's terms. Pantry can send replies only in the same
        24-hour window.
      </p>
      <p>
        Your AI account, <strong>{props.inferenceProvider}</strong>, processes
        these messages under your organisation's data terms. Every agent reply
        needs your approval before Pantry sends it.
      </p>
    </>
  );
}

function WhatsAppAccountCard(props: {
  readonly account: WhatsAppAccountView;
  readonly installations: readonly WhatsAppInstallationOption[];
  readonly canManage: boolean;
  readonly actions: WhatsAppPanelActions;
}): React.ReactNode {
  const account = props.account;
  const paused = account.runtime?.processing.kind === "paused";
  return (
    <article className="connection-card">
      <ProviderTile provider="whatsapp" label="WhatsApp" />
      <div className="connection-body">
        <div className="connection-head">
          <div>
            <h4>
              {account.verifiedName.length === 0
                ? "WhatsApp number"
                : account.verifiedName}
            </h4>
            <p>
              <bdi>{account.displayPhoneNumber}</bdi>
            </p>
          </div>
          <StatusChip status={providerHealthStatus(account.providerHealth)} />
        </div>
        {account.selectedAt === null ? (
          <p className="notice-text">
            Meta shared this number with Seams Pantry. Select it to continue
            setup. Pantry does not route messages here until you enable message
            handling.
          </p>
        ) : (
          <p className="notice-text">{policySummary(account.policy)}</p>
        )}
        {account.runtime === null ? null : (
          <p className="notice-text">{runtimeSummary(account.runtime)}</p>
        )}
        {props.canManage && account.selectedAt === null ? (
          <div className="connection-actions">
            <button
              type="button"
              className="connection-primary-action"
              onClick={runAction.bind(
                null,
                props.actions.select.bind(null, account.integrationAccountId),
              )}
            >
              Use this number
            </button>
            <button
              type="button"
              onClick={confirmRevoke.bind(null, props.actions, account)}
            >
              Discard
            </button>
          </div>
        ) : null}
        {props.canManage && account.selectedAt !== null ? (
          <>
            <WhatsAppAgentAssignment
              account={account}
              installations={props.installations}
              actions={props.actions}
            />
            <WhatsAppPolicyForm account={account} actions={props.actions} />
            <div className="connection-actions">
              {paused ? (
                <button
                  type="button"
                  onClick={runAction.bind(
                    null,
                    props.actions.resume.bind(
                      null,
                      account.integrationAccountId,
                    ),
                  )}
                >
                  Resume processing
                </button>
              ) : null}
              <button
                type="button"
                onClick={runAction.bind(
                  null,
                  props.actions.disable.bind(
                    null,
                    account.integrationAccountId,
                  ),
                )}
              >
                Disable processing
              </button>
              <button
                type="button"
                onClick={runAction.bind(
                  null,
                  props.actions.reconnect.bind(
                    null,
                    account.integrationAccountId,
                  ),
                )}
              >
                Reconnect
              </button>
              <button
                type="button"
                onClick={confirmRevoke.bind(null, props.actions, account)}
              >
                Revoke access
              </button>
            </div>
            <p className="notice-text">
              Revoking removes Seams Pantry's access to this WhatsApp Business
              Account in Meta and revokes every phone number connected through
              it. Open Cases are closed and their stored text is deleted.
              Reconnecting afterwards needs a fresh Embedded Signup.
            </p>
          </>
        ) : null}
      </div>
    </article>
  );
}

function WhatsAppAgentAssignment(props: {
  readonly account: WhatsAppAccountView;
  readonly installations: readonly WhatsAppInstallationOption[];
  readonly actions: WhatsAppPanelActions;
}): React.ReactNode {
  const selectId = `whatsapp-agent-${props.account.integrationAccountId}`;
  const agents = [
    { value: "", label: "Choose an agent" },
    ...props.installations.map((installation) => ({
      value: installation.installationId,
      label: installation.label,
    })),
  ];
  return (
    <form
      className="integration-form whatsapp-setup-form"
      onSubmit={submitAgentAssignment.bind(null, props)}
    >
      <h5>Assign an agent</h5>
      <label htmlFor={selectId}>Agent</label>
      <Select.Root
        name="installationId"
        items={agents}
        defaultValue={props.account.binding?.installationId ?? ""}
        disabled={props.installations.length === 0}
      >
        <Select.Trigger id={selectId}>
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>
          {agents.map((agent) => (
            <Select.Item key={agent.value} value={agent.value}>
              {agent.label}
            </Select.Item>
          ))}
        </Select.Popup>
      </Select.Root>
      <button type="submit" disabled={props.installations.length === 0}>
        {props.account.binding === null ? "Assign agent" : "Change agent"}
      </button>
      {props.installations.length === 0 ? (
        <p className="notice-text">
          Add an agent to this workspace before continuing.
        </p>
      ) : null}
    </form>
  );
}

function WhatsAppPolicyForm(props: {
  readonly account: WhatsAppAccountView;
  readonly actions: WhatsAppPanelActions;
}): React.ReactNode {
  const policy = props.account.policy;
  const defaults: WhatsAppPolicyDraft =
    policy.kind === "enabled"
      ? {
          maxActiveCases: policy.maxActiveCases,
          maxMessagesPerHour: policy.maxMessagesPerHour,
          dailyAgentTokenBudget: policy.dailyAgentTokenBudget,
          maxMessageBytes: policy.maxMessageBytes,
          maxActiveCaseMessages: policy.maxActiveCaseMessages,
          maxActiveCaseBytes: policy.maxActiveCaseBytes,
          debounceSeconds: policy.debounceSeconds,
          relevantMessageTopics: policy.relevantMessageTopics,
          automaticAcknowledgementText: policy.automaticAcknowledgementText,
        }
      : WHATSAPP_DEFAULT_POLICY_DRAFT;
  const prefix = `whatsapp-policy-${props.account.integrationAccountId}`;
  const bindingHelpId = `${prefix}-binding-help`;
  return (
    <form
      className="integration-form whatsapp-setup-form"
      onSubmit={submitPolicy.bind(null, props)}
    >
      <h5>
        {policy.kind === "enabled"
          ? "Message handling"
          : "Enable message handling"}
      </h5>
      {policyField(
        `${prefix}-cases`,
        "maxActiveCases",
        "Maximum open Cases",
        defaults.maxActiveCases,
      )}
      {policyField(
        `${prefix}-hour`,
        "maxMessagesPerHour",
        "Messages admitted per hour",
        defaults.maxMessagesPerHour,
      )}
      {policyField(
        `${prefix}-tokens`,
        "dailyAgentTokenBudget",
        "Daily agent token budget",
        defaults.dailyAgentTokenBudget,
      )}
      {policyField(
        `${prefix}-bytes`,
        "maxMessageBytes",
        "Maximum message bytes",
        defaults.maxMessageBytes,
      )}
      {policyField(
        `${prefix}-count`,
        "maxActiveCaseMessages",
        "Messages kept per open Case",
        defaults.maxActiveCaseMessages,
      )}
      {policyField(
        `${prefix}-casebytes`,
        "maxActiveCaseBytes",
        "Bytes kept per open Case",
        defaults.maxActiveCaseBytes,
      )}
      {policyField(
        `${prefix}-debounce`,
        "debounceSeconds",
        "Burst debounce seconds (10–30)",
        defaults.debounceSeconds,
      )}
      <label htmlFor={`${prefix}-relevant-topics`}>
        Relevant customer topics
      </label>
      <textarea
        id={`${prefix}-relevant-topics`}
        name="relevantMessageTopics"
        rows={4}
        maxLength={2_000}
        defaultValue={defaults.relevantMessageTopics}
        aria-describedby={`${prefix}-relevant-topics-help`}
      />
      <p id={`${prefix}-relevant-topics-help`} className="notice-text">
        Separate words or phrases with commas. Matching messages are handled
        immediately by the assigned agent.
      </p>
      <label htmlFor={`${prefix}-acknowledgement`}>
        Automatic acknowledgement
      </label>
      <textarea
        id={`${prefix}-acknowledgement`}
        name="automaticAcknowledgementText"
        rows={3}
        maxLength={1_000}
        defaultValue={defaults.automaticAcknowledgementText}
        aria-describedby={`${prefix}-acknowledgement-help`}
      />
      <p id={`${prefix}-acknowledgement-help`} className="notice-text">
        Sent when a customer message does not match an agent Cue.
      </p>
      <button
        type="submit"
        className="connection-primary-action"
        disabled={props.account.binding === null}
        aria-describedby={
          props.account.binding === null ? bindingHelpId : undefined
        }
      >
        {policy.kind === "enabled" ? "Save policy" : "Enable WhatsApp support"}
      </button>
      {props.account.binding === null ? (
        <p id={bindingHelpId} className="notice-text">
          Assign an agent before enabling message handling.
        </p>
      ) : null}
    </form>
  );
}

function policyField(
  id: string,
  name: string,
  label: string,
  value: number,
): React.ReactNode {
  return (
    <React.Fragment key={name}>
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} type="number" min={1} defaultValue={value} />
    </React.Fragment>
  );
}

function submitAgentAssignment(
  props: {
    readonly account: WhatsAppAccountView;
    readonly actions: WhatsAppPanelActions;
  },
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const installationId = formData.get("installationId");
  if (typeof installationId !== "string" || installationId.length === 0) return;
  void props.actions.bindAgent(
    props.account.integrationAccountId,
    installationId,
  );
}

function submitPolicy(
  props: {
    readonly account: WhatsAppAccountView;
    readonly actions: WhatsAppPanelActions;
  },
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const draft = parseWhatsAppPolicyDraft(new FormData(event.currentTarget));
  if (draft === null) return;
  void props.actions.publishPolicy(props.account.integrationAccountId, draft);
}

/**
 * Revocation is not reversible from here: it removes Pantry's Meta access for
 * the whole business account, so it asks before it acts.
 */
function confirmRevoke(
  actions: WhatsAppPanelActions,
  account: WhatsAppAccountView,
): void {
  const confirmed = globalThis.confirm(
    `Revoke Seams Pantry's access to WhatsApp Business Account ${account.wabaId}? Every phone number connected through it stops working and open Cases are deleted.`,
  );
  if (!confirmed) return;
  void actions.revoke(account.integrationAccountId);
}

function runAction(action: () => Promise<void>): void {
  void action();
}

function providerHealthStatus(
  health: WhatsAppProviderHealth,
): StatusChipStatus {
  switch (health.kind) {
    case "healthy":
      return { kind: "success", label: "Webhook live" };
    case "pending":
      return { kind: "info", label: "Verifying" };
    case "degraded":
      return { kind: "warning", label: "Needs attention" };
    case "unsubscribed":
      return { kind: "warning", label: "Not subscribed" };
    case "revoked":
      return { kind: "neutral", label: "Revoked" };
  }
}

function policySummary(policy: WhatsAppPolicyView): string {
  switch (policy.kind) {
    case "disabled_by_default":
      return "Processing is disabled. Publish an ingress policy to start receiving messages.";
    case "disabled_by_operator":
      return `Processing is disabled by policy revision ${policy.policyVersion}.`;
    case "enabled":
      return `Processing enabled by revision ${policy.policyVersion}: up to ${policy.maxActiveCases} open Cases, ${policy.maxMessagesPerHour} messages an hour, ${policy.debounceSeconds}s burst debounce.`;
  }
}

function runtimeSummary(runtime: WhatsAppRuntimeView): string {
  const processing =
    runtime.processing.kind === "paused"
      ? `Paused (${runtime.processing.reasonKind})`
      : runtime.processing.kind === "processing"
        ? "Running an agent turn"
        : runtime.processing.kind === "scheduled"
          ? `Next turn ${formatRelativeTime(runtime.processing.at)}`
          : "Waiting for messages";
  return `${processing} · ${runtime.activeCases} open Cases · ${runtime.admittedLastHour} messages in the last hour · ${runtime.tokensConsumed} agent tokens used today.`;
}

/**
 * The disclosure names the provider that will process admitted messages, so
 * the operator enabling a number sees where customer text actually goes.
 */
function inferenceProviderLabel(selection: WhatsAppInferenceSelection): string {
  switch (selection.kind) {
    case "claude_oauth":
      return "Claude OAuth (Pi)";
    case "codex_subscription":
      return "OpenAI Codex (your ChatGPT subscription)";
    case "organisation_openai_api_key":
      return "OpenAI (your API key)";
    case "organisation_anthropic_api_key":
      return "Anthropic Claude (your API key)";
    case "satyr_platform":
      return "Seams AI";
  }
}
