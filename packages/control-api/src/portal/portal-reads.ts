import type {
  SlackRoutingConnection,
  ProviderResource,
  SupportDiagnostics,
} from "./settings.ts";
import {
  assertNever,
  isRecord,
  nonNegativeIntegerOrNull,
  positiveIntegerOrNull,
} from "@purin-labs/std";
import {
  parseProjectedActivation,
  parseProjectedFirstTask,
  parseProjectedIntegrationAccount,
  parseProjectedNextAction,
  parseProjectedOperatingProfile,
  parseProjectedOrganisationSummary,
  parseProjectedReadiness,
  parseProjectedSteps,
} from "./portal-projection.ts";
import { readApiError } from "./api-error.ts";
import type {
  CommerceSystemSyncView,
  CommerceSystemView,
  OperatorOrganisationCase,
  OrganisationSnapshot,
  SupportRole,
} from "./portal-types.ts";
import { parseOrganisationEnvironment } from "./organisation-environment.ts";

export function parseSupportRole(raw: unknown): SupportRole | null {
  if (raw === null) return null;
  if (raw === "support_agent" || raw === "support_admin") return raw;
  throw new Error("Control support role is invalid.");
}

export function parseOrganisationSnapshot(raw: unknown): OrganisationSnapshot {
  if (
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    typeof raw.projection_revision !== "number" ||
    typeof raw.configuration_version !== "number" ||
    !isRecord(raw.organisation) ||
    !Array.isArray(raw.steps) ||
    !Array.isArray(raw.provider_accounts) ||
    !isRecord(raw.operating_profile) ||
    !isRecord(raw.readiness) ||
    !isRecord(raw.activation) ||
    !isRecord(raw.next_action) ||
    !(raw.first_task === null || isRecord(raw.first_task))
  ) {
    throw new Error(readApiError(raw));
  }
  const organisation = parseProjectedOrganisationSummary(raw.organisation);
  return {
    organisation,
    steps: parseProjectedSteps(raw.steps),
    setupSelection: parseProjectedOperatingProfile(
      raw.operating_profile,
      organisation.capabilityProfile,
    ),
    accounts: raw.provider_accounts.map(parseProjectedIntegrationAccount),
    readiness: parseProjectedReadiness(raw.readiness),
    activation: parseProjectedActivation(raw.activation),
    nextAction: parseProjectedNextAction(raw.next_action),
    firstTask: parseProjectedFirstTask(raw.first_task),
    projectionRevision: raw.projection_revision,
    configurationVersion: raw.configuration_version,
    supportReference: parseProjectedSupportReference(raw.support_reference),
  };
}

function parseProjectedSupportReference(raw: unknown): string | null {
  if (isRecord(raw) && raw.kind === "none") {
    return null;
  }
  if (
    isRecord(raw) &&
    raw.kind === "available" &&
    typeof raw.reference === "string"
  ) {
    return raw.reference;
  }
  throw new Error("Onboarding projection support reference is invalid.");
}

export function parseSupportDiagnostics(
  raw: Record<string, unknown>,
): SupportDiagnostics {
  if (
    typeof raw.supportReference !== "string" ||
    (raw.provider !== null && typeof raw.provider !== "string") ||
    (raw.displayAccount !== null && typeof raw.displayAccount !== "string") ||
    typeof raw.reasonCode !== "string" ||
    typeof raw.occurredAt !== "number" ||
    (raw.retryStatus !== "retryable" && raw.retryStatus !== "terminal") ||
    (raw.lastSuccessfulPhase !== null &&
      typeof raw.lastSuccessfulPhase !== "string") ||
    typeof raw.projectionRevision !== "number" ||
    !isRecord(raw.webhookHealth) ||
    typeof raw.webhookHealth.live !== "number" ||
    typeof raw.webhookHealth.degraded !== "number" ||
    typeof raw.webhookHealth.disabled !== "number" ||
    typeof raw.webhookHealth.revoked !== "number"
  ) {
    throw new Error("Support diagnostics response is invalid.");
  }
  return {
    supportReference: raw.supportReference,
    provider: raw.provider,
    displayAccount: raw.displayAccount,
    reasonCode: raw.reasonCode,
    occurredAt: raw.occurredAt,
    retryStatus: raw.retryStatus,
    lastSuccessfulPhase: raw.lastSuccessfulPhase,
    webhookHealth: {
      live: raw.webhookHealth.live,
      degraded: raw.webhookHealth.degraded,
      disabled: raw.webhookHealth.disabled,
      revoked: raw.webhookHealth.revoked,
    },
    projectionRevision: raw.projectionRevision,
  };
}

