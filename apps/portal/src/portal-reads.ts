import { parseControlMembershipAvailability } from "@purin-labs/control-api";
import {
  controlRead,
  offerControlRead,
  readControlSession,
  responseJson,
  controlMutation,
  controlReadIfChanged,
  controlSignal,
  readCookie,
} from "./control-client";
import type {
  OnboardingNextAction,
  OnboardingStepProjection,
  OrganisationOnboardingLifecycle,
} from "@purin-labs/contracts";
import {
  initialFileAccessPath,
  workspacePagePath,
} from "./route";
import type {
  OrganisationChoice,
  WorkspaceChoice,
} from "./shell";
import type { OrganisationListItem } from "./pages/workspaces";
import type { SlackRoutingConnection, IntegrationAccount, ProviderResource, ReadinessAssessment, SetupSelection, SupportDiagnostics, OrganisationInvitation, OrganisationMember } from "@purin-labs/control-api/portal/settings";
import type { SlackWorkspaceCatalog } from "./features/integrations/settings-types";
import {
  commerceSystemPath,
  organisationRecordPath,
} from "./control-paths";
import { rememberOrganisationId } from "./early-reads";
import { offerPriceAllowanceTransport } from "./features/commerce/price-allowance";
import type { OfferPriceAllowanceInteraction } from "./features/commerce/entity-plane/route";
import { isRecord } from "@purin-labs/std";
import { parseMemberships, parseOrganisationInvitation, parseOrganisationMember, parseReadiness, parseUser } from "@purin-labs/control-api/portal/portal-projection";
import { readApiError } from "@purin-labs/control-api/portal/api-error";
import type { CommerceSystemView, Membership, OperatorOrganisationCase, OrganisationSnapshot, OrganisationWorkspace } from "@purin-labs/control-api/portal/portal-types";
import type { PortalOrganisation, PortalState, Provider, SessionSnapshot } from "./portal-types";
import { parseCommerceSystemIdentity, parseCommerceSystemResponse, parseOperatorOrganisationCase, parseOrganisationSnapshot, parseProviderResourcePage, parseSlackRoutingConnection, parseSupportDiagnostics, parseSupportRole } from "@purin-labs/control-api/portal/portal-reads";

type ProviderStartResult = {
  readonly authorizationUrl: string;
};

type ConditionalOrganisationSnapshot =
  | { readonly kind: "unchanged"; readonly etag: string }
  | {
      readonly kind: "changed";
      readonly etag: string;
      readonly snapshot: OrganisationSnapshot;
    };

export async function fetchControlSession(): Promise<SessionSnapshot | null> {
  const response = await readControlSession();
  if (response.status === 401) {
    return null;
  }
  const raw = await responseJson(response);
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(raw.identity) ||
    !Array.isArray(raw.memberships)
  ) {
    throw new Error(readApiError(raw));
  }
  const identity = parseUser(raw.identity);
  const supportRole = parseSupportRole(raw.supportRole);
  const memberships = parseMemberships(raw.memberships);
  for (const membership of memberships)
    rememberOrganisationId(
      membership.organisationHandle,
      membership.organisationId,
    );
  const membershipAvailability = parseControlMembershipAvailability(
    raw.membershipAvailability,
  );
  return { identity, supportRole, memberships, membershipAvailability };
}

export async function loadPortalOrganisations(
  memberships: readonly Membership[],
): Promise<readonly PortalOrganisation[]> {
  return Promise.all(memberships.map(loadPortalOrganisation));
}

/**
 * The Organisations of the switcher. The shell already reads `current`, so
 * only the other Organisations are read here, all at the same time.
 */
