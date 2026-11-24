import {
  assertNever,
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
} from "@purin-labs/std";
import type {
  HomeAttentionItem,
  HomeAvailableAction,
  HomeBlocker,
  HomeDestination,
  HomeSourceObservation,
  HomeTodayFact,
} from "../index.ts";
import type {
  OnboardingControlRole,
  OrganisationOnboardingLifecycle,
} from "@purin-labs/contracts";

export type HomeSnapshot = {
  readonly schemaVersion: "pantry.home.v1";
  readonly generatedAt: number;
  readonly workspace: {
    readonly organisationId: string;
    readonly name: string;
    readonly lifecycle: OrganisationOnboardingLifecycle["kind"];
    readonly environment: "development" | "production";
  };
  readonly attention: readonly HomeAttentionItem[];
  readonly today: readonly HomeTodayFact[];
  readonly blockers: readonly HomeBlocker[];
  readonly permissions: {
    readonly role: OnboardingControlRole;
    readonly canApproveCommerceActions: boolean;
    readonly canConfigureIntegrations: boolean;
    readonly canManageWorkspace: boolean;
  };
  readonly availableActions: readonly HomeAvailableAction[];
  readonly sourceObservations: readonly HomeSourceObservation[];
};

const MAX_ATTENTION_ITEMS = 5;

const MAX_TODAY_FACTS = 4;

const MAX_BLOCKERS = 8;

const MAX_AVAILABLE_ACTIONS = 4;

const MAX_SOURCE_OBSERVATIONS = 3;

export function parseHomeResponse(raw: unknown): HomeSnapshot {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    raw.schemaVersion !== "pantry.home.v1" ||
    !isNonNegativeInteger(raw.generatedAt) ||
    !isRecord(raw.home)
  ) {
    throw new Error(homeResponseError(raw));
  }
  const workspace = parseWorkspace(raw.home.workspace);
  const attention = parseArray(
    raw.home.attention,
    parseAttentionItem,
    "attention items",
  );
  const today = parseArray(raw.home.today, parseTodayFact, "today facts");
  const blockers = parseArray(
    raw.home.blockers,
    parseBlocker,
    "workspace blockers",
  );
  const permissions = parsePermissions(raw.home.permissions);
  const availableActions = parseArray(
    raw.home.availableActions,
    parseAvailableAction,
    "available actions",
  );
  const sourceObservations = parseArray(
    raw.home.sourceObservations,
    parseSourceObservation,
    "source observations",
  );
  if (
    attention.length > MAX_ATTENTION_ITEMS ||
    today.length > MAX_TODAY_FACTS ||
    blockers.length > MAX_BLOCKERS ||
    availableActions.length > MAX_AVAILABLE_ACTIONS ||
    sourceObservations.length > MAX_SOURCE_OBSERVATIONS
  ) {
    throw new Error("Home response exceeds its bounded view limits.");
  }
  return {
    schemaVersion: "pantry.home.v1",
    generatedAt: raw.generatedAt,
    workspace,
    attention,
    today,
    blockers,
    permissions,
    availableActions,
    sourceObservations,
  };
}

function parseWorkspace(raw: unknown): HomeSnapshot["workspace"] {
  if (
    !isRecord(raw) ||
    !isNonBlankString(raw.organisationId) ||
    !isNonBlankString(raw.name) ||
    !isWorkspaceLifecycle(raw.lifecycle) ||
    !isEnvironment(raw.environment)
  ) {
    throw new Error("Home workspace is invalid.");
  }
  return {
    organisationId: raw.organisationId,
    name: raw.name,
    lifecycle: raw.lifecycle,
    environment: raw.environment,
  };
}

function parseAttentionItem(raw: unknown): HomeAttentionItem {
  if (
    !isRecord(raw) ||
    !isAttentionKind(raw.kind) ||
    !isAttentionUrgency(raw.urgency) ||
    !isAttentionStatus(raw.status) ||
    !isNonBlankString(raw.title) ||
    !isNonBlankString(raw.reason) ||
    !isRecord(raw.resource) ||
    !isAttentionResourceKind(raw.resource.kind) ||
    !isNonBlankString(raw.resource.label) ||
    !isoTimestamp(raw.observedAt) ||
    !isRecord(raw.assignee) ||
    raw.assignee.kind !== "unassigned"
  ) {
    throw new Error("Home attention item is invalid.");
  }
  return {
    kind: raw.kind,
    urgency: raw.urgency,
    status: raw.status,
    title: raw.title,
    reason: raw.reason,
    resource: { kind: raw.resource.kind, label: raw.resource.label },
    observedAt: raw.observedAt,
    assignee: { kind: "unassigned" },
    nextAction: parseAvailableAction(raw.nextAction),
  };
}

function parseTodayFact(raw: unknown): HomeTodayFact {
  if (
    !isRecord(raw) ||
    !isTodayFactKind(raw.kind) ||
    !isNonBlankString(raw.label) ||
    !isNonNegativeInteger(raw.value) ||
    !isoTimestamp(raw.observedAt)
  ) {
    throw new Error("Home today fact is invalid.");
  }
  return {
    kind: raw.kind,
    label: raw.label,
    value: raw.value,
    observedAt: raw.observedAt,
    destination: parseDestination(raw.destination),
  };
}

function parseBlocker(raw: unknown): HomeBlocker {
  if (
    !isRecord(raw) ||
    !isBlockerKind(raw.kind) ||
    !isNonBlankString(raw.title) ||
    !isNonBlankString(raw.reason) ||
    !isNonBlankString(raw.consequence) ||
    !nullableIsoTimestamp(raw.observedAt)
  ) {
    throw new Error("Home blocker is invalid.");
  }
  return {
    kind: raw.kind,
    title: raw.title,
    reason: raw.reason,
    consequence: raw.consequence,
    observedAt: raw.observedAt,
    nextAction: parseAvailableAction(raw.nextAction),
  };
}

