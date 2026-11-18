import type { Env } from "../../env";
import type { OnboardingProvider } from "../../provider-lifecycle/domain";
import { assertNever } from "@seams/std";
import {
  handleAccounts,
  handleDefaultAccount,
  handleDisableAccount,
  handleRemoveAccount,
} from "./integrations/accounts";
import {
  handleCredentialInventory,
  handleRevokeAccountCredential,
  handleRotateAccountCredentialSupplied,
} from "./integrations/credentials";
import { handleProviderCallback } from "./integrations/provider-callback";
import {
  handleCancelProviderAttempt,
  handleExistingAccountProviderStart,
  handleProviderAttempt,
  handleProviderStart,
} from "./integrations/provider-start";
import {
  handleAccountDrivePickerConfig,
  handleAccountFileResources,
  handleAccountResources,
  handleRefreshAccountResources,
} from "./integrations/resources";
import {
  handleDisconnectSlackInstallation,
  handleSlackChannelDefault,
  handleSlackDmSelection,
  handleSlackRouting,
} from "./integrations/slack";

export type IntegrationControlRoute =
  | Readonly<{ kind: "accounts"; organisationIdRaw: string }>
  | Readonly<{ kind: "slackRouting"; organisationIdRaw: string }>
  | Readonly<{
      kind: "slackChannelDefault";
      organisationIdRaw: string;
      installationIdRaw: string;
      channelIdRaw: string;
    }>
  | Readonly<{
      kind: "slackDmSelection";
      organisationIdRaw: string;
      installationIdRaw: string;
    }>
  | Readonly<{
      kind: "disconnectSlackInstallation";
      organisationIdRaw: string;
      installationIdRaw: string;
    }>
  | Readonly<{ kind: "credentialInventory"; organisationIdRaw: string }>
  | Readonly<{
      kind: "revokeAccountCredential";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "rotateAccountCredentialSupplied";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "disableAccount";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "reconnectAccount";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "rotateAccount";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "defaultAccount";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "accountResources";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "accountFileResources";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "accountDrivePickerConfig";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "refreshAccountResources";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "removeAccount";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "providerStart";
      organisationIdRaw: string;
      provider: OnboardingProvider;
    }>
  | Readonly<{
      kind: "providerAttempt";
      organisationIdRaw: string;
      attemptIdRaw: string;
    }>
  | Readonly<{
      kind: "cancelProviderAttempt";
      organisationIdRaw: string;
      attemptIdRaw: string;
    }>
  | Readonly<{ kind: "providerCallback"; provider: OnboardingProvider }>;

export function matchIntegrationControlRoute(
  pathname: string,
): IntegrationControlRoute | null {
  const callback =
    /^\/v1\/control\/providers\/(airtable|notion|slack|stripe|square|shopify|gmail|whatsapp|dropbox|google_drive)\/callback$/u.exec(
      pathname,
    );
  if (callback?.[1] !== undefined)
    return { kind: "providerCallback", provider: provider(callback[1]) };
  const start =
    /^\/v1\/control\/organisations\/([^/]+)\/providers\/(airtable|notion|slack|stripe|square|shopify|gmail|whatsapp|dropbox|google_drive)\/start$/u.exec(
      pathname,
    );
  if (start?.[1] !== undefined && start[2] !== undefined) {
    return {
      kind: "providerStart",
      organisationIdRaw: decodeURIComponent(start[1]),
      provider: provider(start[2]),
    };
  }
  const cancelAttempt = two(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/provider-attempts\/([^/]+)\/cancel$/u,
  );
  if (cancelAttempt !== null)
    return {
      kind: "cancelProviderAttempt",
      organisationIdRaw: cancelAttempt.organisationIdRaw,
      attemptIdRaw: cancelAttempt.valueRaw,
    };
  const attempt = two(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/provider-attempts\/([^/]+)$/u,
  );
  if (attempt !== null)
    return {
      kind: "providerAttempt",
      organisationIdRaw: attempt.organisationIdRaw,
      attemptIdRaw: attempt.valueRaw,
    };
  const credentialInventory = organisation(pathname, "credentials");
  if (credentialInventory !== null)
    return {
      kind: "credentialInventory",
      organisationIdRaw: credentialInventory,
    };
  const disconnectSlackInstallation = two(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/slack-routing\/installations\/([^/]+)\/disconnect$/u,
  );
  if (disconnectSlackInstallation !== null) {
    return {
      kind: "disconnectSlackInstallation",
      organisationIdRaw: disconnectSlackInstallation.organisationIdRaw,
      installationIdRaw: disconnectSlackInstallation.valueRaw,
    };
  }
  const slackDmSelection = two(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/slack-routing\/installations\/([^/]+)\/dm-selection$/u,
  );
  if (slackDmSelection !== null) {
    return {
      kind: "slackDmSelection",
      organisationIdRaw: slackDmSelection.organisationIdRaw,
      installationIdRaw: slackDmSelection.valueRaw,
    };
  }
  const slackChannelDefault =
    /^\/v1\/control\/organisations\/([^/]+)\/slack-routing\/installations\/([^/]+)\/channels\/([^/]+)$/u.exec(
      pathname,
    );
  if (
    slackChannelDefault?.[1] !== undefined &&
    slackChannelDefault[2] !== undefined &&
    slackChannelDefault[3] !== undefined
  ) {
    return {
      kind: "slackChannelDefault",
      organisationIdRaw: decodeURIComponent(slackChannelDefault[1]),
      installationIdRaw: decodeURIComponent(slackChannelDefault[2]),
      channelIdRaw: decodeURIComponent(slackChannelDefault[3]),
    };
  }
  const slackRouting = organisation(pathname, "slack-routing");
  if (slackRouting !== null) {
    return { kind: "slackRouting", organisationIdRaw: slackRouting };
  }
  const accountRoutes: readonly Readonly<{
    suffix: string;
    kind: AccountRouteKind;
  }>[] = [
    { suffix: "revoke-credential", kind: "revokeAccountCredential" },
    { suffix: "credential-rotations", kind: "rotateAccountCredentialSupplied" },
    { suffix: "disable", kind: "disableAccount" },
    { suffix: "reconnect", kind: "reconnectAccount" },
    { suffix: "rotate", kind: "rotateAccount" },
    { suffix: "default-for-provider", kind: "defaultAccount" },
    { suffix: "resources/refresh", kind: "refreshAccountResources" },
    { suffix: "resources", kind: "accountResources" },
    { suffix: "file-resources", kind: "accountFileResources" },
    { suffix: "google-drive-picker-config", kind: "accountDrivePickerConfig" },
  ];
  for (const route of accountRoutes) {
    const result = account(pathname, route.suffix);
    if (result !== null) return { kind: route.kind, ...result };
  }
  const remove = two(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/accounts\/([^/]+)$/u,
  );
  if (remove !== null)
    return {
      kind: "removeAccount",
      organisationIdRaw: remove.organisationIdRaw,
      integrationAccountIdRaw: remove.valueRaw,
    };
  const accounts = organisation(pathname, "accounts");
  return accounts === null
    ? null
    : { kind: "accounts", organisationIdRaw: accounts };
}

