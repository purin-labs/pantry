import type { ActionLedgerActivity } from "../../actors/action-ledger";
import { requireActiveOrganisationActorAtScope } from "../../actors/actor-router";
import type { ActiveOrganisationMembership } from "../../data/control-plane";
import {
  buildOnboardingProjection,
  type OnboardingProjection,
} from "../../data/onboarding-projection";
import type { Env } from "../../env";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { readCommerceActionLedger } from "../agent-operation-activity";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type {
  HomeAttentionItem,
  HomeAvailableAction,
  HomeBlocker,
  HomeDestination,
  HomeSourceObservation,
  HomeTodayFact,
} from "@purin-labs/control-api";

export type WorkspaceControlRoute = Readonly<{
  kind: "home";
  organisationIdRaw: string;
}>;

export function matchWorkspaceControlRoute(
  pathname: string,
): WorkspaceControlRoute | null {
  const match = /^\/v1\/control\/organisations\/([^/]+)\/home$/u.exec(pathname);
  return match?.[1] === undefined
    ? null
    : { kind: "home", organisationIdRaw: decodeURIComponent(match[1]) };
}
export function handleWorkspaceControlRoute(
  request: Request,
  env: Env,
  route: WorkspaceControlRoute,
): Promise<Response> {
  return handleHome(request, env, route.organisationIdRaw);
}

type HomeActionActivity = Pick<
  ActionLedgerActivity,
  "caseId" | "proposalId" | "state" | "createdAt" | "updatedAt"
> &
  Readonly<{
    action: Pick<
      ActionLedgerActivity["action"],
      "host" | "resourceKey" | "verb"
    > &
      Readonly<{
        nonce: Pick<ActionLedgerActivity["action"]["nonce"], "value">;
      }>;
  }>;

const HOME_VIEW_SCHEMA_VERSION = "pantry.cafeos.home.v1" as const;
const HOME_ATTENTION_LIMIT = 5;
const HOME_BLOCKER_LIMIT = 8;

type HomeView = {
  readonly schemaVersion: typeof HOME_VIEW_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly home: {
    readonly workspace: {
      readonly organisationId: string;
      readonly name: string;
      readonly lifecycle: "configuring" | "activating" | "active" | "archived";
      readonly environment: "development" | "production";
    };
    readonly attention: readonly HomeAttentionItem[];
    readonly today: readonly HomeTodayFact[];
    readonly blockers: readonly HomeBlocker[];
    readonly permissions: {
      readonly role: ActiveOrganisationMembership["role"];
      readonly canApproveCommerceActions: boolean;
      readonly canConfigureIntegrations: boolean;
      readonly canManageWorkspace: boolean;
    };
    readonly availableActions: readonly HomeAvailableAction[];
    readonly sourceObservations: readonly HomeSourceObservation[];
  };
};

export type HomeViewBuildInput = {
  readonly generatedAt: number;
  readonly projection: Pick<
    OnboardingProjection,
    "organisation" | "readiness" | "updated_at"
  >;
  readonly role: ActiveOrganisationMembership["role"];
  readonly operationsUnavailable: boolean;
  readonly actionLedger: readonly HomeActionActivity[];
};

export function buildHomeView(input: HomeViewBuildInput): HomeView {
  const attention = buildHomeAttention(input.actionLedger);
  const today: readonly HomeTodayFact[] = [];
  const blockers = buildHomeBlockers(input);
  const permissions = homePermissions(input.role);
  const availableActions = homeAvailableActions(
    attention,
    today,
    blockers,
    permissions.canManageWorkspace,
  );
  return {
    schemaVersion: HOME_VIEW_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    home: {
      workspace: {
        organisationId: input.projection.organisation.organisation_id,
        name: input.projection.organisation.name,
        lifecycle: input.projection.organisation.lifecycle.kind,
        environment: input.projection.organisation.lifecycle.environment,
      },
      attention,
      today,
      blockers,
      permissions,
      availableActions,
      sourceObservations: buildHomeSourceObservations(input),
    },
  };
}

function homePermissions(
  role: ActiveOrganisationMembership["role"],
): HomeView["home"]["permissions"] {
  const canManageWorkspace = role === "owner" || role === "admin";
  return {
    role,
    canApproveCommerceActions: canManageWorkspace,
    canConfigureIntegrations: canManageWorkspace,
    canManageWorkspace,
  };
}

function buildHomeAttention(
  actionLedger: readonly HomeActionActivity[],
): readonly HomeAttentionItem[] {
  const governedWork = actionLedger
    .filter(actionLedgerIsCommerce)
    .filter(actionLedgerNeedsAttention)
    .map(buildHomeGovernedWork);
  return governedWork.sort(compareHomeAttention).slice(0, HOME_ATTENTION_LIMIT);
}

