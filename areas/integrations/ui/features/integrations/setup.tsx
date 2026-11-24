import type { FileContextProvider } from "@purin-labs/contracts";
import React from "react";
import { toast } from "sonner";
import { EmptyState } from "@purin-labs/ui/page-components";
import { MutationLedger } from "@purin-labs/control/portal/mutation-state";
import {
  LastAttemptNotice,
  ProviderConnectAction,
  providerAttemptFailureCopy,
  type ProviderAttemptDiagnostics,
} from "../../provider-onboarding";
import { providerLabel } from "@purin-labs/area-integrations-contract/ui/integration-catalogue";
import { ConsentPoint } from "./connect-consent-dialog";
import { connectionNeedsAttention } from "./accounts";
import {
  integrationAccountIsConnected,
  mutationFeedbackMessage,
  providerConnectionState,
} from "./settings-support";
import type { IntegrationAccount, SupportDiagnostics } from "@purin-labs/control-api/portal/settings";
import type { IntegrationsPageActions, PendingProviderAuthorization, SettingsMutationFeedback } from "./settings-types";

/**
 * Connection health is not page furniture: a healthy strip says nothing, and
 * a broken provider announces itself once: the console carries the detail
 * and a toast carries the glance.
 */
export function connectionAttentionMessage(
  accounts: readonly IntegrationAccount[],
): string | null {
  const names = accounts
    .filter(connectionNeedsAttention)
    .map(accountProviderName);
  if (names.length === 0) return null;
  return `${formatConnectionList(names)} need${names.length === 1 ? "s" : ""} attention.`;
}

function accountProviderName(account: IntegrationAccount): string {
  return providerLabel(account.provider);
}

export function announceConnectionAttention(message: string | null): void {
  if (message === null) return;
  console.warn(`[integrations] ${message}`);
  toast.warning(message);
}

function formatConnectionList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function IntegrationSetup(props: {
  /** Null when the dialog's own title already names the step. */
  readonly title: string | null;
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="integration-setup">
      {props.title === null ? null : <h4>{props.title}</h4>}
      {props.children}
    </div>
  );
}

export function ProviderConnectButton(props: {
  readonly provider: "airtable" | "notion";
  readonly label: string;
  readonly onClick: () => Promise<void>;
  readonly busy: boolean;
  readonly feedback: SettingsMutationFeedback;
}): React.ReactNode {
  const error = mutationFeedbackMessage(props.feedback, {
    kind: "connect_provider",
    provider: props.provider,
  });
  const errorId = `${props.provider}-connection-error`;
  return (
    <div className="provider-connect">
      <button
        type="button"
        className="connection-primary-action"
        aria-label={`${props.label} in a popup`}
        onClick={props.onClick}
        disabled={props.busy}
        aria-describedby={error === null ? undefined : errorId}
      >
        {props.label}
      </button>
      {error === null ? null : (
        <p id={errorId} className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The organisation's open support reference, when it belongs to one of these providers. */
export function providerAttemptDiagnostics(
  diagnostics: SupportDiagnostics | null,
  providers: readonly string[],
): ProviderAttemptDiagnostics | null {
  if (
    diagnostics === null ||
    diagnostics.provider === null ||
    !providers.includes(diagnostics.provider)
  ) {
    return null;
  }
  return {
    provider: diagnostics.provider,
    supportReference: diagnostics.supportReference,
    reasonCode: diagnostics.reasonCode,
    occurredAt: diagnostics.occurredAt,
  };
}

type FileStorageIntegrationPanelProps = {
  readonly provider: FileContextProvider;
  readonly accounts: readonly IntegrationAccount[];
  readonly accountList: (
    accounts: readonly IntegrationAccount[],
  ) => React.ReactNode;
  readonly canManage: boolean;
  readonly mutations: MutationLedger;
  readonly pendingAuthorization: PendingProviderAuthorization | null;
  readonly lastAttempt: ProviderAttemptDiagnostics | null;
  readonly actions: IntegrationsPageActions;
  readonly feedback: SettingsMutationFeedback;
};

export function FileStorageIntegrationPanel(
  props: FileStorageIntegrationPanelProps,
): React.ReactNode {
  const service = providerLabel(props.provider);
  const connected = props.accounts.some(integrationAccountIsConnected);
  return (
    <>
      {props.accountList(props.accounts)}
      {!connected && !props.canManage ? (
        <EmptyState
          title={`No ${service} account is connected`}
          detail={`A workspace admin can connect ${service} so agents can use business files.`}
        />
      ) : null}
      {props.canManage ? (
        <FileStorageSetup
          connected={connected}
          provider={props.provider}
          mutations={props.mutations}
          pendingAuthorization={props.pendingAuthorization}
          lastAttempt={props.lastAttempt}
          feedback={props.feedback}
          actions={props.actions}
        />
      ) : null}
    </>
  );
}

function FileStorageSetup(props: {
  readonly connected: boolean;
  readonly provider: FileContextProvider;
  readonly mutations: MutationLedger;
  readonly pendingAuthorization: PendingProviderAuthorization | null;
  readonly lastAttempt: ProviderAttemptDiagnostics | null;
  readonly feedback: SettingsMutationFeedback;
  readonly actions: IntegrationsPageActions;
}): React.ReactNode {
  const provider = props.provider;
  const state = providerConnectionState(
    props.mutations,
    props.pendingAuthorization,
    props.feedback,
    provider,
  );
  const service = providerLabel(provider);
  return (
    <section
      className="provider-consent"
      aria-label={
        props.connected
          ? `Connect another ${service} account`
          : `Connect ${service}`
      }
    >
      <ul
        className="connect-consent-points"
        aria-label={`What Purin Pantry can access in ${service}`}
      >
        <ConsentPoint
          title="You choose what to share"
          detail={
            provider === "dropbox"
              ? "Agents see only the folders and files you pick."
              : "Agents see only the files you pick."
          }
        />
        <ConsentPoint
          title="Read only"
          detail="Purin Pantry never edits, moves or shares your files."
        />
        <ConsentPoint
          title="You stay in control"
          detail={`Your password stays with ${service}. Remove access at any time.`}
        />
      </ul>
      <ProviderConnectAction
        id="file-storage-setup"
        service={service}
        label={`Continue with ${service}`}
        state={state}
        disabled={false}
        connect={
          provider === "dropbox"
            ? props.actions.connectDropbox
            : props.actions.connectGoogleDrive
        }
        cancel={props.actions.cancelProviderAuthorization}
        help={fileStorageHelp(provider)}
        waitingHint={`Finish signing in to ${service} in the window that opened. This page updates as soon as you approve.`}
      />
      {props.lastAttempt === null ? null : (
        <LastAttemptNotice
          attempt={props.lastAttempt}
          copy={providerAttemptFailureCopy(
            providerLabel(props.lastAttempt.provider),
            props.lastAttempt.reasonCode,
          )}
        />
      )}
    </section>
  );
}

function fileStorageHelp(provider: FileContextProvider): string {
  const service = providerLabel(provider);
  return `Opens ${service} in a new window. Use a business account if you have one.`;
}