function parsePermissions(raw: unknown): HomeSnapshot["permissions"] {
  if (
    !isRecord(raw) ||
    !isRole(raw.role) ||
    typeof raw.canApproveCommerceActions !== "boolean" ||
    typeof raw.canConfigureIntegrations !== "boolean" ||
    typeof raw.canManageWorkspace !== "boolean"
  ) {
    throw new Error("Home permissions are invalid.");
  }
  return {
    role: raw.role,
    canApproveCommerceActions: raw.canApproveCommerceActions,
    canConfigureIntegrations: raw.canConfigureIntegrations,
    canManageWorkspace: raw.canManageWorkspace,
  };
}

function parseAvailableAction(raw: unknown): HomeAvailableAction {
  if (
    !isRecord(raw) ||
    !isAvailableActionKind(raw.kind) ||
    !isNonBlankString(raw.label)
  ) {
    throw new Error("Home action is invalid.");
  }
  return {
    kind: raw.kind,
    label: raw.label,
    destination: parseDestination(raw.destination),
  };
}

function parseDestination(raw: unknown): HomeDestination {
  if (!isRecord(raw) || !isDestinationKind(raw.kind)) {
    throw new Error("Home destination is invalid.");
  }
  switch (raw.kind) {
    case "product":
    case "customer_order":
      if (!isNonBlankString(raw.resourceId))
        throw new Error("Home resource destination is invalid.");
      return { kind: raw.kind, resourceId: raw.resourceId };
    case "home":
    case "commerce":
    case "orders":
    case "operations":
    case "integrations":
    case "settings":
      return { kind: raw.kind };
    default:
      return assertNever(raw.kind, "Unhandled Home value");
  }
}

function parseSourceObservation(raw: unknown): HomeSourceObservation {
  if (
    !isRecord(raw) ||
    !isSourceKind(raw.kind) ||
    !isSourceStatus(raw.status) ||
    !nullableIsoTimestamp(raw.observedAt)
  ) {
    throw new Error("Home source observation is invalid.");
  }
  return { kind: raw.kind, status: raw.status, observedAt: raw.observedAt };
}

function parseArray<T>(
  raw: unknown,
  parse: (value: unknown) => T,
  label: string,
): readonly T[] {
  if (!Array.isArray(raw)) throw new Error(`Home ${label} are invalid.`);
  return raw.map(parse);
}

function homeResponseError(raw: unknown): string {
  return isRecord(raw) && raw.ok === false
    ? "Home is unavailable."
    : "Home response is invalid.";
}

function isAttentionKind(value: unknown): value is HomeAttentionItem["kind"] {
  return (
    value === "governed_action" ||
    value === "commerce_exception" ||
    value === "integration_health"
  );
}

function isAttentionUrgency(
  value: unknown,
): value is HomeAttentionItem["urgency"] {
  return value === "urgent" || value === "high";
}

function isAttentionStatus(
  value: unknown,
): value is HomeAttentionItem["status"] {
  return (
    value === "awaiting_review" ||
    value === "blocked" ||
    value === "failed" ||
    value === "uncertain"
  );
}

function isAttentionResourceKind(
  value: unknown,
): value is HomeAttentionItem["resource"]["kind"] {
  return (
    value === "customer_order" ||
    value === "inventory" ||
    value === "payment" ||
    value === "fulfillment" ||
    value === "shipment" ||
    value === "catalog" ||
    value === "integration"
  );
}

function isTodayFactKind(value: unknown): value is HomeTodayFact["kind"] {
  return (
    value === "open_customer_orders" ||
    value === "low_stock_products" ||
    value === "payment_failures" ||
    value === "delayed_shipments"
  );
}

function isBlockerKind(value: unknown): value is HomeBlocker["kind"] {
  return (
    value === "workspace" ||
    value === "authentication" ||
    value === "synchronization" ||
    value === "permission"
  );
}

function isAvailableActionKind(
  value: unknown,
): value is HomeAvailableAction["kind"] {
  return (
    value === "review_operations" ||
    value === "open_commerce" ||
    value === "resolve_blocker" ||
    value === "manage_workspace"
  );
}

function isDestinationKind(value: unknown): value is HomeDestination["kind"] {
  return (
    value === "home" ||
    value === "commerce" ||
    value === "orders" ||
    value === "product" ||
    value === "customer_order" ||
    value === "operations" ||
    value === "integrations" ||
    value === "settings"
  );
}

function isSourceKind(value: unknown): value is HomeSourceObservation["kind"] {
  return (
    value === "commerce" ||
    value === "governed_work" ||
    value === "workspace_readiness"
  );
}

function isSourceStatus(
  value: unknown,
): value is HomeSourceObservation["status"] {
  return value === "current" || value === "delayed" || value === "unavailable";
}

function isWorkspaceLifecycle(
  value: unknown,
): value is HomeSnapshot["workspace"]["lifecycle"] {
  return (
    value === "configuring" ||
    value === "activating" ||
    value === "active" ||
    value === "archived"
  );
}

function isEnvironment(
  value: unknown,
): value is HomeSnapshot["workspace"]["environment"] {
  return value === "development" || value === "production";
}

function isRole(value: unknown): value is HomeSnapshot["permissions"]["role"] {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "operator" ||
    value === "viewer"
  );
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isoTimestamp(value);
}
