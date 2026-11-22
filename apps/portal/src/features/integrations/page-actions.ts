import React from "react";
import { toast } from "sonner";
import { ControlApiError } from "../../control-client";
import {
  MutationLedger,
  type OrganisationMutation,
} from "../../mutation-state";
import {
  editEmailReply as editReplyBody,
  reloadEmailReplyDraft,
  saveEmailReplyDraft,
} from "../email-review/api";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { saveInferenceSelection } from "./inference-actions";
import {
  approveEmailOperational,
  approveEmailReply,
  attestEmailOperational,
  connectDropbox,
  connectGmail,
  connectGmailSendOnly,
  connectGoogleDrive,
  connectWhatsApp,
  disableAgentMailbox,
  editEmailOperational,
  loadEmailOperationalPreview,
  loadEmailReplyPreview,
  reconnectAgentMailbox,
  rejectEmailOperational,
  rejectEmailReply,
  resolveEmailReply,
  resumeMailboxProcessing,
  revokeAgentMailbox,
  setUpMailbox,
  skipAndResumeMailboxProcessing,
} from "./mailbox-actions";
import {
  cancelProviderAuthorization,
  closeProviderAuthorizationSurface,
  navigateProviderAuthorizationSurface,
  openProviderAuthorizationSurface,
  watchProviderAuthorizationSurface,
} from "./provider-authorization";
import {
  invalidateSettingsRouteRequest,
  loadIntegrationsRoute,
  loadWorkspaceSettingsRoute,
} from "./route-loading";
import {
  buildSetupSelection,
  mutationBlocked,
  readAssignableControlRole,
  readCapabilityProfile,
  readControlRole,
  readCuePresetId,
} from "./settings-support";
import type { CredentialActionOutcome, IntegrationsCommand, IntegrationsPageActions, IntegrationsRouteData, IntegrationsRouteMutationContext, IntegrationsRouteProps, PendingProviderConnection, ProviderConnectionCommand, SettingsConfirmTimer, SettingsMutationFeedback, SettingsRouteContent, WorkspaceSettingsCommand, WorkspaceSettingsPageActions, WorkspaceSettingsRouteData, WorkspaceSettingsRouteMutationContext } from "./settings-types";
import type { IntegrationAccount } from "@purin-labs/control-api/portal/settings";