function buildHomeGovernedWork(item: HomeActionActivity): HomeAttentionItem {
  const resource = homeWorkResource(item.action.resourceKey);
  const failed = item.state === "failed";
  const uncertain = item.state === "indeterminate";
  return {
    kind: "governed_action",
    urgency: failed || uncertain ? "urgent" : "high",
    status: failed ? "failed" : uncertain ? "uncertain" : "awaiting_review",
    title: homeWorkTitle(item.action.resourceKey),
    reason: failed
      ? "A governed change needs recovery."
      : uncertain
        ? "The provider result needs confirmation."
        : "A governed change is waiting for review.",
    resource,
    observedAt: new Date(item.updatedAt).toISOString(),
    assignee: { kind: "unassigned" },
    nextAction: {
      kind: "review_operations",
      label: failed || uncertain ? "Review recovery" : "Review change",
      destination: { kind: "operations" },
    },
  };
}

function homeWorkTitle(resourceKey: string): string {
  if (resourceKey.includes(":cancel_order:")) return "Cancel customer order";
  if (resourceKey.includes(":publish_catalog_listing:"))
    return "Publish catalog listing";
  if (resourceKey.includes(":publish_cafe_menu:")) return "Publish café menu";
  if (resourceKey.includes(":change_menu_price:")) return "Change a menu price";
  if (resourceKey.includes(":refund_order:")) return "Refund customer order";
  if (resourceKey.includes(":stock_operation:")) return "Review stock change";
  return "Review governed change";
}

function homeWorkResource(resourceKey: string): HomeAttentionItem["resource"] {
  if (
    resourceKey.includes(":cancel_order:") ||
    resourceKey.includes(":refund_order:")
  ) {
    return { kind: "customer_order", label: "Customer order" };
  }
  if (resourceKey.includes(":stock_operation:"))
    return { kind: "inventory", label: "Inventory" };
  return { kind: "catalog", label: "Catalog" };
}

function actionLedgerNeedsAttention(item: HomeActionActivity): boolean {
  switch (item.state) {
    case "proposed":
    case "approval_requested":
    case "signed":
    case "failed":
    case "indeterminate":
      return true;
    case "executing":
    case "confirmed":
    case "rejected":
    case "expired":
      return false;
    default:
      return assertNever(item.state);
  }
}

function compareHomeAttention(
  left: HomeAttentionItem,
  right: HomeAttentionItem,
): number {
  const urgency =
    homeUrgencyRank(right.urgency) - homeUrgencyRank(left.urgency);
  if (urgency !== 0) return urgency;
  const observed = Date.parse(right.observedAt) - Date.parse(left.observedAt);
  return observed !== 0 ? observed : left.title.localeCompare(right.title);
}

function homeUrgencyRank(value: HomeAttentionItem["urgency"]): number {
  return value === "urgent" ? 2 : 1;
}

function buildHomeBlockers(input: HomeViewBuildInput): readonly HomeBlocker[] {
  const blockers: HomeBlocker[] = [];
  if (input.projection.organisation.lifecycle.kind === "configuring") {
    blockers.push({
      kind: "workspace",
      title: "Finish setting up this workspace",
      reason: "Complete setup before using daily operations.",
      consequence: "Actions that require approval are unavailable.",
      observedAt: new Date(input.projection.updated_at).toISOString(),
      nextAction: {
        kind: "manage_workspace",
        label: "Open integrations",
        destination: { kind: "integrations" },
      },
    });
  } else if (input.projection.organisation.lifecycle.kind === "activating") {
    blockers.push({
      kind: "synchronization",
      title: "Workspace activation is in progress",
      reason: "Seams Pantry is still preparing this workspace.",
      consequence:
        "Daily operations will be available when activation completes.",
      observedAt: new Date(input.projection.updated_at).toISOString(),
      nextAction: {
        kind: "manage_workspace",
        label: "Open integrations",
        destination: { kind: "integrations" },
      },
    });
  }
  if (input.projection.readiness.kind === "blocked") {
    blockers.push(
      ...input.projection.readiness.blockers.map(
        buildHomeReadinessBlocker.bind(
          null,
          input.projection.readiness.assessed_at,
        ),
      ),
    );
  }
  if (input.projection.organisation.lifecycle.kind === "archived") {
    blockers.push({
      kind: "workspace",
      title: "Workspace is archived",
      reason: "An owner or admin needs to review this workspace.",
      consequence: "Daily work is unavailable until the workspace is restored.",
      observedAt: new Date(input.projection.updated_at).toISOString(),
      nextAction: {
        kind: "manage_workspace",
        label: "Open workspace settings",
        destination: { kind: "settings" },
      },
    });
  }
  if (input.operationsUnavailable) {
    blockers.push({
      kind: "synchronization",
      title: "Operations are unavailable",
      reason: "Seams Pantry cannot load changes that need approval right now.",
      consequence: "Pending decisions may not be visible.",
      observedAt: null,
      nextAction: {
        kind: "review_operations",
        label: "Open operations",
        destination: { kind: "operations" },
      },
    });
  }
  return dedupeHomeBlockers(blockers).slice(0, HOME_BLOCKER_LIMIT);
}

