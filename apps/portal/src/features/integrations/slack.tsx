import { SLACK_APP_NAME } from "@purin-labs/control-api";
import { Select } from "../../ui/select";
import type {
  FirstOperationalTask,
  OnboardingActivation,
} from "@purin-labs/contracts";
import React from "react";
import { Link } from "react-router";
import {
  Combobox,
  type ComboboxOption,
} from "../../combobox";
import { workspacePagePath } from "../../route";
import { MutationLedger } from "../../mutation-state";
import { ProviderConnectAction } from "../../provider-onboarding";
import { formatLifecycle } from "../../formatting";
import { assertNever } from "@purin-labs/std";
import {
  mutationBlocked,
  providerConnectionBusy,
  providerConnectionState,
  renderMutationFeedback,
  renderSetupFeedback,
  renderSetupFieldError,
  setupFieldHasError,
  setupFormHasError,
} from "./settings-support";
import type { IntegrationAccount, OrganisationInferenceSelection, ProviderResource, SlackRoutingConnection } from "@purin-labs/control-api/portal/settings";
import type { IntegrationsPageActions, IntegrationsPageProps, SettingsMutationFeedback, SetupFeedback, SetupFormDefaults, SlackWorkspaceCatalog } from "./settings-types";

export function inferenceRouteName(selection: OrganisationInferenceSelection): string {
  switch (selection.kind) {
    case "claude_oauth":
      return "your Claude account";
    case "codex_subscription":
      return "your ChatGPT subscription";
    case "satyr_platform":
      return "Seams AI";
    case "organisation_openai_api_key":
      return "your OpenAI API key";
    case "organisation_anthropic_api_key":
      return "your Anthropic API key";
    default:
      return assertNever(selection, "Unexpected settings state");
  }
}

/**
 * When Slack connects while this panel shows, the Connect button that had
 * the focus is gone. The focus moves to the channel step that replaced it.
 */
function focusChannelStepOnConnect(
  heading: React.RefObject<HTMLHeadingElement | null>,
  wasConnected: React.RefObject<boolean>,
  connected: boolean,
): void {
  if (connected && !wasConnected.current)
    heading.current?.focus({ preventScroll: true });
  wasConnected.current = connected;
}