export function createIntegrationsPageActions(
  context: IntegrationsRouteMutationContext,
): IntegrationsPageActions {
  return {
    activate: activateIntegrationsWorkspace.bind(null, context),
    syncCommerceSystem: runIntegrationsCommand.bind(
      null,
      context,
      { kind: "sync_commerce" },
      { kind: "sync_commerce" },
      "Commerce data is current.",
    ),
    syncCommerceSystemQuietly: runIntegrationsCommand.bind(
      null,
      context,
      { kind: "sync_commerce" },
      { kind: "sync_commerce" },
      null,
    ),
    setupBuiltInCommerce: runIntegrationsCommand.bind(
      null,
      context,
      { kind: "provision_commerce" },
      { kind: "provision_commerce" },
      "Purin Checkout is ready.",
    ),
    publishExportCoordination: runIntegrationsCommand.bind(
      null,
      context,
      { kind: "publish_export_coordination" },
      { kind: "provision_commerce" },
      "Export tools are ready.",
    ),
    selectShopifyCommerce: selectShopifyCommerce.bind(null, context),
    connectShopify: connectShopify.bind(null, context),
    connectAirtable: connectAirtable.bind(null, context),
    connectDropbox: connectDropbox.bind(null, context),
    connectGmail: connectGmail.bind(null, context),
    connectGmailSendOnly: connectGmailSendOnly.bind(null, context),
    connectGoogleDrive: connectGoogleDrive.bind(null, context),
    connectWhatsApp: connectWhatsApp.bind(null, context),
    connectNotion: connectNotion.bind(null, context),
    connectStripe: connectStripe.bind(null, context),
    connectSquare: connectSquare.bind(null, context),
    connectSlack: connectSlack.bind(null, context),
    cancelProviderAuthorization: cancelProviderAuthorization.bind(
      null,
      context,
    ),
    connectCodex: runCodexConnection.bind(
      null,
      context,
      { kind: "connect_codex" },
      "OpenAI is ready for you to finish signing in.",
    ),
    reconnectCodex: runCodexConnection.bind(
      null,
      context,
      { kind: "reconnect_codex" },
      "OpenAI is ready for you to reconnect.",
    ),
    cancelCodexAuthorization: cancelCodexAuthorization.bind(null, context),
    completeCodexAuthorization: completeCodexAuthorization.bind(null, context),
    refreshOverview: refreshIntegrationsOverview.bind(null, context),
    disconnectCodex: runIntegrationsCommand.bind(
      null,
      context,
      { kind: "disconnect_codex" },
      { kind: "codex_connection" },
      "ChatGPT disconnected.",
    ),
    saveInferenceSelection: saveInferenceSelection.bind(null, context),
    disableAccount: disableIntegrationAccount.bind(null, context),
    reconnectAccount: reconnectIntegrationAccount.bind(null, context),
    rotateAccount: rotateIntegrationAccount.bind(null, context),
    setDefaultAccount: setDefaultIntegrationAccount.bind(null, context),
    removeAccount: removeIntegrationAccount.bind(null, context),
    refreshAccountResources: refreshAccountResources.bind(null, context),
    selectSlackDmOrganisation: selectSlackDmOrganisation.bind(null, context),
    saveSetup: saveIntegrationsSetup.bind(null, context),
    rotateCredential: rotateAccountCredential.bind(null, context),
    revokeCredential: revokeAccountCredential.bind(null, context),
    readMailboxSetup: context.props.transport.readMailboxSetup.bind(
      null,
      context.props.organisationId,
    ),
    setUpMailbox: setUpMailbox.bind(null, context),
    resumeMailbox: resumeMailboxProcessing.bind(null, context),
    skipAndResumeMailbox: skipAndResumeMailboxProcessing.bind(null, context),
    reconnectMailbox: reconnectAgentMailbox.bind(null, context),
    disableMailbox: disableAgentMailbox.bind(null, context),
    revokeMailbox: revokeAgentMailbox.bind(null, context),
    loadEmailReply: loadEmailReplyPreview.bind(null, context),
    editEmailReply: editReplyBody.bind(null, context.props.organisationId),
    saveEmailReplyDraft: saveEmailReplyDraft.bind(
      null,
      context.props.organisationId,
    ),
    reloadEmailReplyDraft: reloadEmailReplyDraft.bind(
      null,
      context.props.organisationId,
    ),
    approveEmailReply: approveEmailReply.bind(null, context),
    rejectEmailReply: rejectEmailReply.bind(null, context),
    resolveEmailReply: resolveEmailReply.bind(null, context),
    loadEmailOperational: loadEmailOperationalPreview.bind(null, context),
    approveEmailOperational: approveEmailOperational.bind(null, context),
    rejectEmailOperational: rejectEmailOperational.bind(null, context),
    editEmailOperational: editEmailOperational.bind(null, context),
    attestEmailOperational: attestEmailOperational.bind(null, context),
  };
}

export function createWorkspaceSettingsPageActions(
  context: WorkspaceSettingsRouteMutationContext,
): WorkspaceSettingsPageActions {
  return {
    changeMemberRole: changeWorkspaceMemberRole.bind(null, context),
    removeMember: removeWorkspaceMember.bind(null, context),
    revokeInvitation: revokeWorkspaceInvitation.bind(null, context),
    inviteMember: inviteWorkspaceMember.bind(null, context),
    archiveOrganisation: runWorkspaceCommand.bind(
      null,
      context,
      { kind: "archive_workspace" },
      { kind: "workspace_lifecycle" },
      "Workspace archived. Restoration remains available until purge starts.",
    ),
    restoreOrganisation: runWorkspaceCommand.bind(
      null,
      context,
      { kind: "restore_workspace" },
      { kind: "workspace_lifecycle" },
      "Workspace restored to configuration.",
    ),
  };
}

