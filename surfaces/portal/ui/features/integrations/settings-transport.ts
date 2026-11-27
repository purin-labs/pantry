import {
  controlRead,
  lastControlRead,
  controlMutation,
  controlSecretMutation,
} from "@purin-labs/control/portal/control-client";
import { accountInvitationHref } from "@purin-labs/area-organisation/ui/pages/account-invitation-link";
import { setUpMailbox } from "@purin-labs/area-inbox/ui/features/mail-setup/turn-on";
import type { IntegrationDetailReadContext, IntegrationDetailRouteData, IntegrationsCommand, IntegrationsCommandResult, IntegrationsRouteData, WorkspaceSettingsCommand, WorkspaceSettingsRouteData, WorkspaceSettingsCommandResult } from "@purin-labs/area-integrations-contract/ui/features/integrations/settings-types";
import type { OrganisationCodexConnection, OrganisationInferenceSelection } from "@purin-labs/control-api/portal/settings";
import {
  codexConnectionPath,
  commerceSystemPath,
  inferencePath,
  organisationRecordPath,
} from "@purin-labs/control/portal/control-paths";
import { parseWhatsAppSurface, type WhatsAppSurface } from "@purin-labs/control-api/portal/whatsapp";
import { whatsappAccountActionPath, whatsappAccountsPath } from "@purin-labs/area-inbox-contract/ui/whatsapp";
import { parseCredentialRotationReceiptResponse } from "@purin-labs/control-api/portal/credential-inventory";
import {
  assertNever,
  isNonEmptyString,
  isRecord,
} from "@purin-labs/std";
import { codexAuthorizationResult, fetchCredentialInventory, fetchOrganisationCodexConnection, fetchOrganisationInferenceSelection, isOrganisationApiKeyInferenceCommand } from "./codex-transport";
import { parseOrganisationCodexConnectionResponse, parseOrganisationInferenceSelectionResponse } from "@purin-labs/control-api/portal/codex";
import {
  agentMailboxPath,
  emailOperationalPath,
  emailReplyPath,
  fetchAgentMailboxSurface,
} from "./mailbox-transport";
import { setupFormDefaults } from "../../portal-projection";
import { beginExistingProviderConnection, beginProviderConnection, bindSetupChannel, fetchCommerceSystem, fetchOrganisationInvitations, fetchOrganisationMembers, fetchOrganisationSnapshot, fetchSlackDestinations, fetchSlackRouting, fetchSupportDiagnostics, provisionPantryCommerceDemo, publishExportCoordination, queueCommerceSystemSync, readConfigurationVersionFromMutation, selectShopifyCommerceSystem } from "../../portal-reads";
import { parseCommerceSystemResponse, parseOrganisationSnapshot } from "@purin-labs/control-api/portal/portal-reads";
import { MAILBOX_SETUP_TRANSPORT } from "../../portal-support";
import type { CommerceSystemView, OrganisationSnapshot } from "@purin-labs/control-api/portal/portal-types";

export async function readIntegrationsOverview(
  organisationId: string,
): Promise<IntegrationsRouteData> {
  // None of the four reads needs another's result.
  const [snapshot, commerceSystem, codexConnection, inferenceSelection] =
    await Promise.all([
      fetchOrganisationSnapshot(organisationId),
      fetchCommerceSystem(organisationId),
      fetchOrganisationCodexConnection(organisationId),
      fetchOrganisationInferenceSelection(organisationId),
    ]);
  return integrationsOverviewData(
    snapshot,
    commerceSystem,
    codexConnection,
    inferenceSelection,
  );
}

/**
 * The overview that an earlier visit read in this tab, or null. The page
 * shows it only while it reads the four records again.
 */
export function lastIntegrationsOverview(
  organisationId: string,
): IntegrationsRouteData | null {
  const snapshot = lastControlRead(organisationRecordPath(organisationId));
  const commerceSystem = lastControlRead(commerceSystemPath(organisationId));
  const codexConnection = lastControlRead(codexConnectionPath(organisationId));
  const inferenceSelection = lastControlRead(inferencePath(organisationId));
  if (
    snapshot === undefined ||
    commerceSystem === undefined ||
    codexConnection === undefined ||
    inferenceSelection === undefined
  )
    return null;
  try {
    return integrationsOverviewData(
      parseOrganisationSnapshot(snapshot),
      parseCommerceSystemResponse(commerceSystem),
      parseOrganisationCodexConnectionResponse(codexConnection),
      parseOrganisationInferenceSelectionResponse(inferenceSelection),
    );
  } catch {
    return null;
  }
}