export async function loadOrganisationChoices(
  memberships: readonly Membership[],
  current: Readonly<{
    organisationId: string;
    snapshot: Promise<OrganisationSnapshot>;
  }>,
): Promise<readonly OrganisationChoice[]> {
  const organisations = await Promise.all(
    memberships.map(async (membership) => {
      if (membership.organisationId !== current.organisationId)
        return loadPortalOrganisation(membership);
      const snapshot = await current.snapshot;
      return {
        membership,
        organisation: snapshot.organisation,
        configurationVersion: snapshot.configurationVersion,
      };
    }),
  );
  return organisations.map(toOrganisationChoice);
}

export function toOrganisationChoice(
  organisation: PortalOrganisation,
): OrganisationChoice {
  return {
    organisationHandle: organisation.membership.organisationHandle,
    name: organisation.organisation.name,
    workspaces: organisation.membership.workspaces.map(
      toWorkspaceChoice.bind(null, organisation.membership.organisationHandle),
    ),
  };
}

export function toWorkspaceChoice(
  organisationHandle: string,
  workspace: OrganisationWorkspace,
): WorkspaceChoice {
  return {
    organisationHandle,
    workspaceHandle: workspace.workspaceHandle,
    name: workspace.name,
  };
}

export async function loadPortalOrganisation(
  membership: Membership,
): Promise<PortalOrganisation> {
  const snapshot = await fetchOrganisationSnapshot(membership.organisationId);
  return {
    membership,
    organisation: snapshot.organisation,
    configurationVersion: snapshot.configurationVersion,
  };
}

export async function fetchOrganisationSnapshot(
  organisationId: string,
): Promise<OrganisationSnapshot> {
  return parseOrganisationSnapshot(
    await controlRead(organisationRecordPath(organisationId)),
  );
}

/**
 * The shell's read of the Organisation. The page under the shell reads the
 * same record when it mounts, so the shell offers it its response one time.
 */
export async function fetchShellOrganisationSnapshot(
  organisationId: string,
): Promise<OrganisationSnapshot> {
  const path = organisationRecordPath(organisationId);
  const raw = await controlRead(path);
  const snapshot = parseOrganisationSnapshot(raw);
  offerControlRead(path, raw);
  return snapshot;
}

export async function fetchOrganisationSnapshotIfChanged(
  organisationId: string,
  etag: string,
): Promise<ConditionalOrganisationSnapshot> {
  const read = await controlReadIfChanged(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}`,
    etag,
  );
  if (read.kind === "unchanged") {
    return { kind: "unchanged", etag };
  }
  const snapshot = parseOrganisationSnapshot(read.raw);
  return {
    kind: "changed",
    etag:
      read.etag ??
      organisationProjectionEtag(organisationId, snapshot.projectionRevision),
    snapshot,
  };
}

export function organisationProjectionEtag(
  organisationId: string,
  projectionRevision: number,
): string {
  return `"organisation:${organisationId}:revision:${projectionRevision}"`;
}

export function currentOrganisationLifecycle(
  state: PortalState,
  organisationId: string,
): OrganisationOnboardingLifecycle["kind"] | null {
  return state.kind === "workspace_detail" &&
    state.organisation.organisation.organisationId === organisationId
    ? state.organisation.organisation.lifecycle
    : null;
}

export async function fetchSupportDiagnostics(
  organisationId: string,
  supportReference: string,
): Promise<SupportDiagnostics> {
  const raw = await controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/support/${encodeURIComponent(supportReference)}`,
  );
  if (!isRecord(raw) || raw.kind !== "success" || !isRecord(raw.diagnostics)) {
    throw new Error(readApiError(raw));
  }
  return parseSupportDiagnostics(raw.diagnostics);
}

export async function fetchSlackDestinations(
  organisationId: string,
  accounts: readonly IntegrationAccount[],
): Promise<readonly SlackWorkspaceCatalog[]> {
  return Promise.all(
    accounts
      .filter(isActiveSlackAccount)
      .map(loadSlackWorkspaceCatalog.bind(null, organisationId)),
  );
}