export async function runIntegrationsCommand(
  context: IntegrationsRouteMutationContext,
  command: IntegrationsCommand,
  mutation: OrganisationMutation,
  /** Null for work that the page starts by itself: it says nothing when it ends. */
  successMessage: string | null,
): Promise<void> {
  const data = readyIntegrationsData(context.content);
  if (
    data === null ||
    !beginSettingsMutation(context.mutations, context.setMutations, mutation)
  )
    return;
  try {
    await executeIntegrationsCommand(
      context,
      data.configurationVersion,
      command,
    );
    await loadIntegrationsRoute(
      context.props,
      context.requestRevision,
      context.setContent,
    );
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback(null);
    if (successMessage !== null) toast.success(successMessage);
  } catch (error) {
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback({ mutation, message: settingsMutationProblem(error) });
    if (mutation.kind === "sync_commerce")
      setCommerceSyncProblem(
        context.setContent,
        settingsMutationProblem(error),
      );
  }
}

/**
 * The configuration version is optimistic concurrency over every connection in
 * the organisation, so any change at all — including a background reconciliation the
 * operator never saw — makes an open page's version stale and fails its next
 * action. Re-reading and retrying once turns that into a no-op instead of an
 * error the operator can only clear by reloading. A conflict that survives the
 * retry is a genuine race and surfaces normally.
 *
 * Retrying is safe: the idempotency key is derived from the request including
 * its configuration version, so the second attempt is a distinct mutation
 * rather than a replay of the rejected one.
 */
export async function executeIntegrationsCommand(
  context: IntegrationsRouteMutationContext,
  configurationVersion: number,
  command: IntegrationsCommand,
): Promise<void> {
  try {
    await context.props.transport.execute(
      context.props.organisationId,
      context.props.organisationHandle,
      context.props.workspaceHandle,
      configurationVersion,
      command,
    );
  } catch (error) {
    if (
      !(error instanceof ControlApiError) ||
      error.kind !== "configuration_conflict"
    ) {
      throw error;
    }
    const refreshed = await context.props.transport.readOverview(
      context.props.organisationId,
    );
    await context.props.transport.execute(
      context.props.organisationId,
      context.props.organisationHandle,
      context.props.workspaceHandle,
      refreshed.configurationVersion,
      command,
    );
  }
}

async function connectShopify(
  context: IntegrationsRouteMutationContext,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const shopDomain = new FormData(event.currentTarget).get("shopDomain");
  if (typeof shopDomain !== "string" || shopDomain.trim().length === 0) {
    context.setFeedback({
      mutation: { kind: "connect_provider", provider: "shopify" },
      message: "Enter the myshopify.com domain.",
    });
    return;
  }
  await runProviderConnection(
    context,
    { kind: "connect_shopify", shopDomain: shopDomain.trim() },
    { kind: "connect_provider", provider: "shopify" },
  );
}

async function runCodexConnection(
  context: IntegrationsRouteMutationContext,
  command: Variant<IntegrationsCommand, "connect_codex" | "reconnect_codex">,
  successMessage: string,
): Promise<void> {
  const data = readyIntegrationsData(context.content);
  const mutation: OrganisationMutation = { kind: "codex_connection" };
  if (
    data === null ||
    !beginSettingsMutation(context.mutations, context.setMutations, mutation)
  )
    return;
  const authorizationSurface = openProviderAuthorizationSurface();
  try {
    const result = await context.props.transport.execute(
      context.props.organisationId,
      context.props.organisationHandle,
      context.props.workspaceHandle,
      data.configurationVersion,
      command,
    );
    if (result.kind !== "authorization")
      throw new Error("OpenAI authorization did not start.");
    navigateProviderAuthorizationSurface(
      authorizationSurface,
      result.authorizationUrl,
    );
    await loadIntegrationsRoute(
      context.props,
      context.requestRevision,
      context.setContent,
    );
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback(null);
    toast.success(successMessage);
  } catch (error) {
    closeProviderAuthorizationSurface(authorizationSurface);
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback({ mutation, message: settingsMutationProblem(error) });
  }
}