function integrationsOverviewData(
  snapshot: OrganisationSnapshot,
  commerceSystem: CommerceSystemView | null,
  codexConnection: OrganisationCodexConnection,
  inferenceSelection: OrganisationInferenceSelection,
): IntegrationsRouteData {
  return {
    commerceSystem,
    commerceSyncProblem: null,
    codexConnection,
    inferenceSelection,
    accounts: snapshot.accounts,
    supportReference: snapshot.supportReference,
    whatsappApplicationConfigured: null,
    setupDefaults: setupFormDefaults(
      snapshot.organisation.capabilityProfile,
      snapshot.setupSelection,
      snapshot.accounts,
    ),
    readiness: snapshot.readiness,
    activation: snapshot.activation,
    firstTask: snapshot.firstTask,
    organisationIsActive: snapshot.organisation.lifecycle === "active",
    configurationVersion: snapshot.configurationVersion,
  };
}

export async function readIntegrationDetail(
  organisationId: string,
  context: IntegrationDetailReadContext,
): Promise<IntegrationDetailRouteData> {
  const credentialInventory = integrationUsesCredentialInventory(
    context.integrationId,
  )
    ? readOptionalCredentialInventory(organisationId)
    : Promise.resolve(null);
  const supportDiagnostics = readOptionalSupportDiagnostics(
    organisationId,
    context.supportReference,
  );
  const common = Promise.all([credentialInventory, supportDiagnostics]);
  switch (context.integrationId) {
    case "slack": {
      const [[credentials, support], destinations, slackRouting] =
        await Promise.all([
          common,
          fetchSlackDestinations(organisationId, context.accounts),
          fetchSlackRouting(organisationId),
        ]);
      return {
        ...emptyIntegrationDetailRouteData(credentials, support),
        destinations,
        slackRouting,
      };
    }
    case "gmail": {
      const [[credentials, support], mailboxSurface] = await Promise.all([
        common,
        fetchAgentMailboxSurface(
          organisationId,
          context.accounts,
          context.organisationIsActive,
        ),
      ]);
      return {
        ...emptyIntegrationDetailRouteData(credentials, support),
        agentMailboxes: mailboxSurface.agentMailboxes,
        emailReplies: mailboxSurface.emailReplies,
        emailOperational: mailboxSurface.emailOperational,
        mailboxInstallations: mailboxSurface.mailboxInstallations,
      };
    }
    case "whatsapp": {
      const [[credentials, support], whatsapp] = await Promise.all([
        common,
        fetchWhatsAppSurface(organisationId),
      ]);
      return {
        ...emptyIntegrationDetailRouteData(credentials, support),
        whatsapp,
      };
    }
    case "airtable":
    case "dropbox":
    case "google_drive":
    case "notion":
    case "shopify":
    case "square":
    case "stripe": {
      const [credentials, support] = await common;
      return emptyIntegrationDetailRouteData(credentials, support);
    }
    case "codex":
    case "typesafe":
    case "onepassword":
    case "commerce": {
      const [, support] = await common;
      return emptyIntegrationDetailRouteData(null, support);
    }
    default:
      return assertNever(context.integrationId, "Unexpected portal state");
  }
}

async function readOptionalCredentialInventory(
  organisationId: string,
): Promise<IntegrationDetailRouteData["credentialInventory"]> {
  try {
    return await fetchCredentialInventory(organisationId);
  } catch {
    return null;
  }
}

async function readOptionalSupportDiagnostics(
  organisationId: string,
  supportReference: string | null,
): Promise<IntegrationDetailRouteData["supportDiagnostics"]> {
  if (supportReference === null) return null;
  try {
    return await fetchSupportDiagnostics(organisationId, supportReference);
  } catch {
    return null;
  }
}

function integrationUsesCredentialInventory(
  integrationId: IntegrationDetailReadContext["integrationId"],
): boolean {
  return (
    integrationId !== "codex" &&
    integrationId !== "commerce" &&
    integrationId !== "typesafe" &&
    integrationId !== "onepassword"
  );
}