export function parseSlackRoutingConnection(
  raw: unknown,
): SlackRoutingConnection {
  if (
    !isRecord(raw) ||
    typeof raw.installationId !== "string" ||
    typeof raw.connectionId !== "string" ||
    typeof raw.integrationAccountId !== "string" ||
    typeof raw.workspaceId !== "string" ||
    (raw.lifecycle !== "active" &&
      raw.lifecycle !== "disabled" &&
      raw.lifecycle !== "revoked") ||
    !Array.isArray(raw.channelDefaults) ||
    typeof raw.sharedWorkspace !== "boolean"
  ) {
    throw new Error("Slack routing response is invalid.");
  }
  return {
    installationId: raw.installationId,
    connectionId: raw.connectionId,
    integrationAccountId: raw.integrationAccountId,
    workspaceId: raw.workspaceId,
    lifecycle: raw.lifecycle,
    channelDefaults: raw.channelDefaults.map(parseSlackChannelDefault),
    sharedWorkspace: raw.sharedWorkspace,
  };
}

function parseSlackChannelDefault(
  raw: unknown,
): SlackRoutingConnection["channelDefaults"][number] {
  const revision = isRecord(raw) ? positiveIntegerOrNull(raw.revision) : null;
  const boundAt = isRecord(raw) ? nonNegativeIntegerOrNull(raw.boundAt) : null;
  if (
    !isRecord(raw) ||
    typeof raw.channelId !== "string" ||
    revision === null ||
    boundAt === null
  ) {
    throw new Error("Slack channel default response is invalid.");
  }
  return {
    channelId: raw.channelId,
    revision,
    boundAt,
  };
}

export function parseProviderResourcePage(raw: unknown): {
  readonly resources: readonly ProviderResource[];
  readonly nextCursor: string;
} {
  if (
    !isRecord(raw) ||
    raw.kind !== "success" ||
    !isRecord(raw.page) ||
    !Array.isArray(raw.page.resources) ||
    typeof raw.page.next_cursor !== "string"
  ) {
    throw new Error(readApiError(raw));
  }
  return {
    resources: raw.page.resources.map(parseProviderResource),
    nextCursor: raw.page.next_cursor,
  };
}

function parseProviderResource(raw: unknown): ProviderResource {
  if (
    !isRecord(raw) ||
    typeof raw.canonical_resource_id !== "string" ||
    typeof raw.display_label !== "string" ||
    (raw.access_state !== "accessible" && raw.access_state !== "inaccessible")
  ) {
    throw new Error("Provider destination response is invalid.");
  }
  return {
    canonicalResourceId: raw.canonical_resource_id,
    displayLabel: raw.display_label,
    accessState: raw.access_state,
  };
}

export function parseOperatorOrganisationCase(
  raw: unknown,
): OperatorOrganisationCase {
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    parseOrganisationEnvironment(raw.environment) === null ||
    typeof raw.lifecycle !== "string" ||
    typeof raw.configurationVersion !== "number" ||
    !Number.isSafeInteger(raw.configurationVersion) ||
    typeof raw.projectionRevision !== "number" ||
    !Number.isSafeInteger(raw.projectionRevision)
  ) {
    throw new Error("Operator organisation inspection is invalid.");
  }
  const environment = parseOrganisationEnvironment(raw.environment);
  if (environment === null)
    throw new Error("Operator organisation environment is invalid.");
  return {
    organisationId: raw.organisationId,
    environment,
    lifecycle: raw.lifecycle,
    configurationVersion: raw.configurationVersion,
    projectionRevision: raw.projectionRevision,
  };
}