async function connectStripe(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  await runProviderConnection(
    context,
    { kind: "connect_stripe" },
    { kind: "connect_provider", provider: "stripe" },
  );
}

async function connectSquare(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  await runProviderConnection(
    context,
    { kind: "connect_square" },
    { kind: "connect_provider", provider: "square" },
  );
}

async function connectSlack(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  await runProviderConnection(
    context,
    { kind: "connect_slack" },
    { kind: "connect_provider", provider: "slack" },
  );
}

async function selectSlackDmOrganisation(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const installationId = event.currentTarget.dataset.installationId;
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (installationId === undefined || integrationAccountId === undefined) {
    return;
  }
  await runIntegrationsCommand(
    context,
    {
      kind: "select_slack_dm_organisation",
      installationId,
      integrationAccountId,
    },
    { kind: "integration_account", integrationAccountId },
    "New Slack DM Cases will use this organisation.",
  );
}

async function connectAirtable(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  await runProviderConnection(
    context,
    { kind: "connect_airtable" },
    { kind: "connect_provider", provider: "airtable" },
  );
}

async function connectNotion(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  await runProviderConnection(
    context,
    { kind: "connect_notion" },
    { kind: "connect_provider", provider: "notion" },
  );
}

function refreshIntegrationsOverview(
  context: IntegrationsRouteMutationContext,
): void {
  void loadIntegrationsRoute(
    context.props,
    context.requestRevision,
    context.setContent,
  );
}

async function cancelCodexAuthorization(
  context: IntegrationsRouteMutationContext,
  attemptId: string,
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "cancel_codex_authorization", attemptId },
    { kind: "codex_connection" },
    "ChatGPT connection cancelled.",
  );
}

async function completeCodexAuthorization(
  context: IntegrationsRouteMutationContext,
  attemptId: string,
  callbackUrl: string,
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "complete_codex_authorization", attemptId, callbackUrl },
    { kind: "codex_connection" },
    "ChatGPT connected.",
  );
}

/**
 * A first sign-in at a provider shows the consent dialog before it opens the
 * provider, unless its card already says the same. A reconnect of a known
 * account does not pass through here.
 */
export async function runProviderConnection(
  context: IntegrationsRouteMutationContext,
  command: ProviderConnectionCommand,
  mutation: Variant<OrganisationMutation, "connect_provider">,
): Promise<void> {
  if (
    readyIntegrationsData(context.content) === null ||
    mutationBlocked(context.mutations, mutation)
  )
    return;
  context.setFeedback(null);
  context.setConnectConsent({ command, mutation });
}

/**
 * Runs from the Continue click. The provider window must open before the
 * first await, or the browser blocks it as a popup the user did not ask for.
 */
export function confirmProviderConnection(
  context: IntegrationsRouteMutationContext,
  pending: PendingProviderConnection | null,
): void {
  if (pending === null) return;
  context.setConnectConsent(null);
  void startProviderConnection(context, pending.command, pending.mutation);
  // The setup step starts Slack without its dialog. The dialog opens behind
  // the Slack window and waits there, then moves on to the channel step by
  // itself when Slack approves.
  if (pending.mutation.provider === "slack") context.openIntegration("slack");
}

export async function startProviderConnection(
  context: IntegrationsRouteMutationContext,
  command: ProviderConnectionCommand,
  mutation: Variant<OrganisationMutation, "connect_provider">,
): Promise<void> {
  const data = readyIntegrationsData(context.content);
  if (
    data === null ||
    !beginSettingsMutation(context.mutations, context.setMutations, mutation)
  )
    return;
  const authorizationSurface = openProviderAuthorizationSurface();
  try {
    const result = await context.props.transport.execute(
      context.props.organisationId,
      context.props.organisationHandle,
      context.props.workspaceHandle,
      data.configurationVersion,
      command,
    );
    if (result.kind !== "authorization")
      throw new Error("Provider authorization did not start.");
    navigateProviderAuthorizationSurface(
      authorizationSurface,
      result.authorizationUrl,
    );
    watchProviderAuthorizationSurface(context, authorizationSurface, {
      kind: "connect",
      provider: mutation.provider,
    });
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback(null);
  } catch (error) {
    closeProviderAuthorizationSurface(authorizationSurface);
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback({ mutation, message: settingsMutationProblem(error) });
  }
}