function emptyIntegrationDetailRouteData(
  credentialInventory: IntegrationDetailRouteData["credentialInventory"],
  supportDiagnostics: IntegrationDetailRouteData["supportDiagnostics"],
): IntegrationDetailRouteData {
  return {
    destinations: [],
    slackRouting: [],
    supportDiagnostics,
    credentialInventory,
    agentMailboxes: [],
    emailReplies: [],
    emailOperational: [],
    mailboxInstallations: [],
    whatsapp: {
      applicationConfigured: false,
      accounts: [],
      replies: [],
    },
  };
}

export async function readWorkspaceSettingsRoute(
  organisationId: string,
): Promise<WorkspaceSettingsRouteData> {
  const [snapshot, members, invitations] = await Promise.all([
    fetchOrganisationSnapshot(organisationId),
    fetchOrganisationMembers(organisationId),
    fetchOrganisationInvitations(organisationId),
  ]);
  return {
    members,
    invitations,
    lifecycle: snapshot.organisation.lifecycle,
    configurationVersion: snapshot.configurationVersion,
  };
}

export async function executeIntegrationsRoute(
  organisationId: string,
  organisationHandle: string,
  workspaceHandle: string,
  configurationVersion: number,
  command: IntegrationsCommand,
): Promise<IntegrationsCommandResult> {
  switch (command.kind) {
    case "sync_commerce":
      await queueCommerceSystemSync(organisationId);
      return { kind: "completed" };
    case "provision_commerce":
      await provisionPantryCommerceDemo(organisationId);
      return { kind: "completed" };
    case "publish_export_coordination":
      await publishExportCoordination(organisationId, configurationVersion);
      return { kind: "completed" };
    case "select_shopify":
      await selectShopifyCommerceSystem(
        organisationId,
        command.integrationAccountId,
        command.expectedRevision,
      );
      return { kind: "completed" };
    case "connect_slack":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "slack",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_stripe":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "stripe",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_square":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "square",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_shopify":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "shopify",
            { shopDomain: command.shopDomain },
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_airtable":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "airtable",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_dropbox":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "dropbox",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_gmail":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "gmail",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_gmail_send_only":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "gmail",
            { authorizationProduct: "send_only" },
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_google_drive":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "google_drive",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_whatsapp":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "whatsapp",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_notion":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            "notion",
            {},
            configurationVersion,
          )
        ).authorizationUrl,
      };
    case "connect_codex":
      return codexAuthorizationResult(
        await controlMutation(
          `/v1/control/organisations/${encodeURIComponent(organisationId)}/inference/codex/authorizations`,
          "POST",
          {},
        ),
      );
    case "reconnect_codex":
      return codexAuthorizationResult(
        await controlMutation(
          `/v1/control/organisations/${encodeURIComponent(organisationId)}/inference/codex/reconnect`,
          "POST",
          {},
        ),
      );
    case "complete_codex_authorization":
      // The address holds a one-time code: send it as a secret.
      await controlSecretMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/inference/codex/authorizations/${encodeURIComponent(command.attemptId)}/complete`,
        "POST",
        { callbackUrl: command.callbackUrl },
      );
      return { kind: "completed" };
    case "cancel_codex_authorization":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/inference/codex/authorizations/${encodeURIComponent(command.attemptId)}/cancel`,
        "POST",
        {},
      );
      return { kind: "completed" };
    case "disconnect_codex":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/inference/codex`,
        "DELETE",
        {},
      );
      return { kind: "completed" };
    case "select_inference":
      if (isOrganisationApiKeyInferenceCommand(command)) {
        await controlSecretMutation(
          `/v1/control/organisations/${encodeURIComponent(organisationId)}/inference`,
          "PUT",
          { selection: command.selection, apiKey: command.apiKey },
          configurationVersion,
        );
      } else {
        await controlMutation(
          `/v1/control/organisations/${encodeURIComponent(organisationId)}/inference`,
          "PUT",
          { selection: command.selection },
          configurationVersion,
        );
      }
      return { kind: "completed" };
    case "disable_account":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(command.integrationAccountId)}/disable`,
        "POST",
        {},
        configurationVersion,
      );
      return { kind: "completed" };
    case "reconnect_account":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginExistingProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            command.integrationAccountId,
            configurationVersion,
            "reconnect",
          )
        ).authorizationUrl,
      };
    case "rotate_account":
      return {
        kind: "authorization",
        authorizationUrl: (
          await beginExistingProviderConnection(
            organisationId,
            organisationHandle,
            workspaceHandle,
            command.integrationAccountId,
            configurationVersion,
            "rotate",
          )
        ).authorizationUrl,
      };
    case "set_default_account":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(command.integrationAccountId)}/default-for-provider`,
        "POST",
        {},
        configurationVersion,
      );
      return { kind: "completed" };
    case "refresh_account_resources":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(command.integrationAccountId)}/resources/refresh`,
        "POST",
        {},
        configurationVersion,
      );
      return { kind: "completed" };
    case "select_slack_dm_organisation":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/slack-routing/installations/${encodeURIComponent(command.installationId)}/dm-selection`,
        "POST",
        {},
        undefined,
      );
      return { kind: "completed" };
    case "remove_connected_account": {
      const accountPath = `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(command.integrationAccountId)}`;
      const disabled = await controlMutation(
        `${accountPath}/disable`,
        "POST",
        {},
        configurationVersion,
      );
      await controlMutation(
        accountPath,
        "DELETE",
        {},
        readConfigurationVersionFromMutation(disabled),
      );
      return { kind: "completed" };
    }
    case "remove_account":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(command.integrationAccountId)}`,
        "DELETE",
        {},
        configurationVersion,
      );
      return { kind: "completed" };
    case "activate":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/activate`,
        "POST",
        {
          readinessVersion: command.readinessVersion,
          readinessHash: command.readinessHash,
        },
        configurationVersion,
      );
      return { kind: "completed" };
    case "add_slack_channel":
      await bindSetupChannel(organisationId, command.cueTarget);
      return { kind: "completed" };
    case "save_setup": {
      // The channel binding goes first. The setup save advances the
      // configuration version, so a binding that failed after it would leave
      // this page with a stale version and refuse every retry.
      await bindSetupChannel(organisationId, command.selection.cueTarget);
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/setup`,
        "PUT",
        command.selection,
        configurationVersion,
      );
      return { kind: "completed" };
    }
    case "rotate_credential":
      return {
        kind: "credential_rotation",
        receipt: parseCredentialRotationReceiptResponse(
          await controlSecretMutation(
            `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(command.integrationAccountId)}/credential-rotations`,
            "POST",
            { replacementSecret: command.replacementSecret },
            configurationVersion,
          ),
        ),
      };
    /* Mailbox and reply routes use the unversioned mutation boundary, so no
     * configuration version accompanies them. */
    case "set_up_mailbox": {
      const target = {
        organisationId,
        integrationAccountId: command.integrationAccountId,
      };
      await setUpMailbox(
        MAILBOX_SETUP_TRANSPORT,
        target,
        command.agent,
        command.turnOn,
        command.accepted,
      );
      return { kind: "completed" };
    }
    case "resume_mailbox":
      await controlMutation(
        `${agentMailboxPath(organisationId, command.integrationAccountId)}/resume`,
        "POST",
        {},
      );
      return { kind: "completed" };
    case "reconnect_mailbox":
      await controlMutation(
        `${agentMailboxPath(organisationId, command.integrationAccountId)}/reconnect`,
        "POST",
        {},
      );
      return { kind: "completed" };
    case "disable_mailbox":
      await controlMutation(
        `${agentMailboxPath(organisationId, command.integrationAccountId)}/disable`,
        "POST",
        {},
      );
      return { kind: "completed" };
    case "revoke_mailbox":
      await controlMutation(
        `${agentMailboxPath(organisationId, command.integrationAccountId)}/revoke`,
        "POST",
        {},
        configurationVersion,
      );
      return { kind: "completed" };
    case "skip_and_resume_mailbox":
      await controlMutation(
        `${agentMailboxPath(organisationId, command.integrationAccountId)}/skip-and-resume`,
        "POST",
        { providerMessageId: command.providerMessageId },
      );
      return { kind: "completed" };
    case "approve_email_reply":
      await controlMutation(
        `${emailReplyPath(organisationId, command.proposalId)}/approve`,
        "POST",
        {
          version: command.version,
          snapshotDigest: command.snapshotDigest,
          challenge: command.challenge,
        },
      );
      return { kind: "completed" };
    case "reject_email_reply":
      await controlMutation(
        `${emailReplyPath(organisationId, command.proposalId)}/reject`,
        "POST",
        {},
      );
      return { kind: "completed" };
    case "resolve_email_reply":
      await controlMutation(
        `${emailReplyPath(organisationId, command.proposalId)}/resolve`,
        "POST",
        { dispatchVersion: command.dispatchVersion },
      );
      return { kind: "completed" };
    case "approve_email_operational":
      await controlMutation(
        `${emailOperationalPath(organisationId, command.proposalId)}/approve`,
        "POST",
        {
          version: command.version,
          snapshotDigest: command.snapshotDigest,
          challenge: command.challenge,
          ...(command.selfTestOwnershipConfirmed === true
            ? { selfTestOwnershipConfirmed: true }
            : {}),
        },
      );
      return { kind: "completed" };
    case "reject_email_operational":
      await controlMutation(
        `${emailOperationalPath(organisationId, command.proposalId)}/reject`,
        "POST",
        {},
      );
      return { kind: "completed" };
    case "edit_email_operational":
      await controlMutation(
        `${emailOperationalPath(organisationId, command.proposalId)}/edit`,
        "POST",
        { subject: command.subject, body: command.body },
      );
      return { kind: "completed" };
    case "attest_email_operational":
      await controlMutation(
        `${emailOperationalPath(organisationId, command.proposalId)}/attest-${command.attestation}`,
        "POST",
        {},
      );
      return { kind: "completed" };
    default:
      return assertNever(command, "Unexpected portal state");
  }
}