export function SlackSetup(props: {
  readonly defaults: SetupFormDefaults;
  readonly accounts: readonly IntegrationAccount[];
  /** A Slack window is open; the connect action already says what is next. */
  readonly connecting: boolean;
  readonly destinations: readonly SlackWorkspaceCatalog[];
  readonly routing: readonly SlackRoutingConnection[];
  readonly organisationName: string;
  readonly setupFeedback: SetupFeedback;
  readonly organisationIsActive: boolean;
  readonly canManage: boolean;
  readonly mutations: MutationLedger;
  readonly actions: IntegrationsPageActions;
  readonly mutationFeedback: SettingsMutationFeedback;
}): React.ReactNode {
  const [workspaceId, setWorkspaceId] = React.useState(
    props.defaults.workspaceId,
  );
  const connected = props.accounts.length > 0;
  const heading = React.useRef<HTMLHeadingElement>(null);
  const wasConnected = React.useRef(connected);
  React.useEffect(
    focusChannelStepOnConnect.bind(null, heading, wasConnected, connected),
    [connected],
  );
  if (!connected) {
    // No workspace to configure yet, but a failed save still has to report
    // itself: dropping the feedback here would swallow the error entirely.
    return (
      <>
        {props.connecting ? null : (
          <p className="notice-text">
            Connect Slack first, then choose the channel Seams Pantry should post to.
          </p>
        )}
        {renderSetupFeedback(props.setupFeedback)}
        {renderMutationFeedback(props.mutationFeedback, { kind: "readiness" })}
        {renderMutationFeedback(props.mutationFeedback, { kind: "activation" })}
      </>
    );
  }
  const selectedAccount =
    props.accounts.find(accountMatchesWorkspace.bind(null, workspaceId)) ??
    props.accounts.find(
      accountMatchesWorkspace.bind(null, props.defaults.workspaceId),
    ) ??
    props.accounts[0] ??
    null;
  const selectedWorkspaceId = selectedAccount?.providerAccountId ?? "";
  const channels =
    props.destinations.find(
      catalogMatchesWorkspace.bind(null, selectedWorkspaceId),
    )?.channels ?? [];
  return (
    <div className="slack-setup">
      <div className="slack-setup-heading">
        <h4 ref={heading} tabIndex={-1}>
          Channels
        </h4>
      </div>
      <SlackChannelList
        connections={props.routing}
        accounts={props.accounts}
        destinations={props.destinations}
        organisationName={props.organisationName}
      />
      {props.canManage ? (
        <form
          key={props.defaults.key}
          className="slack-add-channel"
          onSubmit={props.actions.saveSetup}
        >
          <input
            type="hidden"
            name="capabilityProfile"
            value={props.defaults.capabilityProfile}
          />
          <input
            type="hidden"
            name="cuePresetId"
            value={props.defaults.cuePresetId}
          />
          {/* With one workspace there is nothing to choose. */}
          {props.accounts.length === 1 ? (
            <input
              type="hidden"
              name="workspaceId"
              value={selectedWorkspaceId}
            />
          ) : (
            <label className="slack-add-field">
              <span>Slack workspace</span>
              <Select.Root
                name="workspaceId"
                items={slackWorkspaceItems(props.accounts)}
                value={selectedWorkspaceId}
                onValueChange={updateSlackWorkspace.bind(null, setWorkspaceId)}
              >
                <Select.Trigger
                  aria-invalid={setupFieldHasError(
                    props.setupFeedback,
                    "workspace",
                  )}
                  aria-describedby={
                    setupFieldHasError(props.setupFeedback, "workspace")
                      ? "setup-workspace-error"
                      : undefined
                  }
                >
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {renderSlackWorkspaceOptions(props.accounts)}
                </Select.Popup>
              </Select.Root>
              {renderSetupFieldError(
                props.setupFeedback,
                "workspace",
                "setup-workspace-error",
              )}
            </label>
          )}
          <label className="slack-add-label" htmlFor="setup-channel">
            Add a channel
          </label>
          <div className="slack-add-row">
            <Combobox
              key={selectedWorkspaceId}
              id="setup-channel"
              name="channelId"
              options={destinationOptions(channels)}
              defaultValue={
                selectedWorkspaceId === props.defaults.workspaceId
                  ? props.defaults.channelId
                  : ""
              }
              placeholder="Search channels…"
              emptyLabel={
                channels.length === 0
                  ? `No channels yet. Invite the ${SLACK_APP_NAME} app to a channel in Slack, then refresh the list.`
                  : "No channel matches this search."
              }
              invalid={
                setupFieldHasError(props.setupFeedback, "channel") === true
              }
              describedBy={
                setupFieldHasError(props.setupFeedback, "channel")
                  ? "setup-channel-error"
                  : "slack-add-hint"
              }
              disabled={false}
              onSelect={null}
            />
            <button
              type="submit"
              className="connection-primary-action slack-add-submit"
              aria-describedby={
                setupFormHasError(props.setupFeedback)
                  ? "setup-form-error"
                  : undefined
              }
              disabled={
                props.accounts.length === 0 ||
                mutationBlocked(props.mutations, { kind: "setup" })
              }
            >
              Add
            </button>
          </div>
          {renderSetupFieldError(
            props.setupFeedback,
            "channel",
            "setup-channel-error",
          )}
          <p id="slack-add-hint" className="slack-add-hint">
            <span>Not in the list? Invite the {SLACK_APP_NAME} app to the channel in Slack.</span>
            <button
              type="button"
              className="slack-text-action"
              data-account-id={selectedAccount?.integrationAccountId}
              onClick={props.actions.refreshAccountResources}
              disabled={
                selectedAccount === null ||
                mutationBlocked(props.mutations, {
                  kind: "integration_account",
                  integrationAccountId:
                    selectedAccount?.integrationAccountId ?? "",
                })
              }
            >
              Refresh list
            </button>
          </p>
        </form>
      ) : (
        <p className="slack-add-hint">
          An owner or admin can add a Slack channel.
        </p>
      )}
      <SlackDirectMessages
        connections={props.routing}
        accounts={props.accounts}
        organisationName={props.organisationName}
        mutations={props.mutations}
        actions={props.actions}
      />
      {renderSetupFeedback(props.setupFeedback)}
      {renderMutationFeedback(props.mutationFeedback, { kind: "readiness" })}
      {renderMutationFeedback(props.mutationFeedback, { kind: "activation" })}
    </div>
  );
}