async function selectShopifyCommerce(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const data = readyIntegrationsData(context.content);
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (data === null || integrationAccountId === undefined) return;
  await runIntegrationsCommand(
    context,
    {
      kind: "select_shopify",
      integrationAccountId,
      expectedRevision: data.commerceSystem?.revision ?? 0,
    },
    { kind: "select_commerce", integrationAccountId },
    "Shopify is now the selected commerce system.",
  );
}

async function disableIntegrationAccount(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const data = readyIntegrationsData(context.content);
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (data === null || integrationAccountId === undefined) return;
  await runIntegrationsCommand(
    context,
    { kind: "disable_account", integrationAccountId },
    { kind: "integration_account", integrationAccountId },
    "Integration disabled.",
  );
}

async function reconnectIntegrationAccount(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  await runExistingAccountFlow(context, event, "reconnect");
}

async function rotateIntegrationAccount(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  await runExistingAccountFlow(context, event, "rotate");
}

async function runExistingAccountFlow(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
  purpose: "reconnect" | "rotate",
): Promise<void> {
  const data = readyIntegrationsData(context.content);
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (data === null || integrationAccountId === undefined) return;
  const account = data.accounts.find(
    matchesIntegrationAccountId.bind(null, integrationAccountId),
  );
  if (account === undefined) return;
  const mutation: OrganisationMutation = {
    kind: "integration_account",
    integrationAccountId,
  };
  if (!beginSettingsMutation(context.mutations, context.setMutations, mutation))
    return;
  const authorizationSurface = openProviderAuthorizationSurface();
  try {
    const result = await context.props.transport.execute(
      context.props.organisationId,
      context.props.organisationHandle,
      context.props.workspaceHandle,
      data.configurationVersion,
      {
        kind: purpose === "reconnect" ? "reconnect_account" : "rotate_account",
        integrationAccountId,
      },
    );
    if (result.kind !== "authorization")
      throw new Error("Provider authorization did not start.");
    navigateProviderAuthorizationSurface(
      authorizationSurface,
      result.authorizationUrl,
    );
    watchProviderAuthorizationSurface(context, authorizationSurface, {
      kind: "existing_account",
      integrationAccountId,
      provider: account.provider,
    });
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback(null);
  } catch (error) {
    closeProviderAuthorizationSurface(authorizationSurface);
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback({ mutation, message: settingsMutationProblem(error) });
  }
}

async function rotateAccountCredential(
  context: IntegrationsRouteMutationContext,
  integrationAccountId: string,
  replacementSecret: string,
): Promise<CredentialActionOutcome> {
  const outcome = await runCredentialCommand(
    context,
    integrationAccountId,
    { kind: "rotate_credential", integrationAccountId, replacementSecret },
    "The new key is active.",
  );
  return outcome;
}

async function revokeAccountCredential(
  context: IntegrationsRouteMutationContext,
  integrationAccountId: string,
  replacementIntegrationAccountId: string | null,
): Promise<CredentialActionOutcome> {
  return runCredentialCommand(
    context,
    integrationAccountId,
    {
      kind: "revoke_credential",
      integrationAccountId,
      replacementIntegrationAccountId,
    },
    "Credential revoked.",
  );
}