/** Binds the setup's Slack channel to this Organisation unless it is bound. */
export async function bindSetupChannel(
  organisationId: string,
  cueTarget: SetupSelection["cueTarget"],
): Promise<void> {
  const connections = await fetchSlackRouting(organisationId);
  for (const connection of connections) {
    if (
      connection.lifecycle !== "active" ||
      connection.workspaceId !== cueTarget.workspaceId
    ) {
      continue;
    }
    for (const channel of connection.channelDefaults) {
      if (channel.channelId === cueTarget.channelId) return;
    }
    await controlMutation(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/slack-routing/installations/${encodeURIComponent(connection.installationId)}/channels/${encodeURIComponent(cueTarget.channelId)}`,
      "PUT",
      {
        kind: "bind_unbound",
        destinationOrganisationId: organisationId,
        destinationConnectionId: connection.connectionId,
      },
    );
    return;
  }
  throw new Error("Slack organisation connection is unavailable.");
}

export async function fetchSlackRouting(
  organisationId: string,
): Promise<readonly SlackRoutingConnection[]> {
  const raw = await controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/slack-routing`,
  );
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.connections)) {
    throw new Error(readApiError(raw));
  }
  return raw.connections.map(parseSlackRoutingConnection);
}

async function loadSlackWorkspaceCatalog(
  organisationId: string,
  account: IntegrationAccount,
): Promise<SlackWorkspaceCatalog> {
  try {
    return {
      integrationAccountId: account.integrationAccountId,
      workspaceId: account.providerAccountId,
      channels: await collectSlackDestinationPages(organisationId, account),
    };
  } catch {
    return {
      integrationAccountId: account.integrationAccountId,
      workspaceId: account.providerAccountId,
      channels: [],
    };
  }
}

async function collectSlackDestinationPages(
  organisationId: string,
  account: IntegrationAccount,
): Promise<readonly ProviderResource[]> {
  const resources: ProviderResource[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const query = new URLSearchParams();
    if (cursor !== null) {
      query.set("cursor", cursor);
    }
    const raw = await controlRead(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(account.integrationAccountId)}/resources?${query.toString()}`,
    );
    const page = parseProviderResourcePage(raw);
    resources.push(...page.resources);
    if (page.nextCursor === "end") {
      return resources;
    }
    cursor = page.nextCursor;
  }
  throw new Error("Provider destination discovery exceeded its page limit.");
}

function isActiveSlackAccount(account: IntegrationAccount): boolean {
  return account.provider === "slack" && account.lifecycle.kind === "active";
}

export async function fetchOrganisationMembers(
  organisationId: string,
): Promise<readonly OrganisationMember[]> {
  const raw = await controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/members`,
  );
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.members)) {
    throw new Error(readApiError(raw));
  }
  return raw.members.map(parseOrganisationMember);
}

export async function fetchOrganisationInvitations(
  organisationId: string,
): Promise<readonly OrganisationInvitation[]> {
  const raw = await controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/invitations`,
  );
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.invitations)) {
    throw new Error(readApiError(raw));
  }
  return raw.invitations.map(parseOrganisationInvitation);
}

export async function renameControlOrganisation(
  organisation: OrganisationListItem,
  name: string,
): Promise<void> {
  requireOrganisationMutationSuccess(
    await controlMutation(
      organisationControlPath(organisation.organisationId),
      "PATCH",
      { name },
      organisation.configurationVersion,
    ),
  );
}

export async function archiveControlOrganisation(
  organisation: OrganisationListItem,
): Promise<void> {
  requireOrganisationMutationSuccess(
    await controlMutation(
      `${organisationControlPath(organisation.organisationId)}/archive`,
      "POST",
      {},
      organisation.configurationVersion,
    ),
  );
}

export async function restoreControlOrganisation(
  organisation: OrganisationListItem,
): Promise<void> {
  requireOrganisationMutationSuccess(
    await controlMutation(
      `${organisationControlPath(organisation.organisationId)}/restore`,
      "POST",
      {},
      organisation.configurationVersion,
    ),
  );
}

export async function deleteControlOrganisation(
  organisation: OrganisationListItem,
): Promise<void> {
  const configurationVersion =
    organisation.lifecycle === "archived"
      ? organisation.configurationVersion
      : readConfigurationVersionFromMutation(
          await controlMutation(
            `${organisationControlPath(organisation.organisationId)}/archive`,
            "POST",
            {},
            organisation.configurationVersion,
          ),
        );
  requireOrganisationMutationSuccess(
    await controlMutation(
      organisationControlPath(organisation.organisationId),
      "DELETE",
      {},
      configurationVersion,
    ),
  );
}

function organisationControlPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}`;
}

