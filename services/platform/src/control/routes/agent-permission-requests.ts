import type {
  DecidePendingDecision,
  PendingDecisionAnswer,
  PendingDecisionProof,
} from "../decide-pending-decision";
import {
  parseAgentPermissionDecision,
  type AgentPermissionGrantTarget,
  type AgentPermissionRequestList,
  type AgentPermissionRequestItem,
  type AgentPermissionRequestView,
} from "@purin-labs/control-api";
import { opaqueSubjectReference } from "../../access-control/references";
import {
  entityTypeReadAudiences,
  isOrganisationReadRole,
  missingEntityTypeReads,
  type EntityTypeReadAudience,
  type MissingEntityTypeRead,
} from "../../authorization/access-grants/entity-type-reads";
import { currentGrantedCapabilityIds } from "../../authorization/access-grants/turn-authority";
import {
  CAPABILITY_KEYS,
  capabilityDefinitionById,
} from "../../authorization/capability-catalogue";
import {
  ENTITY_TYPE_READ_CAPABILITY,
  entityTypeReadDescription,
  entityTypeReadLabel,
  requestableReadScope,
  type RequestableCapability,
  type RequestableEntityTypeRead,
} from "../../authorization/requestable-capabilities";
import {
  AGENT_PERMISSION_REQUEST_LIFETIME_MS,
  decideAgentPermissionRequest,
  listPendingAgentPermissionRequests,
  readAgentPermissionRequest,
  type AgentPermissionRequest,
} from "../../data/agent-permission-request";
import { readOrganisationCapabilityPolicies } from "../../data/capability-policy";
import { resolveOrganisationCommerceSystemAuthority } from "../../data/organisation-commerce-system";
import type { Env } from "../../env";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { slackSurfaceParts } from "../../slack/surface-parts";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { heldOutputSummaries } from "./held-output-requests";
import { controlError, controlJson, readJsonRecord } from "../http";
import type { AgentPermissionRequestSummary } from "@purin-labs/control-api";

export type AgentPermissionRequestRoute =
  | Readonly<{
      kind: "agentPermissionRequest";
      organisationIdRaw: string;
      requestId: string;
      transport: "view" | "decision";
    }>
  | Readonly<{
      kind: "agentPermissionRequest";
      organisationIdRaw: string;
      transport: "list";
    }>;

export function matchAgentPermissionRequestRoute(
  pathname: string,
): AgentPermissionRequestRoute | null {
  const list =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/permission-requests$/u.exec(
      pathname,
    );
  if (list !== null)
    try {
      return {
        kind: "agentPermissionRequest",
        organisationIdRaw: decodeURIComponent(list[1] ?? ""),
        transport: "list",
      };
    } catch {
      return null;
    }
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/permission-requests\/([0-9a-f]{32})(\/decision)?$/u.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    return {
      kind: "agentPermissionRequest",
      organisationIdRaw: decodeURIComponent(match[1] ?? ""),
      requestId: match[2] ?? "",
      transport: match[3] === undefined ? "view" : "decision",
    };
  } catch {
    return null;
  }
}

/**
 * The permission requests of Slack agent turns. Any member reads one; an
 * owner or admin decides it. The Portal changes the policy and the grants
 * through the existing Access mutations first. Allow then checks that the
 * requester's authority holds every capability and record-type read, records
 * the decision and releases the parked request; deny records it and stops
 * the request.
 */