async function runCredentialCommand(
  context: IntegrationsRouteMutationContext,
  integrationAccountId: string,
  command: Variant<
    IntegrationsCommand,
    "rotate_credential" | "revoke_credential"
  >,
  successMessage: string,
): Promise<CredentialActionOutcome> {
  const data = readyIntegrationsData(context.content);
  const mutation: OrganisationMutation = {
    kind: "integration_account",
    integrationAccountId,
  };
  if (
    data === null ||
    !beginSettingsMutation(context.mutations, context.setMutations, mutation)
  ) {
    return {
      kind: "failed",
      errorKind: "unknown",
      message: "Another change to this connection is in progress. Try again.",
    };
  }
  try {
    const result = await context.props.transport.execute(
      context.props.organisationId,
      context.props.organisationHandle,
      context.props.workspaceHandle,
      data.configurationVersion,
      command,
    );
    if (
      result.kind !== "credential_rotation" &&
      result.kind !== "credential_revocation"
    ) {
      throw new Error("Credential command did not complete.");
    }
    await loadIntegrationsRoute(
      context.props,
      context.requestRevision,
      context.setContent,
    );
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback(null);
    toast.success(successMessage);
    return result.kind === "credential_rotation"
      ? { kind: "rotated", receipt: result.receipt }
      : { kind: "revoked", receipt: result.receipt };
  } catch (error) {
    completeSettingsMutation(context.setMutations, mutation);
    return {
      kind: "failed",
      errorKind: error instanceof ControlApiError ? error.kind : "unknown",
      message: settingsMutationProblem(error),
    };
  }
}

async function setDefaultIntegrationAccount(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  await runIntegrationAccountCommand(
    context,
    event,
    "set_default_account",
    "Default account updated.",
  );
}

async function refreshAccountResources(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  await runIntegrationAccountCommand(
    context,
    event,
    "refresh_account_resources",
    "Provider resources refreshed.",
  );
}

async function removeIntegrationAccount(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const data = readyIntegrationsData(context.content);
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (data === null || integrationAccountId === undefined) return;
  const account = data.accounts.find(
    matchesIntegrationAccountId.bind(null, integrationAccountId),
  );
  if (account === undefined) return;
  const kind =
    account.lifecycle.kind === "disabled"
      ? ("remove_account" as const)
      : ("remove_connected_account" as const);
  await runIntegrationsCommand(
    context,
    { kind, integrationAccountId },
    { kind: "integration_account", integrationAccountId },
    account.provider === "slack"
      ? "Slack workspace removed."
      : "Integration removed.",
  );
}

async function runIntegrationAccountCommand(
  context: IntegrationsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
  kind: IntegrationAccountCommandKind,
  successMessage: string,
): Promise<void> {
  const integrationAccountId = event.currentTarget.dataset.accountId;
  if (integrationAccountId === undefined) return;
  await runIntegrationsCommand(
    context,
    buildIntegrationAccountCommand(kind, integrationAccountId),
    { kind: "integration_account", integrationAccountId },
    successMessage,
  );
}

type IntegrationAccountCommandKind =
  "set_default_account" | "refresh_account_resources" | "remove_account";

function matchesIntegrationAccountId(
  integrationAccountId: string,
  account: IntegrationAccount,
): boolean {
  return account.integrationAccountId === integrationAccountId;
}

function buildIntegrationAccountCommand(
  kind: IntegrationAccountCommandKind,
  integrationAccountId: string,
): Variant<IntegrationsCommand, IntegrationAccountCommandKind> {
  switch (kind) {
    case "set_default_account":
      return { kind, integrationAccountId };
    case "refresh_account_resources":
      return { kind, integrationAccountId };
    case "remove_account":
      return { kind, integrationAccountId };
    default:
      return assertNever(kind, "Unexpected settings state");
  }
}

async function activateIntegrationsWorkspace(
  context: IntegrationsRouteMutationContext,
): Promise<void> {
  const data = readyIntegrationsData(context.content);
  if (data?.readiness?.kind !== "ready") return;
  await runIntegrationsCommand(
    context,
    {
      kind: "activate",
      readinessVersion: data.readiness.readinessVersion,
      readinessHash: data.readiness.readinessHash,
    },
    { kind: "activation" },
    "Workspace activated.",
  );
}