function buildHomeReadinessBlocker(
  assessedAt: number,
  blocker: Variant<
    OnboardingProjection["readiness"],
    "blocked"
  >["blockers"][number],
): HomeBlocker {
  const detail = homeReadinessBlockerDetail(blocker.code);
  return {
    ...detail,
    observedAt: assessedAt > 0 ? new Date(assessedAt).toISOString() : null,
    nextAction: {
      kind: detail.actionKind,
      label: detail.actionLabel,
      destination: detail.destination,
    },
  };
}

function homeReadinessBlockerDetail(
  code: Variant<
    OnboardingProjection["readiness"],
    "blocked"
  >["blockers"][number]["code"],
): {
  readonly kind: HomeBlocker["kind"];
  readonly title: string;
  readonly reason: string;
  readonly consequence: string;
  readonly actionKind: HomeAvailableAction["kind"];
  readonly actionLabel: string;
  readonly destination: HomeDestination;
} {
  switch (code) {
    case "readiness_not_evaluated":
      return {
        kind: "workspace",
        title: "Seams Pantry is checking this workspace",
        reason: "The latest setup check has not finished.",
        consequence: "Actions that require approval are unavailable.",
        actionKind: "manage_workspace",
        actionLabel: "Open integrations",
        destination: { kind: "integrations" },
      };
    case "owner_missing":
      return {
        kind: "permission",
        title: "Workspace owner is missing",
        reason: "Assign an owner before workspace operations can continue.",
        consequence: "Administrative decisions cannot be completed.",
        actionKind: "manage_workspace",
        actionLabel: "Open workspace settings",
        destination: { kind: "settings" },
      };
    case "placement_missing":
      return {
        kind: "workspace",
        title: "Workspace setup needs repair",
        reason: "Seams Pantry cannot start this workspace right now.",
        consequence: "Actions that require approval are unavailable.",
        actionKind: "manage_workspace",
        actionLabel: "Open workspace settings",
        destination: { kind: "settings" },
      };
    case "communication_connection_missing":
      return {
        kind: "authentication",
        title: "Slack is not connected",
        reason: "Connect Slack to receive requests and team updates.",
        consequence: "Seams Pantry cannot send updates to your team.",
        actionKind: "manage_workspace",
        actionLabel: "Connect Slack",
        destination: { kind: "integrations" },
      };
    case "communication_destination_missing":
      return {
        kind: "workspace",
        title: "Choose a Slack channel",
        reason: "Choose where Seams Pantry should send team updates.",
        consequence: "Seams Pantry cannot send updates to your team.",
        actionKind: "manage_workspace",
        actionLabel: "Choose a channel",
        destination: { kind: "integrations" },
      };
    case "commerce_system_missing":
      return {
        kind: "workspace",
        title: "Commerce system is not connected",
        reason: "Choose the system that owns products, inventory, and orders.",
        consequence: "Products, stock, orders, and actions are unavailable.",
        actionKind: "open_commerce",
        actionLabel: "Choose a commerce system",
        destination: { kind: "integrations" },
      };
    case "credential_unresolved":
      return {
        kind: "authentication",
        title: "A connected service needs attention",
        reason: "Reconnect the affected service.",
        consequence: "Connected data and actions may be unavailable.",
        actionKind: "manage_workspace",
        actionLabel: "Open integrations",
        destination: { kind: "integrations" },
      };
    case "webhook_unhealthy":
      return {
        kind: "synchronization",
        title: "Connected service updates are delayed",
        reason: "Reconnect the affected service so updates can resume.",
        consequence: "New commerce changes may take longer to appear.",
        actionKind: "manage_workspace",
        actionLabel: "Open integrations",
        destination: { kind: "integrations" },
      };
    case "policy_snapshot_missing":
      return {
        kind: "permission",
        title: "Approval settings are not ready",
        reason: "Finish workspace setup before approving actions.",
        consequence: "Commerce actions cannot be approved yet.",
        actionKind: "manage_workspace",
        actionLabel: "Open workspace settings",
        destination: { kind: "settings" },
      };
    case "cue_snapshot_missing":
      return {
        kind: "synchronization",
        title: "Alert settings are not ready",
        reason: "Finish Slack update setup.",
        consequence: "Time-sensitive updates may not reach your team.",
        actionKind: "manage_workspace",
        actionLabel: "Open integrations",
        destination: { kind: "integrations" },
      };
    case "environment_conflict":
      return {
        kind: "workspace",
        title: "Workspace environment needs repair",
        reason: "The workspace and provider environment do not match.",
        consequence: "Provider data cannot be trusted in this workspace.",
        actionKind: "manage_workspace",
        actionLabel: "Open integrations",
        destination: { kind: "integrations" },
      };
    case "runtime_admission_unavailable":
      return {
        kind: "synchronization",
        title: "Seams Pantry is temporarily unavailable",
        reason: "Pantry cannot accept new work right now.",
        consequence: "Pending work will wait until service resumes.",
        actionKind: "review_operations",
        actionLabel: "Open operations",
        destination: { kind: "operations" },
      };
    default:
      return assertNever(code);
  }
}