export function parseCommerceSystemResponse(
  raw: unknown,
): CommerceSystemView | null {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !(raw.commerceSystem === null || isRecord(raw.commerceSystem)) ||
    !(raw.sync === null || isRecord(raw.sync))
  ) {
    throw new Error(readApiError(raw));
  }
  if (raw.commerceSystem === null) return null;
  if (!isRecord(raw.sync))
    throw new Error("Commerce system sync response is invalid.");
  return parseCommerceSystemView(raw.commerceSystem, raw.sync);
}

type CommerceSystemIdentityView =
  | Readonly<{
      kind: "satyr_commerce";
      bindingId: string;
      merchantId: string;
      revision: number;
    }>
  | Readonly<{
      kind: "shopify";
      integrationAccountId: string;
      shopDomain: string;
      revision: number;
    }>;

export function parseCommerceSystemIdentity(
  raw: Record<string, unknown>,
): CommerceSystemIdentityView {
  if (
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1
  ) {
    throw new Error("Commerce system response is invalid.");
  }
  if (
    raw.kind === "satyr_commerce" &&
    typeof raw.bindingId === "string" &&
    typeof raw.merchantId === "string"
  ) {
    return {
      kind: raw.kind,
      bindingId: raw.bindingId,
      merchantId: raw.merchantId,
      revision: raw.revision,
    };
  }
  if (
    raw.kind === "shopify" &&
    typeof raw.integrationAccountId === "string" &&
    typeof raw.shopDomain === "string"
  ) {
    return {
      kind: raw.kind,
      integrationAccountId: raw.integrationAccountId,
      shopDomain: raw.shopDomain,
      revision: raw.revision,
    };
  }
  throw new Error("Commerce system response is invalid.");
}

function parseCommerceSystemView(
  raw: Record<string, unknown>,
  syncRaw: Record<string, unknown>,
): CommerceSystemView {
  const identity = parseCommerceSystemIdentity(raw);
  const sync = parseCommerceSystemSyncView(syncRaw);
  switch (identity.kind) {
    case "satyr_commerce":
      return {
        kind: identity.kind,
        bindingId: identity.bindingId,
        merchantId: identity.merchantId,
        revision: identity.revision,
        sync,
      };
    case "shopify":
      return {
        kind: identity.kind,
        integrationAccountId: identity.integrationAccountId,
        shopDomain: identity.shopDomain,
        revision: identity.revision,
        sync,
      };
    default:
      return assertNever(identity, "Unexpected portal state");
  }
}

function parseCommerceSystemSyncView(
  raw: Record<string, unknown>,
): CommerceSystemSyncView {
  if (raw.kind === "syncing" && raw.acceptedResourceCount === 0) {
    return {
      kind: raw.kind,
      acceptedResourceCount: 0,
      requestedAt: Date.now(),
      previousLastSyncedAt: null,
    };
  }
  if (
    raw.kind === "ready" &&
    typeof raw.acceptedResourceCount === "number" &&
    Number.isSafeInteger(raw.acceptedResourceCount) &&
    raw.acceptedResourceCount > 0 &&
    typeof raw.lastSyncedAt === "number" &&
    Number.isSafeInteger(raw.lastSyncedAt) &&
    raw.lastSyncedAt >= 0
  ) {
    return {
      kind: raw.kind,
      acceptedResourceCount: raw.acceptedResourceCount,
      lastSyncedAt: raw.lastSyncedAt,
    };
  }
  if (
    raw.kind === "delayed" &&
    typeof raw.acceptedResourceCount === "number" &&
    Number.isSafeInteger(raw.acceptedResourceCount) &&
    raw.acceptedResourceCount > 0 &&
    typeof raw.lastSyncedAt === "number" &&
    Number.isSafeInteger(raw.lastSyncedAt) &&
    raw.lastSyncedAt >= 0
  ) {
    return {
      kind: raw.kind,
      acceptedResourceCount: raw.acceptedResourceCount,
      lastSyncedAt: raw.lastSyncedAt,
    };
  }
  throw new Error("Commerce system sync response is invalid.");
}

export function parseCommerceApprovalResponse(raw: unknown): void {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    raw.state !== "signed" ||
    !isRecord(raw.approval) ||
    raw.approval.kind !== "google_oidc_step_up"
  ) {
    throw new Error("The server returned an invalid approval response.");
  }
}