function requireOrganisationMutationSuccess(raw: unknown): void {
  if (!isRecord(raw) || raw.kind !== "success")
    throw new Error(readApiError(raw));
}

export function readConfigurationVersionFromMutation(raw: unknown): number {
  if (
    !isRecord(raw) ||
    raw.kind !== "success" ||
    !isRecord(raw.projection) ||
    typeof raw.projection.configuration_version !== "number"
  ) {
    throw new Error(readApiError(raw));
  }
  return raw.projection.configuration_version;
}

export async function fetchOperatorOrganisationCase(
  organisationId: string,
): Promise<OperatorOrganisationCase> {
  const raw = await controlRead(
    `/v1/control/operator/onboarding?organisationId=${encodeURIComponent(organisationId)}`,
  );
  if (!isRecord(raw) || raw.kind !== "success" || !Array.isArray(raw.cases)) {
    throw new Error(readApiError(raw));
  }
  if (raw.cases.length === 0) throw new Error("Organisation was not found.");
  if (raw.cases.length !== 1)
    throw new Error("Organisation inspection was ambiguous.");
  return parseOperatorOrganisationCase(raw.cases[0]);
}

export async function archiveOwnerlessLegacyOrganisation(
  input: OperatorOrganisationCase,
): Promise<void> {
  const raw = await controlMutation(
    `/v1/control/operator/organisations/${encodeURIComponent(input.organisationId)}/actions`,
    "POST",
    { kind: "archive_ownerless_legacy_organisation" },
    input.configurationVersion,
  );
  if (
    !isRecord(raw) ||
    raw.kind !== "success" ||
    raw.action !== "archive_ownerless_legacy_organisation" ||
    !isRecord(raw.receipt)
  ) {
    throw new Error(readApiError(raw));
  }
}

export async function beginProviderConnection(
  organisationId: string,
  organisationHandle: string,
  workspaceHandle: string,
  provider: Provider,
  context: Record<string, string>,
  configurationVersion: number,
): Promise<ProviderStartResult> {
  const returnPath =
    provider === "dropbox" || provider === "google_drive"
      ? initialFileAccessPath(organisationHandle, workspaceHandle, provider)
      : workspacePagePath(organisationHandle, workspaceHandle, "overview");
  const raw = await controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/providers/${provider}/start`,
    "POST",
    { ...context, returnPath },
    configurationVersion,
  );
  if (
    !isRecord(raw) ||
    raw.kind !== "success" ||
    !isRecord(raw.attempt) ||
    typeof raw.attempt.attempt_id !== "string" ||
    typeof raw.authorization_url !== "string"
  ) {
    throw new Error(readApiError(raw));
  }
  return {
    authorizationUrl: new URL(raw.authorization_url).toString(),
  };
}

export async function fetchCommerceSystem(
  organisationId: string,
): Promise<CommerceSystemView | null> {
  return parseCommerceSystemResponse(
    await controlRead(commerceSystemPath(organisationId)),
  );
}

export async function provisionPantryCommerceDemo(
  organisationId: string,
): Promise<void> {
  const raw = await controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce-system/builtin-commerce/demo`,
    "POST",
    createPantryCommerceDemoRequest(),
  );
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.commerceSystem)) {
    throw new Error(readApiError(raw));
  }
  parseCommerceSystemIdentity(raw.commerceSystem);
}