/** The channels CafeOS posts in, one row each, or a quiet empty line. */
function SlackChannelList(props: {
  readonly connections: readonly SlackRoutingConnection[];
  readonly accounts: readonly IntegrationAccount[];
  readonly destinations: readonly SlackWorkspaceCatalog[];
  readonly organisationName: string;
}): React.ReactNode {
  const defaults = props.connections.flatMap(slackRoutingDefaults);
  if (defaults.length === 0)
    return (
      <p className="slack-channel-empty">
        No channel yet. Add one below.
      </p>
    );
  return (
    <section
      className="slack-channel-section"
      aria-label="Channels in use"
    >
      <ul className="slack-channel-list">
        {defaults.map(
          renderSlackRoutingDefault.bind(
            null,
            props.accounts,
            props.destinations,
          ),
        )}
      </ul>
      <p className="slack-channel-note">
        New threads in these channels go to {props.organisationName}.
      </p>
    </section>
  );
}

/* A Slack workspace that serves one organisation sends every DM there, so
   only a shared workspace asks each person where their DMs start. */

function SlackDirectMessages(props: {
  readonly connections: readonly SlackRoutingConnection[];
  readonly accounts: readonly IntegrationAccount[];
  readonly organisationName: string;
  readonly mutations: MutationLedger;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const shared = props.connections.filter(isSharedActiveSlackConnection);
  if (shared.length === 0) return null;
  return (
    <section className="slack-dm-section" aria-labelledby="slack-dm-title">
      <h3 id="slack-dm-title">Your Slack DMs</h3>
      <p className="slack-channel-note">
        Another organisation uses this Slack workspace too. Choose{" "}
        {props.organisationName} to start your new DMs with the agent here.
        Open DM threads keep their organisation.
      </p>
      <div className="slack-dm-actions">
        {shared.map(
          renderSlackDmSelection.bind(
            null,
            props.accounts,
            props.organisationName,
            shared.length > 1,
            props.mutations,
            props.actions,
          ),
        )}
      </div>
    </section>
  );
}

function isSharedActiveSlackConnection(
  connection: SlackRoutingConnection,
): boolean {
  return connection.sharedWorkspace && connection.lifecycle === "active";
}

function renderSlackDmSelection(
  accounts: readonly IntegrationAccount[],
  organisationName: string,
  nameWorkspace: boolean,
  mutations: MutationLedger,
  actions: IntegrationsPageActions,
  connection: SlackRoutingConnection,
): React.ReactNode {
  const account = accounts.find(
    accountMatchesIntegrationId.bind(null, connection.integrationAccountId),
  );
  return (
    <button
      key={connection.installationId}
      type="button"
      data-installation-id={connection.installationId}
      data-account-id={connection.integrationAccountId}
      onClick={actions.selectSlackDmOrganisation}
      disabled={mutationBlocked(mutations, {
        kind: "integration_account",
        integrationAccountId: connection.integrationAccountId,
      })}
    >
      Start my DMs in {organisationName}
      {nameWorkspace
        ? ` (${account?.displayName ?? connection.workspaceId})`
        : ""}
    </button>
  );
}

type SlackRoutingDefaultView = {
  readonly key: string;
  readonly integrationAccountId: string;
  readonly workspaceId: string;
  readonly channelId: string;
};

function slackRoutingDefaults(
  connection: SlackRoutingConnection,
): readonly SlackRoutingDefaultView[] {
  return connection.channelDefaults.map(
    buildSlackRoutingDefault.bind(null, connection),
  );
}

function buildSlackRoutingDefault(
  connection: SlackRoutingConnection,
  channelDefault: SlackRoutingConnection["channelDefaults"][number],
): SlackRoutingDefaultView {
  return {
    key: `${connection.installationId}:${channelDefault.channelId}`,
    integrationAccountId: connection.integrationAccountId,
    workspaceId: connection.workspaceId,
    channelId: channelDefault.channelId,
  };
}

/** A channel by its Slack name; the workspace shows only when there are several. */
function renderSlackRoutingDefault(
  accounts: readonly IntegrationAccount[],
  destinations: readonly SlackWorkspaceCatalog[],
  route: SlackRoutingDefaultView,
): React.ReactNode {
  const account = accounts.find(
    accountMatchesIntegrationId.bind(null, route.integrationAccountId),
  );
  const channel = destinations
    .find(catalogMatchesWorkspace.bind(null, route.workspaceId))
    ?.channels.find(resourceHasId.bind(null, route.channelId));
  const name = (channel?.displayLabel ?? route.channelId).replace(/^#/u, "");
  return (
    <li key={route.key} className="slack-channel-row">
      <span className="slack-channel-mark" aria-hidden="true">
        #
      </span>
      <span className="slack-channel-name">
        <strong>{name}</strong>
        {accounts.length > 1 ? (
          <span>{account?.displayName ?? route.workspaceId}</span>
        ) : null}
      </span>
      <span className="slack-channel-status">
        <span className="slack-channel-dot" aria-hidden="true" />
        Posting
      </span>
    </li>
  );
}

function resourceHasId(
  canonicalResourceId: string,
  resource: ProviderResource,
): boolean {
  return resource.canonicalResourceId === canonicalResourceId;
}

function accountMatchesIntegrationId(
  integrationAccountId: string,
  account: IntegrationAccount,
): boolean {
  return account.integrationAccountId === integrationAccountId;
}

function updateSlackWorkspace(
  setWorkspaceId: React.Dispatch<React.SetStateAction<string>>,
  workspaceId: string | null,
): void {
  if (workspaceId !== null) setWorkspaceId(workspaceId);
}

export function accountMatchesWorkspace(
  workspaceId: string,
  account: IntegrationAccount,
): boolean {
  return account.providerAccountId === workspaceId;
}

function catalogMatchesWorkspace(
  workspaceId: string,
  catalog: SlackWorkspaceCatalog,
): boolean {
  return catalog.workspaceId === workspaceId;
}

/**
 * The first Slack connection. While the Slack window is open the button
 * waits and a Cancel shows; when Slack approves, the channel step takes its
 * place in the same dialog.
 */
export function renderSlackFirstConnection(
  props: IntegrationsPageProps,
): React.ReactNode {
  if (!props.canManage) return null;
  return (
    <ProviderConnectAction
      id="slack-connect"
      service="Slack"
      label="Connect Slack"
      state={providerConnectionState(
        props.mutations,
        props.pendingAuthorization,
        props.feedback,
        "slack",
      )}
      disabled={false}
      connect={props.actions.connectSlack}
      cancel={props.actions.cancelProviderAuthorization}
      help={null}
      waitingHint="Finish in the Slack window. The channel step opens here when Slack approves."
    />
  );
}

export function renderSlackConnectAction(
  props: IntegrationsPageProps,
): React.ReactNode {
  if (!props.canManage) return null;
  const hasSlack = props.accounts.some(
    (account) => account.provider === "slack",
  );
  const label = hasSlack ? "Connect another Slack workspace" : "Connect Slack";
  const popupLabel = hasSlack
    ? "Connect another Slack workspace in a popup"
    : "Connect Slack in a popup";
  return (
    <div className="connection-actions">
      <button
        type="button"
        className={hasSlack ? undefined : "connection-primary-action"}
        aria-label={popupLabel}
        onClick={props.actions.connectSlack}
        disabled={providerConnectionBusy(
          props.mutations,
          props.pendingAuthorization,
          "slack",
        )}
      >
        {label}
      </button>
      {renderMutationFeedback(props.feedback, {
        kind: "connect_provider",
        provider: "slack",
      })}
    </div>
  );
}

function SlackSetupActivationLabel(activation: OnboardingActivation): string {
  switch (activation.kind) {
    case "running":
      return `Activation in progress: ${formatLifecycle(activation.phase)}…`;
    case "failed_retryable":
      return `Activation needs attention: ${formatLifecycle(activation.reason_code)}.`;
    case "failed_terminal":
      return `Activation stopped: ${formatLifecycle(activation.reason_code)}.`;
    default:
      return "";
  }
}

export function renderActivationProjection(
  activation: OnboardingActivation,
  firstTask: FirstOperationalTask | null,
  supportReference: string | null,
  organisationHandle: string,
  workspaceHandle: string,
): React.ReactNode {
  switch (activation.kind) {
    case "idle":
      return null;
    case "running":
      return (
        <p className="readiness-evaluating" role="status">
          {SlackSetupActivationLabel(activation)}
        </p>
      );
    case "failed_retryable":
    case "failed_terminal":
      return (
        <p className="error-text" role="alert">
          {SlackSetupActivationLabel(activation)}
          {supportReference === null ? null : (
            <>
              {" "}
              Support reference: <code>{supportReference}</code>.
            </>
          )}
        </p>
      );
    case "succeeded":
      return firstTask === null ? null : (
        <section className="first-task" aria-labelledby="first-task-title">
          <h3 id="first-task-title">Your first operational task</h3>
          <p role="status">Review recent activity from your commerce system.</p>
          <Link
            className="task-link"
            to={workspacePagePath(
              organisationHandle,
              workspaceHandle,
              "orders",
            )}
          >
            Open task
          </Link>
        </section>
      );
    default:
      return assertNever(activation, "Unexpected settings state");
  }
}

export function renderApprovalAuthenticationReports(
  reports: readonly {
    readonly branch: string;
    readonly ready: boolean;
    readonly reason: string | null;
  }[],
): React.ReactNode {
  const unready = reports.filter((report) => !report.ready);
  if (unready.length === 0) return null;
  return (
    <div className="blocker-list" role="status">
      <strong>Approval sign-in method</strong>
      <ul>
        {unready.map((report) => (
          <li key={`${report.branch}:${report.reason ?? "unready"}`}>
            {approvalAuthenticationMessage(report.branch, report.reason)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function approvalAuthenticationMessage(
  branch: string,
  reason: string | null,
): string {
  if (branch === "seams_nep413") {
    return "Your approval policy asks for a Seams wallet on high-value changes, but no approver wallet is linked yet. Those approvals stay unavailable until a wallet is linked; everything else keeps working.";
  }
  if (branch === "webauthn_step_up") {
    return "Your approval policy asks for a passkey on high-value changes, but no passkey is registered yet. Those approvals stay unavailable until a passkey is added; everything else keeps working.";
  }
  return "A selected approval sign-in method is not ready yet.";
}

function slackWorkspaceItems(
  accounts: readonly IntegrationAccount[],
): readonly { value: string; label: string }[] {
  if (accounts.length === 0)
    return [{ value: "", label: "Connect Slack first" }];
  return accounts.map((account) => ({
    value: account.providerAccountId,
    label: account.displayName,
  }));
}

function renderSlackWorkspaceOptions(
  accounts: readonly IntegrationAccount[],
): React.ReactNode {
  if (accounts.length === 0)
    return <Select.Item value="">Connect Slack first</Select.Item>;
  return accounts.map(renderSlackWorkspaceOption);
}

function renderSlackWorkspaceOption(
  account: IntegrationAccount,
): React.ReactNode {
  return (
    <Select.Item
      key={account.integrationAccountId}
      value={account.providerAccountId}
    >
      {account.displayName}
    </Select.Item>
  );
}

function destinationOptions(
  destinations: readonly ProviderResource[],
): readonly ComboboxOption[] {
  return destinations.map(destinationOption);
}

function destinationOption(destination: ProviderResource): ComboboxOption {
  return {
    value: destination.canonicalResourceId,
    label: destination.displayLabel,
    detail: null,
    unavailable: destination.accessState !== "accessible",
  };
}