export type AccountRouteKind =
  | "revokeAccountCredential"
  | "rotateAccountCredentialSupplied"
  | "disableAccount"
  | "reconnectAccount"
  | "rotateAccount"
  | "defaultAccount"
  | "accountResources"
  | "accountFileResources"
  | "accountDrivePickerConfig"
  | "refreshAccountResources";

export function account(
  pathname: string,
  suffix: string,
): Readonly<{
  organisationIdRaw: string;
  integrationAccountIdRaw: string;
}> | null {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = two(
    pathname,
    new RegExp(
      `^/v1/control/organisations/([^/]+)/accounts/([^/]+)/${escaped}$`,
      "u",
    ),
  );
  return value === null
    ? null
    : {
        organisationIdRaw: value.organisationIdRaw,
        integrationAccountIdRaw: value.valueRaw,
      };
}

export function organisation(pathname: string, suffix: string): string | null {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const result = new RegExp(
    `^/v1/control/organisations/([^/]+)/${escaped}$`,
    "u",
  ).exec(pathname);
  return result?.[1] === undefined ? null : decodeURIComponent(result[1]);
}

export function two(
  pathname: string,
  pattern: RegExp,
): Readonly<{ organisationIdRaw: string; valueRaw: string }> | null {
  const result = pattern.exec(pathname);
  return result?.[1] === undefined || result[2] === undefined
    ? null
    : {
        organisationIdRaw: decodeURIComponent(result[1]),
        valueRaw: decodeURIComponent(result[2]),
      };
}

export function provider(value: string): OnboardingProvider {
  switch (value) {
    case "airtable":
    case "dropbox":
    case "notion":
    case "slack":
    case "stripe":
    case "square":
    case "shopify":
    case "gmail":
    case "google_drive":
    case "whatsapp":
      return value;
    default:
      throw new Error("Integration control route provider is invalid");
  }
}

export function handleIntegrationControlRoute(
  request: Request,
  env: Env,
  route: IntegrationControlRoute,
  url: URL,
): Promise<Response> {
  switch (route.kind) {
    case "accounts":
      return handleAccounts(request, env, route.organisationIdRaw);
    case "slackRouting":
      return handleSlackRouting(request, env, route.organisationIdRaw);
    case "slackChannelDefault":
      return handleSlackChannelDefault(
        request,
        env,
        route.organisationIdRaw,
        route.installationIdRaw,
        route.channelIdRaw,
      );
    case "slackDmSelection":
      return handleSlackDmSelection(
        request,
        env,
        route.organisationIdRaw,
        route.installationIdRaw,
      );
    case "disconnectSlackInstallation":
      return handleDisconnectSlackInstallation(
        request,
        env,
        route.organisationIdRaw,
        route.installationIdRaw,
      );
    case "credentialInventory":
      return handleCredentialInventory(request, env, route.organisationIdRaw);
    case "revokeAccountCredential":
      return handleRevokeAccountCredential(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "rotateAccountCredentialSupplied":
      return handleRotateAccountCredentialSupplied(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "disableAccount":
      return handleDisableAccount(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "reconnectAccount":
      return handleExistingAccountProviderStart(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
        "reconnect",
      );
    case "rotateAccount":
      return handleExistingAccountProviderStart(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
        "rotate",
      );
    case "defaultAccount":
      return handleDefaultAccount(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "accountResources":
      return handleAccountResources(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "accountFileResources":
      return handleAccountFileResources(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "accountDrivePickerConfig":
      return handleAccountDrivePickerConfig(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "refreshAccountResources":
      return handleRefreshAccountResources(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "removeAccount":
      return handleRemoveAccount(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "providerStart":
      return handleProviderStart(
        request,
        env,
        route.organisationIdRaw,
        route.provider,
      );
    case "providerAttempt":
      return handleProviderAttempt(
        request,
        env,
        route.organisationIdRaw,
        route.attemptIdRaw,
      );
    case "cancelProviderAttempt":
      return handleCancelProviderAttempt(
        request,
        env,
        route.organisationIdRaw,
        route.attemptIdRaw,
      );
    case "providerCallback":
      return handleProviderCallback(request, env, url, route.provider);
    default:
      return assertNever(route);
  }
}