async function saveIntegrationsSetup(
  context: IntegrationsRouteMutationContext,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const capabilityProfile = readCapabilityProfile(
    form.get("capabilityProfile"),
  );
  const cuePresetId = readCuePresetId(form.get("cuePresetId"));
  if (capabilityProfile === null || cuePresetId === null) {
    context.setSetupFeedback({
      kind: "error",
      field: "form",
      message: "Choose a valid policy and cue preset.",
    });
    return;
  }
  const selection = buildSetupSelection(form, capabilityProfile, cuePresetId);
  if (!selection.ok) {
    context.setSetupFeedback({ kind: "error", ...selection.error });
    return;
  }
  const data = readyIntegrationsData(context.content);
  const mutation: OrganisationMutation = { kind: "setup" };
  if (
    data === null ||
    !beginSettingsMutation(context.mutations, context.setMutations, mutation)
  )
    return;
  context.setSetupFeedback({ kind: "idle" });
  // The first channel completes the setup. A later one only binds the
  // channel, so the setup, and an active workspace, stay as they are.
  const command: IntegrationsCommand =
    data.setupDefaults.channelId === ""
      ? { kind: "save_setup", selection: selection.value }
      : { kind: "add_slack_channel", cueTarget: selection.value.cueTarget };
  try {
    await context.props.transport.execute(
      context.props.organisationId,
      context.props.organisationHandle,
      context.props.workspaceHandle,
      data.configurationVersion,
      command,
    );
    await loadIntegrationsRoute(
      context.props,
      context.requestRevision,
      context.setContent,
    );
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback(null);
    context.setSetupFeedback({
      kind: "success",
      message: "Channel added.",
    });
    toast.success("Channel added.");
  } catch (error) {
    completeSettingsMutation(context.setMutations, mutation);
    context.setSetupFeedback({
      kind: "error",
      field: "form",
      message: settingsMutationProblem(error),
    });
  }
}

function createWorkspaceMutation(
  context: WorkspaceSettingsRouteMutationContext,
  command: WorkspaceSettingsCommand,
  mutation: OrganisationMutation,
  successMessage: string,
): Promise<void> {
  return runWorkspaceCommand(context, command, mutation, successMessage);
}

async function runWorkspaceCommand(
  context: WorkspaceSettingsRouteMutationContext,
  command: WorkspaceSettingsCommand,
  mutation: OrganisationMutation,
  successMessage: string,
): Promise<void> {
  const data = readyWorkspaceSettingsData(context.content);
  if (
    data === null ||
    !beginSettingsMutation(context.mutations, context.setMutations, mutation)
  )
    return;
  try {
    const result = await context.props.transport.execute(
      context.props.organisationId,
      data.configurationVersion,
      command,
    );
    await loadWorkspaceSettingsRoute(
      context.props,
      context.requestRevision,
      context.setContent,
    );
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback(
      result.kind === "invitation_created"
        ? {
            mutation,
            message:
              "Share this link with the invited person. They must accept it with their Google account.",
            link: { label: "Invitation link", href: result.acceptanceHref },
          }
        : null,
    );
    toast.success(successMessage);
  } catch (error) {
    completeSettingsMutation(context.setMutations, mutation);
    context.setFeedback({ mutation, message: settingsMutationProblem(error) });
  }
}

async function changeWorkspaceMemberRole(
  context: WorkspaceSettingsRouteMutationContext,
  userId: string,
  value: string,
): Promise<void> {
  const role = readControlRole(value);
  if (role === null) return;
  await createWorkspaceMutation(
    context,
    { kind: "change_member_role", userId, role },
    { kind: "member", userId },
    "Team role updated.",
  );
}

async function removeWorkspaceMember(
  context: WorkspaceSettingsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const userId = event.currentTarget.dataset.controlIdentityId;
  if (userId === undefined) return;
  await createWorkspaceMutation(
    context,
    { kind: "remove_member", userId },
    { kind: "member", userId },
    "Team member removed.",
  );
}

async function revokeWorkspaceInvitation(
  context: WorkspaceSettingsRouteMutationContext,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const invitationId = event.currentTarget.dataset.invitationId;
  if (invitationId === undefined) return;
  await createWorkspaceMutation(
    context,
    { kind: "revoke_invitation", invitationId },
    { kind: "invitation", invitationId },
    "Invitation revoked.",
  );
}

