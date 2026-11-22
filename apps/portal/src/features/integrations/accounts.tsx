import { Select } from "../../ui/select";
import React from "react";
import { credentialRotationSupported, findCredentialAccountRecord } from "../../credential-inventory";
import type { CredentialAccountRecord, CredentialInventory, CredentialRotationReceipt, CredentialRevocationReceipt } from "@purin-labs/control-api/portal/credential-inventory";
import { StatusChip } from "../../page-components";
import { MutationLedger } from "@purin-labs/control/portal/mutation-state";
import {
  providerDisconnectedConsequence,
  providerLabel,
} from "../../integration-catalogue";
import { assertNever } from "@purin-labs/std";
import { authorizationServiceName } from "./provider-authorization";
import {
  awaitingAccountAuthorization,
  formatSelectedResource,
  integrationAccountBusy,
  integrationLifecycleStatus,
  isFullMailboxGmailAccount,
  reconnectableProvider,
  renderConnectionRecency,
  renderMutationFeedback,
} from "./settings-support";
import type { CredentialActionOutcome, IntegrationsPageActions, PendingProviderAuthorization, SettingsMutationFeedback } from "./settings-types";
import type { IntegrationAccount } from "@purin-labs/control-api/portal/settings";
import { ConfirmButton } from "./workspace";

type IntegrationAccountControls = {
  readonly mutations: MutationLedger;
  readonly pendingAuthorization: PendingProviderAuthorization | null;
  readonly pendingConfirm: string | null;
  readonly requestConfirm: (key: string) => void;
  readonly feedback: SettingsMutationFeedback;
};

export function renderIntegrationAccounts(
  accounts: readonly IntegrationAccount[],
  credentialInventory: CredentialInventory | null,
  actions: IntegrationsPageActions,
  mutations: MutationLedger,
  pendingAuthorization: PendingProviderAuthorization | null,
  pendingConfirm: string | null,
  requestConfirm: (key: string) => void,
  canManage: boolean,
  feedback: SettingsMutationFeedback,
): React.ReactNode {
  // Anything the operator has to act on sorts above the connections that are
  // simply working, so a broken provider is never buried under healthy ones.
  const ordered = [...accounts].sort(compareIntegrationAccountUrgency);
  if (!canManage) return ordered.map(renderReadonlyIntegrationAccountRow);
  const controls: IntegrationAccountControls = {
    mutations,
    pendingAuthorization,
    pendingConfirm,
    requestConfirm,
    feedback,
  };
  return ordered.map(
    renderIntegrationAccountRow.bind(
      null,
      actions,
      controls,
      credentialInventory,
      ordered,
    ),
  );
}

export function compareIntegrationAccountUrgency(
  left: IntegrationAccount,
  right: IntegrationAccount,
): number {
  const byUrgency =
    integrationAccountUrgency(left) - integrationAccountUrgency(right);
  if (byUrgency !== 0) return byUrgency;
  const byProvider = providerLabel(left.provider).localeCompare(
    providerLabel(right.provider),
  );
  if (byProvider !== 0) return byProvider;
  const byName = left.displayName.localeCompare(right.displayName);
  return byName === 0
    ? left.integrationAccountId.localeCompare(right.integrationAccountId)
    : byName;
}

function integrationAccountUrgency(account: IntegrationAccount): number {
  switch (account.lifecycle.kind) {
    case "revoked":
      return 0;
    case "reauth_required":
      return 1;
    case "degraded":
      return 2;
    case "connecting":
    case "pending_activation":
      return 3;
    case "disabled":
      return 4;
    case "active":
      return 5;
    default:
      return assertNever(account.lifecycle, "Unexpected settings state");
  }
}

function renderReadonlyIntegrationAccountRow(
  account: IntegrationAccount,
  _index: number,
  accounts: readonly IntegrationAccount[],
): React.ReactNode {
  return (
    <div
      className="connection-card"
      id={`integration-account-${account.integrationAccountId}`}
      key={account.integrationAccountId}
      tabIndex={-1}
    >
      <div className="connection-body">
        {renderConnectionHead(account, accounts.length > 1)}
        {renderConnectionProblem(account)}
        {renderIntegrationAccountDetails(account)}
        {renderConnectionRecency(account)}
      </div>
    </div>
  );
}