function dedupeHomeBlockers(
  blockers: readonly HomeBlocker[],
): readonly HomeBlocker[] {
  const seen = new Set<string>();
  return blockers.filter(isFirstHomeBlocker.bind(null, seen));
}

function isFirstHomeBlocker(seen: Set<string>, blocker: HomeBlocker): boolean {
  const key = `${blocker.kind}:${blocker.title}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function homeAvailableActions(
  attention: readonly HomeAttentionItem[],
  today: readonly HomeTodayFact[],
  blockers: readonly HomeBlocker[],
  canManageWorkspace: boolean,
): readonly HomeAvailableAction[] {
  const actions: HomeAvailableAction[] = [];
  if (attention.some(isGovernedAttention)) {
    actions.push({
      kind: "review_operations",
      label: "Open operations",
      destination: { kind: "operations" },
    });
  }
  if (today.length > 0) {
    actions.push({
      kind: "open_commerce",
      label: "Open commerce",
      destination: { kind: "commerce" },
    });
  }
  if (blockers.length > 0) {
    actions.push({
      kind: "resolve_blocker",
      label: blockers[0]?.nextAction.label ?? "Resolve blocker",
      destination: blockers[0]?.nextAction.destination ?? {
        kind: "integrations",
      },
    });
  }
  if (canManageWorkspace) {
    actions.push({
      kind: "manage_workspace",
      label: "Open workspace settings",
      destination: { kind: "settings" },
    });
  }
  return actions;
}

function isGovernedAttention(item: HomeAttentionItem): boolean {
  return item.kind === "governed_action";
}

function buildHomeSourceObservations(
  input: HomeViewBuildInput,
): readonly HomeSourceObservation[] {
  const readinessObservedAt =
    input.projection.readiness.assessed_at > 0
      ? new Date(input.projection.readiness.assessed_at).toISOString()
      : null;
  const readinessStatus =
    readinessObservedAt === null
      ? ("unavailable" as const)
      : ("current" as const);
  const latestWork = input.actionLedger.reduce(latestActionUpdatedAt, 0);
  return [
    {
      kind: "governed_work",
      status: input.operationsUnavailable ? "unavailable" : "current",
      observedAt: latestWork > 0 ? new Date(latestWork).toISOString() : null,
    },
    {
      kind: "workspace_readiness",
      status: readinessStatus,
      observedAt: readinessObservedAt,
    },
  ];
}

function latestActionUpdatedAt(
  latest: number,
  item: HomeActionActivity,
): number {
  return Math.max(latest, item.updatedAt);
}

function actionLedgerIsCommerce(item: HomeActionActivity): boolean {
  return item.action.host === "pantry.commerce";
}

async function handleHome(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const generatedAt = Date.now();
  // Home shows the commerce actions of the ledger and nothing else of the
  // agent operations, so it reads the ledger alone, beside the projection.
  const ledgerRead = readHomeActionLedger(
    env,
    authorized.executionScope,
    generatedAt,
  );
  let projection: OnboardingProjection;
  try {
    const loadedProjection = await buildOnboardingProjection({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      membership: authorized.membership,
      now: Date.now(),
    });
    if (loadedProjection === null) return controlError("home_unavailable", 503);
    projection = loadedProjection;
  } catch {
    return controlError("home_unavailable", 503);
  }
  const actionLedger = await ledgerRead;
  const operationsUnavailable = actionLedger === null;

  return controlJson({
    ok: true,
    ...buildHomeView({
      generatedAt,
      projection,
      role: authorized.membership.role,
      operationsUnavailable,
      actionLedger: actionLedger ?? [],
    }),
  });
}

/** The ledger's commerce actions, or null when the ledger cannot be read. */
async function readHomeActionLedger(
  env: Env,
  scope: OrganisationExecutionScope,
  now: number,
): Promise<readonly ActionLedgerActivity[] | null> {
  try {
    return await readCommerceActionLedger(
      await requireActiveOrganisationActorAtScope({ env, scope, now }),
      scope.organisationId,
    );
  } catch {
    return null;
  }
}