export async function publishExportCoordination(
  organisationId: string,
  configurationVersion: number,
): Promise<void> {
  const raw = await controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/export-preset`,
    "POST",
    { presetId: "export_coordination", version: 1 },
    configurationVersion,
  );
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.publication)) {
    throw new Error(readApiError(raw));
  }
}

type PantryCommerceDemoRequest = Readonly<{
  readonly profile: "cafe_patisserie";
}>;

function createPantryCommerceDemoRequest(): PantryCommerceDemoRequest {
  return { profile: "cafe_patisserie" };
}

export async function queueCommerceSystemSync(organisationId: string): Promise<void> {
  const raw = await controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce-system/sync`,
    "POST",
    {},
  );
  if (!isRecord(raw) || raw.ok !== true || raw.outcome !== "sync_queued") {
    throw new Error(readApiError(raw));
  }
}

export async function selectShopifyCommerceSystem(
  organisationId: string,
  integrationAccountId: string,
  expectedRevision: number,
): Promise<void> {
  const raw = await controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce-system`,
    "PUT",
    {
      kind: "select_shopify",
      expected_revision: expectedRevision,
      integration_account_id: integrationAccountId,
    },
  );
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.commerceSystem)) {
    throw new Error(readApiError(raw));
  }
  parseCommerceSystemIdentity(raw.commerceSystem);
}

export async function beginExistingProviderConnection(
  organisationId: string,
  organisationHandle: string,
  workspaceHandle: string,
  integrationAccountId: string,
  configurationVersion: number,
  purpose: "reconnect" | "rotate",
): Promise<ProviderStartResult> {
  const raw = await controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/accounts/${encodeURIComponent(integrationAccountId)}/${purpose}`,
    "POST",
    {
      returnPath: workspacePagePath(
        organisationHandle,
        workspaceHandle,
        "overview",
      ),
    },
    configurationVersion,
  );
  if (
    !isRecord(raw) ||
    raw.kind !== "success" ||
    !isRecord(raw.attempt) ||
    typeof raw.attempt.attempt_id !== "string" ||
    typeof raw.authorization_url !== "string"
  ) {
    throw new Error(readApiError(raw));
  }
  return {
    authorizationUrl: new URL(raw.authorization_url).toString(),
  };
}

export function projectionStage(
  steps: readonly OnboardingStepProjection[],
  action: OnboardingNextAction,
): OnboardingStepProjection["step"] {
  if (action.kind === "done") {
    return "review_activation";
  }
  for (const step of steps) {
    if (step.kind !== "complete") {
      return step.step;
    }
  }
  return "review_activation";
}

export async function fetchReadiness(
  organisationId: string,
): Promise<ReadinessAssessment> {
  const raw = await controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/readiness`,
  );
  if (!isRecord(raw) || raw.kind !== "success" || !isRecord(raw.assessment)) {
    throw new Error(readApiError(raw));
  }
  return parseReadiness(raw.assessment);
}

/**
 * How the commerce page reads and writes price allowances.
 *
 * Writes need the CSRF token the control routes require; without it the
 * section still reads, and shows the band a proposed change would be judged
 * against rather than nothing at all.
 */
export function offerPriceAllowanceInteraction(
  canConfigure: boolean,
): OfferPriceAllowanceInteraction {
  const csrf = readCookie("pantry_csrf");
  return {
    canConfigure,
    transport: csrf === null ? undefined : offerPriceAllowanceTransport(csrf),
  };
}

export async function emitOnboardingStageViewed(
  organisationId: string,
  stage: string,
): Promise<void> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) return;
  // A view event: an answer, a refusal and a lost connection all end it.
  await controlSignal(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/onboarding/stage-viewed`,
    { stage },
  ).catch(ignoreFailure);
}

function ignoreFailure(): void {}