/**
 * Connecting WhatsApp goes through the shared provider-connection command so
 * it reuses the mutation ledger, the authorization popup, and the completion
 * listener. The panel calls that action directly, so this transport entry is
 * never invoked.
 */
export async function notImplementedWhatsAppConnect(): Promise<void> {
  throw new Error("Use the Connect WhatsApp action on the integrations page.");
}

export async function runWhatsAppAccountAction(
  organisationId: string,
  integrationAccountId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<void> {
  await controlMutation(
    whatsappAccountActionPath(organisationId, integrationAccountId, action),
    "POST",
    body,
  );
}

async function fetchWhatsAppSurface(
  organisationId: string,
): Promise<WhatsAppSurface> {
  // Reply approvals moved to the Inbox (Plan 83), so this page reads no queue.
  return parseWhatsAppSurface(
    await controlRead(whatsappAccountsPath(organisationId)),
    { ok: true, proposals: [] },
  );
}

export async function executeWorkspaceSettingsRoute(
  organisationId: string,
  configurationVersion: number,
  command: WorkspaceSettingsCommand,
): Promise<WorkspaceSettingsCommandResult> {
  switch (command.kind) {
    case "change_member_role":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/members/${encodeURIComponent(command.userId)}`,
        "PATCH",
        { role: command.role },
        configurationVersion,
      );
      return { kind: "applied" };
    case "remove_member":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/members/${encodeURIComponent(command.userId)}`,
        "DELETE",
        {},
        configurationVersion,
      );
      return { kind: "applied" };
    case "revoke_invitation":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/invitations/${encodeURIComponent(command.invitationId)}/revoke`,
        "POST",
        {},
        configurationVersion,
      );
      return { kind: "applied" };
    case "invite_member": {
      const raw = await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/invitations`,
        "POST",
        { email: command.email, role: command.role },
        configurationVersion,
      );
      if (
        !isRecord(raw) ||
        raw.ok !== true ||
        !isRecord(raw.invitation) ||
        !isNonEmptyString(raw.invitation.organisationInvitationId)
      ) {
        throw new Error("Pantry did not return an invitation link.");
      }
      // Pantry shows a link one time. An open invitation of the email
      // answers without it, and a revoke makes a new link possible.
      if (!isNonEmptyString(raw.token)) return { kind: "invitation_open" };
      return {
        kind: "invitation_created",
        acceptanceHref: accountInvitationHref(
          organisationId,
          raw.invitation.organisationInvitationId,
          raw.token,
        ),
      };
    }
    case "archive_workspace":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/archive`,
        "POST",
        {},
        configurationVersion,
      );
      return { kind: "applied" };
    case "restore_workspace":
      await controlMutation(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/restore`,
        "POST",
        {},
        configurationVersion,
      );
      return { kind: "applied" };
    default:
      return assertNever(command, "Unexpected portal state");
  }
}