function renderIntegrationAccountRow(
  actions: IntegrationsPageActions,
  controls: IntegrationAccountControls,
  credentialInventory: CredentialInventory | null,
  groupAccounts: readonly IntegrationAccount[],
  account: IntegrationAccount,
): React.ReactNode {
  const record = findCredentialAccountRecord(
    credentialInventory,
    account.integrationAccountId,
  );
  const commands = integrationAccountCommands(actions, controls, account, null);
  return (
    <div
      className="connection-card"
      id={`integration-account-${account.integrationAccountId}`}
      key={account.integrationAccountId}
      tabIndex={-1}
    >
      <div className="connection-body">
        {renderConnectionHead(account, groupAccounts.length > 1)}
        {renderConnectionProblem(account)}
        {renderMutationFeedback(controls.feedback, {
          kind: "integration_account",
          integrationAccountId: account.integrationAccountId,
        })}
        {renderIntegrationAccountDetails(account)}
        {renderConnectionRecency(account)}
        <div className="connection-command">
          {commands.primary}
          {commands.cancel}
          {commands.secondary}
          {commands.danger}
        </div>
        {record === null ? null : (
          <CredentialRecoveryActions
            account={account}
            record={record}
            candidates={groupAccounts.filter(
              isCredentialReplacementCandidate.bind(
                null,
                account.integrationAccountId,
              ),
            )}
            busy={integrationAccountBusy(
              controls.mutations,
              controls.pendingAuthorization,
              account.integrationAccountId,
            )}
            rotate={actions.rotateCredential}
            revoke={actions.revokeCredential}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The dialog's title already names the app, so the card leads with the account.
 * "Default" only means something beside another account of the same app.
 */
function renderConnectionHead(
  account: IntegrationAccount,
  showDefault: boolean,
): React.ReactNode {
  return (
    <div className="connection-head">
      <div className="connection-identity">
        <strong title={account.displayName}>{account.displayName}</strong>
      </div>
      <div className="connection-status">
        {showDefault && account.isDefaultForProvider ? (
          <span className="connection-default-tag">Default</span>
        ) : null}
        <StatusChip
          status={integrationLifecycleStatus(account.lifecycle.kind)}
        />
      </div>
    </div>
  );
}

export function renderConnectionProblem(account: IntegrationAccount): React.ReactNode {
  const problem = connectionProblem(account);
  if (problem === null) return null;
  return (
    <p className="connection-problem">
      <strong>{problem.cause}</strong> {problem.consequence}
    </p>
  );
}

export function connectionNeedsAttention(account: IntegrationAccount): boolean {
  return connectionProblem(account) !== null;
}

type ConnectionProblem = {
  /** What went wrong, in the operator's words. */
  readonly cause: string;
  /** What stopped working while it stays broken. */
  readonly consequence: string;
};

/**
 * Turns a lifecycle plus its projection reason code into the two things an
 * operator actually needs: what broke, and what it is costing them. Reason
 * codes we have not written copy for still get an honest generic sentence
 * rather than being dropped on the floor.
 */
function connectionProblem(
  account: IntegrationAccount,
): ConnectionProblem | null {
  const service = providerLabel(account.provider);
  const consequence = providerDisconnectedConsequence(account.provider);
  switch (account.lifecycle.kind) {
    case "active":
    case "connecting":
    case "pending_activation":
      return null;
    case "disabled":
      return {
        cause: `${service} is turned off.`,
        consequence: `${consequence} Reconnect it when you want that back.`,
      };
    case "revoked":
      return {
        cause: `${service} access was revoked.`,
        consequence: `${consequence} You will need to connect ${service} again from scratch.`,
      };
    case "degraded":
    case "reauth_required":
      return {
        cause: connectionCause(service, account.lifecycle.reasonCode),
        consequence,
      };
    default:
      return assertNever(account.lifecycle, "Unexpected settings state");
  }
}

function connectionCause(service: string, reasonCode: string): string {
  switch (reasonCode) {
    case "oauth_scope_revoked":
      return `${service} removed a permission Purin Pantry was given.`;
    case "provider_credential_revoked":
    case "credential_revoked":
      return `The key Purin Pantry uses for ${service} was revoked.`;
    case "provider_credential_rotated":
    case "credential_rotated":
      return `The key Purin Pantry uses for ${service} was replaced.`;
    case "authorization_expired":
      return `The ${service} authorization expired.`;
    case "provider_grant_refused":
      return `${service} refused the sign-in that Purin Pantry uses. It expired, or someone removed the access.`;
    case "authorization_cancelled":
      return `The ${service} authorization was closed before it finished.`;
    case "provider_manifest_unhealthy":
      return `${service} stopped answering the checks Purin Pantry runs against it.`;
    case "provider_webhook_unhealthy":
      return `${service} stopped delivering updates to Purin Pantry.`;
    case "provider_rejected":
      return `${service} rejected the last request Purin Pantry made.`;
    case "provider_configuration_missing":
      return `Purin Pantry is missing the settings it needs to reach ${service}.`;
    case "provider_account_disabled":
    case "merchant_disabled":
      return `The ${service} account Purin Pantry connects to is disabled.`;
    case "provider_account_removed":
      return `The ${service} account Purin Pantry connects to was removed.`;
    case "automatic_inactivity":
      return `${service} went quiet for long enough that Purin Pantry paused it.`;
    default:
      return `${service} needs to be reconnected.`;
  }
}

function isCredentialReplacementCandidate(
  integrationAccountId: string,
  account: IntegrationAccount,
): boolean {
  return (
    account.integrationAccountId !== integrationAccountId &&
    account.lifecycle.kind === "active"
  );
}

function renderIntegrationAccountDetails(
  account: IntegrationAccount,
): React.ReactNode {
  return (
    <dl className="integration-account-details">
      <div>
        <dt>What Purin Pantry can do</dt>
        <dd>{describeAccountAccess(account)}</dd>
      </div>
      {account.selectedResources.length === 0 ||
      account.provider === "slack" ? null : (
        <div>
          <dt>Connected to</dt>
          <dd>
            {account.selectedResources.map(formatSelectedResource).join(" · ")}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * Scopes are the provider's vocabulary. For the connections this page
 * onboards, the row says what the granted scope set lets Pantry do instead.
 */
function describeAccountAccess(account: IntegrationAccount): string {
  switch (account.provider) {
    case "dropbox":
      return "Read the folders and files you share. Nothing is changed, moved or shared.";
    case "google_drive":
      return "Read only the files you pick. The rest of the Drive stays private.";
    case "gmail":
      return isFullMailboxGmailAccount(account)
        ? "Read mail, save replies as drafts, and send the replies you approve."
        : "Send email only after you approve it. It cannot read your mail.";
    case "slack":
      return "Post and answer in the channels you add.";
    case "shopify":
      return "Keep products, stock and orders up to date from this store.";
    case "stripe":
      return "Take card payments and refunds through this account.";
    case "square":
      return "Take Square Terminal payments and refunds through this account.";
    case "notion":
      return "Search the pages you share. Nothing is changed.";
    case "airtable":
      return "Read and update the tables you share.";
    case "whatsapp":
      return "Receive customer messages and send replies.";
    default:
      return account.scopes.length === 0
        ? "None reported"
        : account.scopes.join(", ");
  }
}

/**
 * Every card offers at most one filled button (the move that its current state
 * actually calls for). The other actions stay visible beside it as quiet ones,
 * so a person can tell repair from routine without opening anything.
 */
export type IntegrationAccountCommands = {
  /** The repair action that the card's state calls for. */
  readonly primary: React.ReactNode | null;
  /** "Cancel" while a consent window is open. */
  readonly cancel: React.ReactNode | null;
  /** Everything else that keeps the connection. */
  readonly secondary: readonly React.ReactNode[];
  /**
   * The commands that cut the connection off. A card lists them after
   * `secondary`; a view of one account gives them their own section.
   */
  readonly danger: readonly React.ReactNode[];
};

/**
 * `subject` names the account on the commands that cut it off ("Disconnect
 * support@example.com"). A view that shows one account passes it; a card in a
 * list already carries the account's name and passes null.
 */
export function integrationAccountCommands(
  actions: IntegrationsPageActions,
  controls: IntegrationAccountControls,
  account: IntegrationAccount,
  subject: string | null,
): IntegrationAccountCommands {
  const provider = reconnectableProvider(account.provider);
  const rowBusy = integrationAccountBusy(
    controls.mutations,
    controls.pendingAuthorization,
    account.integrationAccountId,
  );
  const service = providerLabel(account.provider);
  const waiting = awaitingAccountAuthorization(
    controls.pendingAuthorization,
    account.integrationAccountId,
  );
  const reconnectButton = (filled: boolean): React.ReactNode =>
    provider === null ? null : (
      <button
        key="reconnect"
        type="button"
        className={filled ? "connection-primary-action" : undefined}
        data-provider={provider}
        data-account-id={account.integrationAccountId}
        onClick={actions.reconnectAccount}
        aria-label={`Reconnect ${service} in a popup`}
        disabled={rowBusy}
      >
        {waiting
          ? `Waiting for ${authorizationServiceName(account.provider)}…`
          : `Reconnect ${service}`}
      </button>
    );
  const refreshResources =
    account.provider === "square" ? (
      <button
        key="refresh-resources"
        type="button"
        data-account-id={account.integrationAccountId}
        onClick={actions.refreshAccountResources}
        disabled={rowBusy}
      >
        Refresh locations and devices
      </button>
    ) : null;
  const cancelAuthorization = waiting ? (
    <button
      key="cancel-authorization"
      type="button"
      onClick={actions.cancelProviderAuthorization}
    >
      Cancel
    </button>
  ) : null;
  const disconnect = (
    <ConfirmButton
      key="disconnect"
      confirmKey={`disable:${account.integrationAccountId}`}
      pendingConfirm={controls.pendingConfirm}
      requestConfirm={controls.requestConfirm}
      onConfirmed={actions.disableAccount}
      disabled={rowBusy}
      label={subject === null ? "Disconnect" : `Disconnect ${subject}`}
      confirmLabel={
        subject === null
          ? `Confirm ${service} disconnection`
          : `Confirm: disconnect ${subject}`
      }
      data={{ "account-id": account.integrationAccountId }}
    />
  );
  const removeSlackWorkspace =
    account.provider === "slack" ? (
      <ConfirmButton
        key="remove-workspace"
        confirmKey={`remove:${account.integrationAccountId}`}
        pendingConfirm={controls.pendingConfirm}
        requestConfirm={controls.requestConfirm}
        onConfirmed={actions.removeAccount}
        disabled={rowBusy}
        label="Remove this Slack workspace"
        confirmLabel="Confirm: remove this Slack workspace"
        data={{ "account-id": account.integrationAccountId }}
      />
    ) : null;

  switch (account.lifecycle.kind) {
    case "connecting":
    case "pending_activation":
      return {
        primary: null,
        cancel: cancelAuthorization,
        secondary: [],
        danger: [
          <ConfirmButton
            key="disable"
            confirmKey={`disable:${account.integrationAccountId}`}
            pendingConfirm={controls.pendingConfirm}
            requestConfirm={controls.requestConfirm}
            onConfirmed={actions.disableAccount}
            disabled={rowBusy}
            label={subject === null ? "Disable" : `Disable ${subject}`}
            confirmLabel={
              subject === null
                ? "Confirm disable"
                : `Confirm: disable ${subject}`
            }
            data={{ "account-id": account.integrationAccountId }}
          />,
        ],
      };
    case "active":
      return {
        primary: null,
        cancel: cancelAuthorization,
        secondary: [
          account.isDefaultForProvider ? null : (
            <button
              key="default"
              type="button"
              data-account-id={account.integrationAccountId}
              onClick={actions.setDefaultAccount}
              disabled={rowBusy}
            >
              Make default
            </button>
          ),
          reconnectButton(false),
          refreshResources,
        ].filter(Boolean),
        danger: [removeSlackWorkspace ?? disconnect],
      };
    case "degraded":
    case "reauth_required":
      return {
        primary: reconnectButton(true),
        cancel: cancelAuthorization,
        secondary: [refreshResources].filter(Boolean),
        danger: [disconnect],
      };
    case "disabled":
      return {
        primary: reconnectButton(true),
        cancel: cancelAuthorization,
        secondary: [],
        danger:
          removeSlackWorkspace !== null
            ? [removeSlackWorkspace]
            : [
                <ConfirmButton
                  key="remove"
                  confirmKey={`remove:${account.integrationAccountId}`}
                  pendingConfirm={controls.pendingConfirm}
                  requestConfirm={controls.requestConfirm}
                  onConfirmed={actions.removeAccount}
                  disabled={
                    rowBusy ||
                    (account.isDefaultForProvider &&
                      account.accountKind !== "mailbox")
                  }
                  label={
                    subject === null ? "Remove connection" : `Remove ${subject}`
                  }
                  confirmLabel={
                    subject === null
                      ? "Confirm connection removal"
                      : `Confirm: remove ${subject}`
                  }
                  data={{ "account-id": account.integrationAccountId }}
                />,
              ],
      };
    case "revoked":
      return { primary: null, cancel: null, secondary: [], danger: [] };
    default:
      return assertNever(account.lifecycle, "Unexpected settings state");
  }
}

/**
 * Credential recovery actions rendered beside Reconnect/Disable. Rotation is a
 * dedicated secret-accepting form: the field is password-typed, never echoed
 * back, and cleared before the request leaves the component. Revocation is
 * metadata only and never touches secret values.
 */
function CredentialRecoveryActions(props: {
  readonly account: IntegrationAccount;
  readonly record: CredentialAccountRecord;
  readonly candidates: readonly IntegrationAccount[];
  readonly busy: boolean;
  readonly rotate: (
    integrationAccountId: string,
    replacementSecret: string,
  ) => Promise<CredentialActionOutcome>;
  readonly revoke: (
    integrationAccountId: string,
    replacementIntegrationAccountId: string | null,
  ) => Promise<CredentialActionOutcome>;
}): React.ReactNode {
  return (
    <div className="account-actions credential-recovery-actions">
      <CredentialRotateAction
        account={props.account}
        record={props.record}
        busy={props.busy}
        rotate={props.rotate}
      />
      <CredentialRevokeAction
        account={props.account}
        record={props.record}
        candidates={props.candidates}
        busy={props.busy}
        revoke={props.revoke}
      />
    </div>
  );
}

type CredentialRotateFormState = {
  readonly open: boolean;
  readonly pending: boolean;
  readonly secret: string;
  readonly outcome: CredentialActionOutcome | null;
};

function CredentialRotateAction(props: {
  readonly account: IntegrationAccount;
  readonly record: CredentialAccountRecord;
  readonly busy: boolean;
  readonly rotate: (
    integrationAccountId: string,
    replacementSecret: string,
  ) => Promise<CredentialActionOutcome>;
}): React.ReactNode {
  const [state, setState] = React.useState<CredentialRotateFormState>({
    open: false,
    pending: false,
    secret: "",
    outcome: null,
  });
  const fieldId = React.useId();
  // A connection through a provider sign-in has no key to paste: Reconnect
  // refreshes it.
  if (!credentialRotationSupported(props.record)) return null;
  if (!state.open) {
    return (
      <div className="credential-action">
        <button
          type="button"
          onClick={openCredentialRotateForm.bind(null, setState)}
          disabled={props.busy}
        >
          Replace key…
        </button>
        {renderCredentialRotateOutcome(state.outcome)}
      </div>
    );
  }
  return (
    <form
      className="inline-form credential-rotate-form"
      onSubmit={submitCredentialRotation.bind(null, props, setState, state)}
    >
      <label htmlFor={fieldId}>
        <span>New {credentialSecretLabel(props.record.provider)}</span>
        <input
          id={fieldId}
          type="password"
          autoComplete="off"
          value={state.secret}
          onChange={changeCredentialRotateSecret.bind(null, setState)}
          required
        />
      </label>
      <button
        type="submit"
        disabled={
          props.busy || state.pending || state.secret.trim().length === 0
        }
      >
        Save new key
      </button>
      <button
        type="button"
        onClick={closeCredentialRotateForm.bind(null, setState)}
        disabled={state.pending}
      >
        Cancel
      </button>
      {renderCredentialRotateOutcome(state.outcome)}
    </form>
  );
}

function credentialSecretLabel(provider: string): string {
  switch (provider) {
    case "airtable":
      return "Airtable personal access token";
    case "notion":
      return "Notion integration token";
    case "stripe":
      return "Stripe secret key";
    case "shopify":
      return "Shopify admin token";
    default:
      return "provider key";
  }
}

function openCredentialRotateForm(
  setState: React.Dispatch<React.SetStateAction<CredentialRotateFormState>>,
): void {
  setState(toOpenCredentialRotateForm);
}

function toOpenCredentialRotateForm(
  state: CredentialRotateFormState,
): CredentialRotateFormState {
  return { open: true, pending: false, secret: "", outcome: state.outcome };
}

function closeCredentialRotateForm(
  setState: React.Dispatch<React.SetStateAction<CredentialRotateFormState>>,
): void {
  setState(toClosedCredentialRotateForm);
}

function toClosedCredentialRotateForm(
  state: CredentialRotateFormState,
): CredentialRotateFormState {
  return { open: false, pending: false, secret: "", outcome: state.outcome };
}

function changeCredentialRotateSecret(
  setState: React.Dispatch<React.SetStateAction<CredentialRotateFormState>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const secret = event.currentTarget.value;
  setState(withCredentialRotateSecret.bind(null, secret));
}

function withCredentialRotateSecret(
  secret: string,
  state: CredentialRotateFormState,
): CredentialRotateFormState {
  return { ...state, secret };
}

async function submitCredentialRotation(
  props: {
    readonly account: IntegrationAccount;
    readonly rotate: (
      integrationAccountId: string,
      replacementSecret: string,
    ) => Promise<CredentialActionOutcome>;
  },
  setState: React.Dispatch<React.SetStateAction<CredentialRotateFormState>>,
  state: CredentialRotateFormState,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  if (state.pending) return;
  const secret = state.secret.trim();
  if (secret.length === 0) {
    setState(withCredentialRotateSecret.bind(null, ""));
    return;
  }
  setState(beginCredentialRotateSubmit);
  const outcome = await props.rotate(
    props.account.integrationAccountId,
    secret,
  );
  setState(finishCredentialRotateSubmit.bind(null, outcome));
}

/** Clears the secret field before the request leaves, regardless of outcome. */
function beginCredentialRotateSubmit(
  state: CredentialRotateFormState,
): CredentialRotateFormState {
  return { ...state, pending: true, secret: "" };
}

function finishCredentialRotateSubmit(
  outcome: CredentialActionOutcome,
  state: CredentialRotateFormState,
): CredentialRotateFormState {
  return {
    open: outcome.kind === "failed",
    pending: false,
    secret: "",
    outcome:
      outcome.kind === "rotated" || outcome.kind === "failed"
        ? outcome
        : state.outcome,
  };
}

function renderCredentialRotateOutcome(
  outcome: CredentialActionOutcome | null,
): React.ReactNode {
  if (outcome === null) return null;
  switch (outcome.kind) {
    case "rotated":
      return (
        <p className="notice-text" role="status">
          {formatCredentialRotationReceipt(outcome.receipt)}
        </p>
      );
    case "revoked":
      return null;
    case "failed":
      return (
        <p className="error-text" role="alert">
          {outcome.message}
        </p>
      );
    default:
      return assertNever(outcome, "Unexpected settings state");
  }
}

function formatCredentialRotationReceipt(
  receipt: CredentialRotationReceipt | null,
): string {
  if (receipt === null) return "The new key is active.";
  const activation =
    receipt.policyActivation === "completed"
      ? "The updated access policy is live."
      : "The access policy update is finishing in the background.";
  return `The new key is active. Generation ${receipt.activeGeneration} replaced generation ${receipt.previousGeneration}. ${activation} Receipt ${receipt.credentialRotationId}.`;
}

type CredentialRevokeStage = "idle" | "confirm" | "replacement";

type CredentialRevokeState = {
  readonly stage: CredentialRevokeStage;
  readonly pending: boolean;
  readonly replacementId: string;
  readonly outcome: CredentialActionOutcome | null;
};

function CredentialRevokeAction(props: {
  readonly account: IntegrationAccount;
  readonly record: CredentialAccountRecord;
  readonly candidates: readonly IntegrationAccount[];
  readonly busy: boolean;
  readonly revoke: (
    integrationAccountId: string,
    replacementIntegrationAccountId: string | null,
  ) => Promise<CredentialActionOutcome>;
}): React.ReactNode {
  const [state, setState] = React.useState<CredentialRevokeState>({
    stage: "idle",
    pending: false,
    replacementId: "",
    outcome: null,
  });
  const alreadyRevoked = props.record.revocation !== null;
  if (state.stage === "idle") {
    return (
      <div className="credential-action">
        <button
          type="button"
          className="danger-button"
          onClick={requestCredentialRevoke.bind(null, setState)}
          disabled={props.busy || alreadyRevoked}
        >
          Block access now…
        </button>
        {alreadyRevoked ? (
          <small className="notice-text">
            Access is already blocked. Reconnect to restore it.
          </small>
        ) : null}
        {renderCredentialRevokeOutcome(state.outcome)}
      </div>
    );
  }
  if (state.stage === "confirm") {
    return (
      <div
        className="credential-action"
        role="group"
        aria-label="Confirm blocking access"
      >
        <p className="notice-text">
          Agents stop using this connection at once. Reconnect to restore
          access.
        </p>
        <button
          type="button"
          className="danger-button"
          onClick={confirmCredentialRevoke.bind(null, props, setState, state)}
          disabled={props.busy || state.pending}
        >
          Block access
        </button>
        <button
          type="button"
          onClick={cancelCredentialRevoke.bind(null, setState)}
          disabled={state.pending}
        >
          Cancel
        </button>
        {renderCredentialRevokeOutcome(state.outcome)}
      </div>
    );
  }
  return (
    <div
      className="credential-action"
      role="group"
      aria-label="Choose a replacement default account"
    >
      <p className="notice-text">
        This is the default {providerLabel(props.account.provider)} account.
        Choose another default account to block this one.
      </p>
      <label>
        <span>New default account</span>
        <Select.Root
          items={[
            { value: "", label: "Choose an account…" },
            ...props.candidates.map(credentialReplacementItem),
          ]}
          value={state.replacementId}
          onValueChange={changeCredentialReplacement.bind(null, setState)}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            <Select.Item value="">Choose an account…</Select.Item>
            {props.candidates.map(renderCredentialReplacementOption)}
          </Select.Popup>
        </Select.Root>
      </label>
      <button
        type="button"
        className="danger-button"
        onClick={confirmCredentialRevoke.bind(null, props, setState, state)}
        disabled={
          props.busy || state.pending || state.replacementId.length === 0
        }
      >
        Block and change default
      </button>
      <button
        type="button"
        onClick={cancelCredentialRevoke.bind(null, setState)}
        disabled={state.pending}
      >
        Cancel
      </button>
      {renderCredentialRevokeOutcome(state.outcome)}
    </div>
  );
}

function credentialReplacementItem(
  account: IntegrationAccount,
): { value: string; label: string } {
  return { value: account.integrationAccountId, label: account.displayName };
}

function renderCredentialReplacementOption(
  account: IntegrationAccount,
): React.ReactNode {
  return (
    <Select.Item
      key={account.integrationAccountId}
      value={account.integrationAccountId}
    >
      {account.displayName}
    </Select.Item>
  );
}

function requestCredentialRevoke(
  setState: React.Dispatch<React.SetStateAction<CredentialRevokeState>>,
): void {
  setState(toConfirmCredentialRevoke);
}

function toConfirmCredentialRevoke(
  state: CredentialRevokeState,
): CredentialRevokeState {
  return {
    stage: "confirm",
    pending: false,
    replacementId: state.replacementId,
    outcome: null,
  };
}

function cancelCredentialRevoke(
  setState: React.Dispatch<React.SetStateAction<CredentialRevokeState>>,
): void {
  setState(toIdleCredentialRevoke);
}

function toIdleCredentialRevoke(
  state: CredentialRevokeState,
): CredentialRevokeState {
  return {
    stage: "idle",
    pending: false,
    replacementId: "",
    outcome: state.outcome,
  };
}

function changeCredentialReplacement(
  setState: React.Dispatch<React.SetStateAction<CredentialRevokeState>>,
  replacementId: string | null,
): void {
  if (replacementId === null) return;
  setState(withCredentialReplacement.bind(null, replacementId));
}

function withCredentialReplacement(
  replacementId: string,
  state: CredentialRevokeState,
): CredentialRevokeState {
  return { ...state, replacementId };
}

async function confirmCredentialRevoke(
  props: {
    readonly account: IntegrationAccount;
    readonly revoke: (
      integrationAccountId: string,
      replacementIntegrationAccountId: string | null,
    ) => Promise<CredentialActionOutcome>;
  },
  setState: React.Dispatch<React.SetStateAction<CredentialRevokeState>>,
  state: CredentialRevokeState,
): Promise<void> {
  if (state.pending) return;
  const replacementId =
    state.stage === "replacement" ? state.replacementId.trim() : "";
  setState(beginCredentialRevokeSubmit);
  const outcome = await props.revoke(
    props.account.integrationAccountId,
    replacementId.length === 0 ? null : replacementId,
  );
  setState(finishCredentialRevokeSubmit.bind(null, outcome));
}

function beginCredentialRevokeSubmit(
  state: CredentialRevokeState,
): CredentialRevokeState {
  return { ...state, pending: true };
}

function finishCredentialRevokeSubmit(
  outcome: CredentialActionOutcome,
  state: CredentialRevokeState,
): CredentialRevokeState {
  if (
    outcome.kind === "failed" &&
    outcome.errorKind === "default_account_replacement_required"
  ) {
    return {
      stage: "replacement",
      pending: false,
      replacementId: state.replacementId,
      outcome: null,
    };
  }
  if (outcome.kind === "failed") {
    return { ...state, pending: false, outcome };
  }
  return { stage: "idle", pending: false, replacementId: "", outcome };
}

function renderCredentialRevokeOutcome(
  outcome: CredentialActionOutcome | null,
): React.ReactNode {
  if (outcome === null) return null;
  switch (outcome.kind) {
    case "revoked":
      return (
        <p className="notice-text" role="status">
          {formatCredentialRevocationReceipt(outcome.receipt)}
        </p>
      );
    case "rotated":
      return null;
    case "failed":
      return (
        <p className="error-text" role="alert">
          {outcome.message}
        </p>
      );
    default:
      return assertNever(outcome, "Unexpected settings state");
  }
}

function formatCredentialRevocationReceipt(
  receipt: CredentialRevocationReceipt | null,
): string {
  if (receipt === null) return "The credential was revoked.";
  const restriction =
    receipt.state === "policy_activated"
      ? "Access restriction is active."
      : "Access restriction is being applied.";
  return `Credential revoked. ${receipt.credentialGenerationCount} generation${receipt.credentialGenerationCount === 1 ? "" : "s"} and ${receipt.vaultSecretCount} stored secret${receipt.vaultSecretCount === 1 ? "" : "s"} were revoked. ${restriction} Receipt ${receipt.revocationId}.`;
}