async function inviteWorkspaceMember(
  context: WorkspaceSettingsRouteMutationContext,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const email = form.get("email");
  const role = readAssignableControlRole(form.get("role"));
  if (typeof email !== "string" || email.trim().length === 0 || role === null) {
    context.setFeedback({
      mutation: { kind: "invite_member" },
      message: "Enter a valid email and team role.",
    });
    return;
  }
  await createWorkspaceMutation(
    context,
    { kind: "invite_member", email: email.trim(), role },
    { kind: "invite_member" },
    `Invitation created for ${email.trim().toLowerCase()}.`,
  );
}

function beginSettingsMutation(
  mutations: MutationLedger,
  setMutations: React.Dispatch<React.SetStateAction<MutationLedger>>,
  mutation: OrganisationMutation,
): boolean {
  const result = mutations.add(mutation);
  if (result.kind !== "added") return false;
  setMutations(result.ledger);
  return true;
}

function completeSettingsMutation(
  setMutations: React.Dispatch<React.SetStateAction<MutationLedger>>,
  mutation: OrganisationMutation,
): void {
  setMutations(removeSettingsMutation.bind(null, mutation));
}

function removeSettingsMutation(
  mutation: OrganisationMutation,
  ledger: MutationLedger,
): MutationLedger {
  return ledger.remove(mutation);
}

export function readyIntegrationsData(
  content: SettingsRouteContent<IntegrationsRouteData>,
): IntegrationsRouteData | null {
  return content.kind === "ready" ? content.data : null;
}

function readyWorkspaceSettingsData(
  content: SettingsRouteContent<WorkspaceSettingsRouteData>,
): WorkspaceSettingsRouteData | null {
  return content.kind === "ready" ? content.data : null;
}

function setCommerceSyncProblem(
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >,
  problem: string,
): void {
  setContent(updateCommerceSyncProblem.bind(null, problem));
}

function updateCommerceSyncProblem(
  problem: string,
  content: SettingsRouteContent<IntegrationsRouteData>,
): SettingsRouteContent<IntegrationsRouteData> {
  return content.kind === "ready"
    ? { ...content, data: { ...content.data, commerceSyncProblem: problem } }
    : content;
}

function settingsMutationProblem(error: unknown): string {
  return error instanceof ControlApiError
    ? error.message
    : "This change could not be saved. Try again.";
}

export function requestSettingsConfirm(
  setPendingConfirm: React.Dispatch<React.SetStateAction<string | null>>,
  timer: SettingsConfirmTimer,
  key: string,
): void {
  if (timer.current !== null) window.clearTimeout(timer.current);
  setPendingConfirm(key);
  timer.current = window.setTimeout(
    clearPendingSettingsConfirm.bind(null, setPendingConfirm, timer, key),
    5_000,
  );
}

function clearPendingSettingsConfirm(
  setPendingConfirm: React.Dispatch<React.SetStateAction<string | null>>,
  timer: SettingsConfirmTimer,
  key: string,
): void {
  setPendingConfirm(clearMatchingPendingConfirm.bind(null, key));
  timer.current = null;
}

function clearMatchingPendingConfirm(
  key: string,
  current: string | null,
): string | null {
  return current === key ? null : current;
}

function clearSettingsConfirmTimer(timer: SettingsConfirmTimer): void {
  if (timer.current !== null) window.clearTimeout(timer.current);
  timer.current = null;
}

export function settingsConfirmCleanup(timer: SettingsConfirmTimer): () => void {
  return clearSettingsConfirmTimer.bind(null, timer);
}

export function beginIntegrationsRouteLoad(
  props: IntegrationsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >,
  setFeedback: React.Dispatch<React.SetStateAction<SettingsMutationFeedback>>,
): () => void {
  setFeedback(null);
  void loadIntegrationsRoute(props, requestRevision, setContent);
  return invalidateSettingsRouteRequest.bind(null, requestRevision);
}

export function retryIntegrationsRoute(
  props: IntegrationsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >,
  setFeedback: React.Dispatch<React.SetStateAction<SettingsMutationFeedback>>,
): void {
  setFeedback(null);
  void loadIntegrationsRoute(props, requestRevision, setContent);
}