export async function handleAgentPermissionRequestRoute(
  request: Request,
  env: Env,
  route: AgentPermissionRequestRoute,
  decide: DecidePendingDecision,
): Promise<Response> {
  if (route.transport === "list") {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const mayDecide = mayDecideAgentPermissionRequests(authorized);
    const list: AgentPermissionRequestList = {
      mayDecide,
      heldOutputs: await heldOutputSummaries(env, authorized),
      requests: await agentPermissionRequestSummaries(authorized),
    };
    return controlJson(list);
  }
  if (route.transport === "view") {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const stored = await readAgentPermissionRequest(
      authorized.executionScope.database,
      authorized.organisationId,
      route.requestId,
    );
    if (stored === null)
      return controlError("agent_permission_request_not_found", 404);
    const view = await permissionRequestView(
      authorized.executionScope,
      stored,
      authorized.membership.role === "owner" ||
        authorized.membership.role === "admin",
      Date.now(),
    );
    return view === null
      ? controlError("agent_permission_request_unavailable", 503)
      : controlJson(view);
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  const decision = body.ok ? parseAgentPermissionDecision(body.value) : null;
  if (decision === null)
    return controlError("agent_permission_decision_invalid", 422);
  return decide(
    { request, organisationIdRaw: route.organisationIdRaw },
    {
      kind: "permission_request",
      id: route.requestId,
      answer: decision === "allow" ? "allow" : "refuse",
    },
  );
}

/**
 * Records the answer of an owner or admin to one permission request, and
 * gives it to the thread or the chat that waits.
 */
export async function decideAgentPermission(
  env: Env,
  proof: PendingDecisionProof,
  call: Readonly<{ id: string; answer: PendingDecisionAnswer }>,
): Promise<Response> {
  const decision = call.answer === "allow" ? "allow" : "deny";
  const authorized = await authorizeOrganisationRequest(
    proof.request,
    env,
    proof.organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const scope = authorized.executionScope;
  const now = Date.now();
  const stored = await readAgentPermissionRequest(
    scope.database,
    authorized.organisationId,
    call.id,
  );
  if (stored === null)
    return controlError("agent_permission_request_not_found", 404);
  let decided = stored;
  if (stored.status === "pending") {
    if (stored.createdAt + AGENT_PERMISSION_REQUEST_LIFETIME_MS < now)
      return controlError("agent_permission_request_expired", 409);
    if (decision === "allow") {
      const missing = await missingItems(scope, stored, now);
      if (missing === null)
        return controlError("agent_permission_request_unavailable", 503);
      if (missing.capabilityIds.length + missing.entityTypeReads.length > 0)
        return controlJson(
          { ok: false, error: "permission_missing", ...missing },
          409,
        );
    }
    const recorded = await decideAgentPermissionRequest(scope, {
      requestId: stored.requestId,
      status: decision === "allow" ? "allowed" : "denied",
      userId: authorized.authenticated.session.userId,
      now,
    });
    if (!recorded.ok)
      return controlError("agent_permission_request_unavailable", 503);
    decided = recorded.value;
  }
  if (decided.status !== (decision === "allow" ? "allowed" : "denied"))
    return controlError("agent_permission_request_decided", 409);
  // The decision is stored. When Slack cannot take it now, the scheduled
  // reconciliation hands it to the thread once Slack works; a repeated
  // decision tries again at once.
  const released = await slackSurfaceParts
    .use()
    .releaseAgentPermissionDecision(env, scope, decided);
  return controlJson({
    ok: true,
    status: decided.status,
    waitingForSlack: !released,
  });
}

async function permissionRequestView(
  scope: OrganisationExecutionScope,
  stored: AgentPermissionRequest,
  mayDecide: boolean,
  now: number,
): Promise<AgentPermissionRequestView | null> {
  const [policies, granted, readsMissing] = await Promise.all([
    readOrganisationCapabilityPolicies({
      db: scope.database,
      organisationId: scope.organisationId,
    }),
    currentGrantedCapabilityIds({
      db: scope.database,
      organisationId: scope.organisationId,
      requestAuthority: stored.requestAuthority,
    }),
    missingEntityTypeReads({
      db: scope.database,
      organisationId: scope.organisationId,
      requestAuthority: stored.requestAuthority,
      reads: stored.entityTypeReads,
      causationId: stored.requestId,
      now,
    }),
  ]);
  if (!policies.ok || !granted.ok || !readsMissing.ok) return null;
  const subjectRefId = await opaqueSubjectReference(scope.organisationId, {
    kind: "organisation_role",
    firstId: stored.requesterRole,
    secondId: null,
    revision: 1,
  });
  const subjectLabel = roleLabel(stored.requesterRole);
  const items: AgentPermissionRequestItem[] = [];
  const read = capabilityDefinitionById(ENTITY_TYPE_READ_CAPABILITY);
  const readMode = policyMode(
    policies.value,
    read.capabilityId,
    read.capabilityVersion,
  );
  const capabilityRef = {
    capabilityId: read.capabilityId,
    capabilityVersion: read.capabilityVersion,
  };
  for (const entityType of stored.entityTypeReads)
    for (const audience of entityTypeReadAudiences(
      stored.requestAuthority,
      entityType,
    ))
      items.push({
        itemId: `${read.capabilityId}:${entityType}:${audience}`,
        ...capabilityRef,
        label: entityTypeReadLabel(entityType),
        description: entityTypeReadDescription(entityType, audience),
        mode: readMode,
        granted:
          readMode === "enabled" &&
          !readsMissing.value.some(isMissing.bind(null, entityType, audience)),
        grant: {
          ...(audience === "conversation"
            ? await conversationSubject(scope, stored)
            : isOrganisationReadRole(audience)
              ? await roleSubject(scope, audience)
              : { subjectRef: { subjectRefId, revision: 1 }, subjectLabel }),
          target: readGrantTarget(capabilityRef, entityType),
        },
      });
  for (const capabilityId of stored.capabilityIds) {
    const definition = capabilityDefinitionById(capabilityId);
    const capabilityRef = {
      capabilityId,
      capabilityVersion: definition.capabilityVersion,
    };
    const proposal = capabilityId === CAPABILITY_KEYS.commerceActionPropose;
    const target: AgentPermissionGrantTarget | null = proposal
      ? await shopProposalTarget(scope, capabilityRef)
      : { kind: "platform", capabilityRef };
    if (target === null) return null;
    items.push({
      itemId: capabilityId,
      ...capabilityRef,
      label: definition.label,
      description: proposal
        ? SHOP_PROPOSAL_DESCRIPTION
        : definition.description,
      mode: policyMode(
        policies.value,
        capabilityId,
        definition.capabilityVersion,
      ),
      granted: granted.value.has(capabilityId),
      grant: {
        subjectRef: { subjectRefId, revision: 1 },
        subjectLabel,
        target,
      },
    });
  }
  return {
    requestId: stored.requestId,
    status: stored.status,
    expired:
      stored.status === "pending" &&
      stored.createdAt + AGENT_PERMISSION_REQUEST_LIFETIME_MS < now,
    createdAt: stored.createdAt,
    decidedAt: stored.decidedAt,
    requesterRole: stored.requesterRole,
    origin: stored.origin.kind,
    threadUrl: slackThreadUrl(stored),
    waitingForSlack:
      stored.origin.kind === "slack_thread" &&
      stored.status !== "pending" &&
      stored.releasedAt === null,
    mayDecide,
    items,
  };
}

/**
 * The requested items that the requester's authority lacks now. A record-type
 * read needs its grant and the read capability turned on.
 */
async function missingItems(
  scope: OrganisationExecutionScope,
  stored: AgentPermissionRequest,
  now: number,
): Promise<Readonly<{
  capabilityIds: readonly RequestableCapability[];
  entityTypeReads: readonly RequestableEntityTypeRead[];
}> | null> {
  const [granted, policies, readsMissing] = await Promise.all([
    currentGrantedCapabilityIds({
      db: scope.database,
      organisationId: scope.organisationId,
      requestAuthority: stored.requestAuthority,
    }),
    readOrganisationCapabilityPolicies({
      db: scope.database,
      organisationId: scope.organisationId,
    }),
    missingEntityTypeReads({
      db: scope.database,
      organisationId: scope.organisationId,
      requestAuthority: stored.requestAuthority,
      reads: stored.entityTypeReads,
      causationId: stored.requestId,
      now,
    }),
  ]);
  if (!granted.ok || !policies.ok || !readsMissing.ok) return null;
  const read = capabilityDefinitionById(ENTITY_TYPE_READ_CAPABILITY);
  const readEnabled =
    policyMode(policies.value, read.capabilityId, read.capabilityVersion) ===
    "enabled";
  return {
    capabilityIds: stored.capabilityIds.filter(
      isMissingFrom.bind(null, granted.value),
    ),
    entityTypeReads: readEnabled
      ? [...new Set(readsMissing.value.map(missingRead))]
      : stored.entityTypeReads,
  };
}

function isMissing(
  read: RequestableEntityTypeRead,
  audience: EntityTypeReadAudience,
  missing: MissingEntityTypeRead,
): boolean {
  return missing.read === read && missing.audience === audience;
}

function missingRead(
  missing: MissingEntityTypeRead,
): RequestableEntityTypeRead {
  return missing.read;
}

function isMissingFrom(
  granted: ReadonlySet<string>,
  capability: RequestableCapability,
): boolean {
  return !granted.has(capability);
}

/**
 * The Slack channel of a channel request. A channel turn answers everyone in
 * the channel, so its commerce reads need a grant for the channel.
 */
async function conversationSubject(
  scope: OrganisationExecutionScope,
  stored: AgentPermissionRequest,
): Promise<
  Pick<AgentPermissionRequestItem["grant"], "subjectRef" | "subjectLabel">
> {
  const authority = stored.requestAuthority;
  if (authority.kind !== "shared_conversation")
    throw new Error("Only a Slack channel request has a channel subject");
  const subjectRefId = await opaqueSubjectReference(scope.organisationId, {
    kind: "conversation",
    firstId: authority.integrationAccountId,
    secondId: authority.conversationId,
    revision: 1,
  });
  return {
    subjectRef: { subjectRefId, revision: 1 },
    subjectLabel: "this Slack channel",
  };
}

function capabilityLabel(capabilityId: RequestableCapability): string {
  return capabilityDefinitionById(capabilityId).label;
}

function policyMode(
  policies: readonly Readonly<{
    capabilityId: string;
    capabilityVersion: number;
    mode: AgentPermissionRequestItem["mode"];
  }>[],
  capabilityId: string,
  capabilityVersion: number,
): AgentPermissionRequestItem["mode"] {
  for (const policy of policies)
    if (
      policy.capabilityId === capabilityId &&
      policy.capabilityVersion === capabilityVersion
    )
      return policy.mode;
  return "disabled";
}

async function roleSubject(
  scope: OrganisationExecutionScope,
  role: AgentPermissionRequest["requesterRole"],
) {
  const subjectRefId = await opaqueSubjectReference(scope.organisationId, {
    kind: "organisation_role",
    firstId: role,
    secondId: null,
    revision: 1,
  });
  return {
    subjectRef: { subjectRefId, revision: 1 },
    subjectLabel: roleLabel(role),
  };
}

function roleLabel(role: AgentPermissionRequest["requesterRole"]): string {
  switch (role) {
    case "owner":
      return "Owners";
    case "admin":
      return "Admins";
    case "operator":
      return "Operators";
    case "viewer":
      return "Viewers";
  }
}

function slackThreadUrl(stored: AgentPermissionRequest): string | null {
  if (stored.origin.kind !== "slack_thread") return null;
  const workspace = encodeURIComponent(stored.origin.slackWorkspaceId);
  const channel = encodeURIComponent(stored.origin.slackChannelId);
  const thread = encodeURIComponent(
    `${stored.origin.slackChannelId}-${stored.origin.slackThreadTs}`,
  );
  return `https://app.slack.com/client/${workspace}/${channel}/thread/${thread}`;
}

const SHOP_PROPOSAL_DESCRIPTION =
  "Prepare a change to a price, a listing, a product description, fulfilment tracking or a merchant plugin in this shop. Purin Pantry makes no change until an owner or admin approves it, each time.";

/**
 * A proposal grant covers every record of the Organisation's shop. A proposal
 * changes nothing by itself: each change waits for its own approval.
 */
async function shopProposalTarget(
  scope: OrganisationExecutionScope,
  capabilityRef: Readonly<{ capabilityId: string; capabilityVersion: number }>,
): Promise<AgentPermissionGrantTarget | null> {
  const shop = await resolveOrganisationCommerceSystemAuthority({
    db: scope.database,
    organisationId: scope.organisationId,
  });
  return shop.ok
    ? {
        kind: "provider_resource",
        capabilityRef,
        integrationRef: `integration:${shop.value.integrationAccountId}`,
        resourceRef: "provider_resource:*",
      }
    : null;
}

/** The grant that admits one requestable read: a record type or a list. */
function readGrantTarget(
  capabilityRef: Readonly<{ capabilityId: string; capabilityVersion: number }>,
  read: RequestableEntityTypeRead,
): AgentPermissionGrantTarget {
  const scope = requestableReadScope(read);
  switch (scope.kind) {
    case "entity_type":
      return {
        kind: "commerce_entity_type",
        capabilityRef,
        entityTypeId: { origin: "system", typeId: scope.typeId },
      };
    case "commerce_list":
      return { kind: "commerce_list", capabilityRef, listId: scope.listId };
  }
}

/** An owner or admin decides a permission request. */
export function mayDecideAgentPermissionRequests(
  authorized: AuthorizedOrganisationRequest,
): boolean {
  return (
    authorized.membership.role === "owner" ||
    authorized.membership.role === "admin"
  );
}

/**
 * The permission requests that wait, as this member may read them: an owner
 * or admin reads every request of the Organisation, and another member reads
 * their own.
 */
export async function agentPermissionRequestSummaries(
  authorized: AuthorizedOrganisationRequest,
): Promise<readonly AgentPermissionRequestSummary[]> {
  const pending = await listPendingAgentPermissionRequests(
    authorized.executionScope.database,
    {
      organisationId: authorized.organisationId,
      requesterPersonId: mayDecideAgentPermissionRequests(authorized)
        ? null
        : String(authorized.membership.personId),
      now: Date.now(),
    },
  );
  return pending.map(({ request: stored, requesterName }) => ({
    requestId: stored.requestId,
    origin: stored.origin.kind,
    requesterName,
    requesterRole: stored.requesterRole,
    itemLabels: [
      ...stored.entityTypeReads.map(entityTypeReadLabel),
      ...stored.capabilityIds.map(capabilityLabel),
    ],
    createdAt: stored.createdAt,
    expiresAt: stored.createdAt + AGENT_PERMISSION_REQUEST_LIFETIME_MS,
  }));
}
