import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  OrganisationAccess,
  OrganisationAdmissionAction,
  OrganisationUserAuthority,
} from "@purin-labs/tenancy/organisation-access/access";
import type {
  ConnectorId,
  PrincipalId,
  RequestAuthority,
} from "@purin-labs/contracts";

import type { GrantSubject } from "../authorization/access-grants/types";
import {
  inboxSubjectReads,
  workflowSubjectReads,
} from "../access-control/subject-reads";
import {
  parseConnectorId,
  parseIntegrationAccountId,
  parsePersonId,
  parseOrganisationId,
  parseWorkspaceId,
  type ConnectorId as LocalConnectorId,
  type IntegrationAccountId,
  type PersonId,
  type OrganisationId,
  type WorkspaceId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  hasExactKeys,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";

export type { GrantSubject } from "../authorization/access-grants/types";

type RawRecord = Record<string, unknown>;

type RequestAuthorityBoundaryError =
  | { readonly code: "invalid_input"; readonly field: string }
  | { readonly code: "missing_field"; readonly field: string }
  | { readonly code: "invalid_field"; readonly field: string }
  | { readonly code: "unknown_slack_conversation_kind"; readonly value: string }
  | { readonly code: "cross_organisation_scope"; readonly field: string }
  | { readonly code: "cross_workspace_scope"; readonly field: string };

type RequestAuthorityProjection = {
  readonly requestAuthority: RequestAuthority;
};

export type LiveRequestAuthorityValidationError =
  | { readonly code: "request_authority_inactive"; readonly detail: string }
  | { readonly code: "request_authority_unavailable"; readonly detail: string };

type DirectSlackAuthorityInput = {
  readonly organisationId: OrganisationId;
  readonly requesterPersonId: PrincipalId;
  readonly membershipRevision: number;
  readonly role: string;
  readonly connectorId: ConnectorId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly conversationId: string;
};

type SharedSlackAuthorityInput = DirectSlackAuthorityInput;

type WorkflowAuthorityInput = {
  readonly organisationId: OrganisationId;
  readonly workflowId: string;
  readonly workflowRevision: number;
};

type ControlAuthorityInput = {
  readonly organisationId: OrganisationId;
  readonly requesterPersonId: PrincipalId;
  readonly userId: string;
  readonly membershipRevision: number;
  readonly role: string;
};

type AgentMailboxAuthorityInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly mailboxBindingId: string;
  readonly bindingRevision: number;
  readonly mailboxPolicyVersion: number;
};

type WhatsAppSupportAuthorityInput = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly supportBindingId: string;
  readonly bindingRevision: number;
  readonly ingressPolicyVersion: number;
};

type ParsedSlackAuthority = {
  readonly organisationId: OrganisationId;
  readonly requesterPersonId: PersonId;
  readonly membershipRevision: number;
  readonly role: string;
  readonly connectorId: LocalConnectorId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly conversationId: string;
  readonly conversationKind: SlackConversationKind;
  readonly workspaceId: WorkspaceId;
};

type SlackConversationKind = "im" | "channel" | "group" | "mpim";

const SHARED_SLACK_CONVERSATION_KINDS = ["channel", "group", "mpim"] as const;

export function parseDirectSlackAuthority(
  raw: unknown,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  const parsed = parseScopedSlackAuthority(raw);

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.conversationKind !== "im") {
    return {
      ok: false,
      error: {
        code: "unknown_slack_conversation_kind",
        value: parsed.value.conversationKind,
      },
    };
  }

  return {
    ok: true,
    value: buildDirectSlackAuthority(parsed.value),
  };
}

export function parseSharedSlackAuthority(
  raw: unknown,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  const parsed = parseScopedSlackAuthority(raw);

  if (!parsed.ok) {
    return parsed;
  }

  if (!isSharedSlackConversationKind(parsed.value.conversationKind)) {
    return {
      ok: false,
      error: {
        code: "unknown_slack_conversation_kind",
        value: parsed.value.conversationKind,
      },
    };
  }

  return {
    ok: true,
    value: buildSharedSlackAuthority(parsed.value),
  };
}

export function parseCueSubscriptionAuthority(
  raw: unknown,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  const parsed = parseWorkflowAuthority(raw);

  return parsed.ok
    ? { ok: true, value: buildWorkflowAuthority(parsed.value) }
    : parsed;
}

export function parseControlAuthority(
  raw: unknown,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  const parsed = parseRawControlAuthority(raw);

  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    value: buildControlAuthority(parsed.value),
  };
}

export function parseStoredRequestAuthority(
  raw: unknown,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  const record = readRecord(raw, "requestAuthority");
  if (!record.ok) return record;
  const kind = readNonEmptyString(record.value.kind, "requestAuthority.kind");
  if (!kind.ok) return kind;
  switch (kind.value) {
    case "direct_conversation":
      return parseStoredConversationAuthority(
        record.value,
        "direct_conversation",
      );
    case "shared_conversation":
      return parseStoredConversationAuthority(
        record.value,
        "shared_conversation",
      );
    case "workflow":
      return parseStoredWorkflowAuthority(record.value);
    case "agent_mailbox":
      return parseStoredAgentMailboxAuthority(record.value);
    case "whatsapp_support":
      return parseStoredWhatsAppSupportAuthority(record.value);
    case "control":
      return parseStoredControlAuthority(record.value);
    default:
      return {
        ok: false,
        error: { code: "invalid_field", field: "requestAuthority.kind" },
      };
  }
}

function parseStoredConversationAuthority(
  record: RawRecord,
  kind: "direct_conversation" | "shared_conversation",
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  const organisationId = readOrganisationId(
    record.organisationId,
    "requestAuthority.organisationId",
  );
  const requesterPersonId = readPersonId(
    record.requesterPersonId,
    "requestAuthority.requesterPersonId",
  );
  const membershipRevision = readPositiveRevision(
    record.membershipRevision,
    "requestAuthority.membershipRevision",
  );
  const role = readNonEmptyString(record.role, "requestAuthority.role");
  const connectorId = readConnectorId(
    record.connectorId,
    "requestAuthority.connectorId",
  );
  const integrationAccountId = readIntegrationAccountId(
    record.integrationAccountId,
    "requestAuthority.integrationAccountId",
  );
  const conversationId = readNonEmptyString(
    record.conversationId,
    "requestAuthority.conversationId",
  );
  if (!organisationId.ok) return organisationId;
  if (!requesterPersonId.ok) return requesterPersonId;
  if (!membershipRevision.ok) return membershipRevision;
  if (!role.ok) return role;
  if (!connectorId.ok) return connectorId;
  if (!integrationAccountId.ok) return integrationAccountId;
  if (!conversationId.ok) return conversationId;
  const input: DirectSlackAuthorityInput = {
    organisationId: organisationId.value,
    requesterPersonId: requesterPersonId.value,
    membershipRevision: membershipRevision.value,
    role: role.value,
    connectorId: connectorId.value,
    integrationAccountId: integrationAccountId.value,
    conversationId: conversationId.value,
  };
  return {
    ok: true,
    value:
      kind === "direct_conversation"
        ? buildDirectSlackAuthority(input)
        : buildSharedSlackAuthority(input),
  };
}

function parseStoredWorkflowAuthority(
  record: RawRecord,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  if (
    !hasExactKeys(record, [
      "kind",
      "organisationId",
      "workflowId",
      "workflowRevision",
    ])
  ) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "requestAuthority" },
    };
  }
  const organisationId = readOrganisationId(
    record.organisationId,
    "requestAuthority.organisationId",
  );
  const workflowId = readNonEmptyString(
    record.workflowId,
    "requestAuthority.workflowId",
  );
  const workflowRevision = readPositiveRevision(
    record.workflowRevision,
    "requestAuthority.workflowRevision",
  );
  if (!organisationId.ok) return organisationId;
  if (!workflowId.ok) return workflowId;
  if (!workflowRevision.ok) return workflowRevision;
  return {
    ok: true,
    value: buildWorkflowAuthority({
      organisationId: organisationId.value,
      workflowId: workflowId.value,
      workflowRevision: workflowRevision.value,
    }),
  };
}

function parseStoredAgentMailboxAuthority(
  record: RawRecord,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  if (
    !hasExactKeys(record, [
      "kind",
      "organisationId",
      "integrationAccountId",
      "mailboxBindingId",
      "bindingRevision",
      "mailboxPolicyVersion",
    ])
  ) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "requestAuthority" },
    };
  }
  const organisationId = readOrganisationId(
    record.organisationId,
    "requestAuthority.organisationId",
  );
  const integrationAccountId = readIntegrationAccountId(
    record.integrationAccountId,
    "requestAuthority.integrationAccountId",
  );
  const mailboxBindingId = readNonEmptyString(
    record.mailboxBindingId,
    "requestAuthority.mailboxBindingId",
  );
  const bindingRevision = readPositiveRevision(
    record.bindingRevision,
    "requestAuthority.bindingRevision",
  );
  const mailboxPolicyVersion = readPositiveRevision(
    record.mailboxPolicyVersion,
    "requestAuthority.mailboxPolicyVersion",
  );
  if (!organisationId.ok) return organisationId;
  if (!integrationAccountId.ok) return integrationAccountId;
  if (!mailboxBindingId.ok) return mailboxBindingId;
  if (!bindingRevision.ok) return bindingRevision;
  if (!mailboxPolicyVersion.ok) return mailboxPolicyVersion;
  return {
    ok: true,
    value: buildAgentMailboxAuthority({
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      mailboxBindingId: mailboxBindingId.value,
      bindingRevision: bindingRevision.value,
      mailboxPolicyVersion: mailboxPolicyVersion.value,
    }),
  };
}

function parseStoredWhatsAppSupportAuthority(
  record: RawRecord,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  if (
    !hasExactKeys(record, [
      "kind",
      "organisationId",
      "integrationAccountId",
      "supportBindingId",
      "bindingRevision",
      "ingressPolicyVersion",
    ])
  ) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "requestAuthority" },
    };
  }
  const organisationId = readOrganisationId(
    record.organisationId,
    "requestAuthority.organisationId",
  );
  const integrationAccountId = readIntegrationAccountId(
    record.integrationAccountId,
    "requestAuthority.integrationAccountId",
  );
  const supportBindingId = readNonEmptyString(
    record.supportBindingId,
    "requestAuthority.supportBindingId",
  );
  const bindingRevision = readPositiveRevision(
    record.bindingRevision,
    "requestAuthority.bindingRevision",
  );
  const ingressPolicyVersion = readPositiveRevision(
    record.ingressPolicyVersion,
    "requestAuthority.ingressPolicyVersion",
  );
  if (!organisationId.ok) return organisationId;
  if (!integrationAccountId.ok) return integrationAccountId;
  if (!supportBindingId.ok) return supportBindingId;
  if (!bindingRevision.ok) return bindingRevision;
  if (!ingressPolicyVersion.ok) return ingressPolicyVersion;
  return {
    ok: true,
    value: buildWhatsAppSupportAuthority({
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      supportBindingId: supportBindingId.value,
      bindingRevision: bindingRevision.value,
      ingressPolicyVersion: ingressPolicyVersion.value,
    }),
  };
}

function parseStoredControlAuthority(
  record: RawRecord,
): Result<RequestAuthorityProjection, RequestAuthorityBoundaryError> {
  const organisationId = readOrganisationId(
    record.organisationId,
    "requestAuthority.organisationId",
  );
  const requesterPersonId = readPersonId(
    record.requesterPersonId,
    "requestAuthority.requesterPersonId",
  );
  const userId = readScopedIdentifier(record.userId, "requestAuthority.userId");
  const membershipRevision = readPositiveRevision(
    record.membershipRevision,
    "requestAuthority.membershipRevision",
  );
  const role = readNonEmptyString(record.role, "requestAuthority.role");
  if (!organisationId.ok) return organisationId;
  if (!requesterPersonId.ok) return requesterPersonId;
  if (!userId.ok) return userId;
  if (!membershipRevision.ok) return membershipRevision;
  if (!role.ok) return role;
  return {
    ok: true,
    value: buildControlAuthority({
      organisationId: organisationId.value,
      requesterPersonId: requesterPersonId.value,
      userId: userId.value,
      membershipRevision: membershipRevision.value,
      role: role.value,
    }),
  };
}

export function buildDirectSlackAuthority(
  input: DirectSlackAuthorityInput | ParsedSlackAuthority,
): RequestAuthorityProjection {
  const requestAuthority: RequestAuthority = {
    kind: "direct_conversation",
    organisationId: input.organisationId,
    requesterPersonId: input.requesterPersonId,
    membershipRevision: input.membershipRevision,
    role: input.role,
    connectorId: input.connectorId,
    integrationAccountId: input.integrationAccountId,
    conversationId: input.conversationId,
  };

  return { requestAuthority };
}

export function buildSharedSlackAuthority(
  input: SharedSlackAuthorityInput | ParsedSlackAuthority,
): RequestAuthorityProjection {
  const requestAuthority: RequestAuthority = {
    kind: "shared_conversation",
    organisationId: input.organisationId,
    requesterPersonId: input.requesterPersonId,
    membershipRevision: input.membershipRevision,
    role: input.role,
    connectorId: input.connectorId,
    integrationAccountId: input.integrationAccountId,
    conversationId: input.conversationId,
  };

  return { requestAuthority };
}

export function buildWorkflowAuthority(
  input: WorkflowAuthorityInput,
): Readonly<{ requestAuthority: Variant<RequestAuthority, "workflow"> }> {
  const requestAuthority: Variant<RequestAuthority, "workflow"> = {
    kind: "workflow",
    organisationId: input.organisationId,
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
  };
  return { requestAuthority };
}

export function buildControlAuthority(input: ControlAuthorityInput): Readonly<{
  readonly requestAuthority: Variant<RequestAuthority, "control">;
}> {
  const requestAuthority: Variant<RequestAuthority, "control"> = {
    kind: "control",
    organisationId: input.organisationId,
    requesterPersonId: input.requesterPersonId,
    userId: input.userId,
    membershipRevision: input.membershipRevision,
    role: input.role,
  };
  return { requestAuthority };
}

export function buildAgentMailboxAuthority(
  input: AgentMailboxAuthorityInput,
): Readonly<{ requestAuthority: Variant<RequestAuthority, "agent_mailbox"> }> {
  const requestAuthority: Variant<RequestAuthority, "agent_mailbox"> = {
    kind: "agent_mailbox",
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    mailboxBindingId: input.mailboxBindingId,
    bindingRevision: input.bindingRevision,
    mailboxPolicyVersion: input.mailboxPolicyVersion,
  };
  return { requestAuthority };
}

export function buildWhatsAppSupportAuthority(
  input: WhatsAppSupportAuthorityInput,
): RequestAuthorityProjection {
  const requestAuthority: RequestAuthority = {
    kind: "whatsapp_support",
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    supportBindingId: input.supportBindingId,
    bindingRevision: input.bindingRevision,
    ingressPolicyVersion: input.ingressPolicyVersion,
  };
  return { requestAuthority };
}

export function grantSubjectsForAuthority(
  authority: RequestAuthority,
): readonly GrantSubject[] {
  switch (authority.kind) {
    case "direct_conversation":
      return [
        { kind: "organisation_role", role: authority.role },
        { kind: "person", personId: authority.requesterPersonId },
      ];
    case "shared_conversation":
      return [
        { kind: "organisation_role", role: authority.role },
        {
          kind: "conversation",
          integrationAccountId: authority.integrationAccountId,
          conversationId: authority.conversationId,
        },
      ];
    case "workflow":
      return [
        {
          kind: "workflow",
          workflowKind: "cue_subscription",
          workflowId: authority.workflowId,
          workflowRevision: authority.workflowRevision,
        },
      ];
    case "agent_mailbox":
      return [
        {
          kind: "agent_mailbox",
          integrationAccountId: authority.integrationAccountId,
          mailboxBindingId: authority.mailboxBindingId,
          bindingRevision: authority.bindingRevision,
        },
      ];
    case "whatsapp_support":
      return [
        {
          kind: "whatsapp_support",
          integrationAccountId: authority.integrationAccountId,
          supportBindingId: authority.supportBindingId,
          bindingRevision: authority.bindingRevision,
        },
      ];
    case "control":
      return [{ kind: "organisation_role", role: authority.role }];
    default:
      return assertNever(authority, "unhandled request authority branch");
  }
}

export async function validateLiveRequestAuthority(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly authority: RequestAuthority;
    readonly accountAccess: OrganisationAccess;
    readonly userAuthority: OrganisationUserAuthority;
    readonly action: OrganisationAdmissionAction;
  }>,
): Promise<Result<null, LiveRequestAuthorityValidationError>> {
  // Both checks only read, so they run at once. The account answer decides
  // first, as when they ran one after the other.
  const [account, native] = await Promise.all([
    input.accountAccess.checkAuthority({
      authority: input.authority,
      userAuthority: input.userAuthority,
      action: input.action,
    }),
    validateNativeRequestAuthority(input),
  ]);
  if (!account.ok) {
    return {
      ok: false,
      error: {
        code:
          account.error.code === "authority_unavailable"
            ? "request_authority_unavailable"
            : "request_authority_inactive",
        detail: account.error.code,
      },
    };
  }
  return native;
}

/** Revalidate an explicit native automation grant without a user-session assertion. */
export async function validateLiveAutomationAuthority(
  input: Readonly<{
    db: OrganisationDatabase;
    authority: Variant<
      RequestAuthority,
      "workflow" | "agent_mailbox" | "whatsapp_support"
    >;
    accountAccess: OrganisationAccess;
    action: OrganisationAdmissionAction;
  }>,
): Promise<Result<null, LiveRequestAuthorityValidationError>> {
  // Both checks only read, so they run at once. The account answer decides
  // first, as when they ran one after the other.
  const [account, native] = await Promise.all([
    input.accountAccess.checkAutomation({
      authority: input.authority,
      action: input.action,
    }),
    validateNativeRequestAuthority(input),
  ]);
  if (!account.ok) {
    return {
      ok: false,
      error: {
        code:
          account.error.code === "authority_unavailable"
            ? "request_authority_unavailable"
            : "request_authority_inactive",
        detail: account.error.code,
      },
    };
  }
  return native;
}

/** Validate the native authority when creating a label; this grants no protected access. */
export async function validateNativeRequestAuthority(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly authority: RequestAuthority;
  }>,
): Promise<Result<null, LiveRequestAuthorityValidationError>> {
  try {
    const active = await liveRequestAuthorityIsActive(
      input.db,
      input.authority,
    );
    return active
      ? { ok: true, value: null }
      : {
          ok: false,
          error: {
            code: "request_authority_inactive",
            detail: input.authority.kind,
          },
        };
  } catch {
    return {
      ok: false,
      error: {
        code: "request_authority_unavailable",
        detail: input.authority.kind,
      },
    };
  }
}

/**
 * The same Slack requester's authority at the current configuration version
 * and with their current role, or null when they hold no active membership.
 * A request that continues later uses it: an Access change advances the
 * configuration version, which supersedes the authority of the asking turn.
 */
export async function refreshSlackRequestAuthority(
  db: OrganisationDatabase,
  authority: Variant<
    RequestAuthority,
    "direct_conversation" | "shared_conversation"
  >,
): Promise<Variant<
  RequestAuthority,
  "direct_conversation" | "shared_conversation"
> | null> {
  const row = await db
    .prepare(
      `SELECT membership.role AS role,
              onboarding.configuration_version AS revision
       FROM integration_account AS account
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = account.organisation_id
        AND onboarding.environment = account.environment
       JOIN service_role_grant AS membership
         ON membership.organisation_id = account.organisation_id
        AND membership.person_id = ?
       WHERE account.organisation_id = ?
         AND account.integration_account_id = ?
         AND membership.status = 'active'
       LIMIT 1`,
    )
    .bind(
      authority.requesterPersonId,
      authority.organisationId,
      authority.integrationAccountId,
    )
    .first<{ readonly role: unknown; readonly revision: unknown }>();
  if (
    row === null ||
    typeof row.role !== "string" ||
    !isPositiveInteger(row.revision)
  )
    return null;
  const refreshed = {
    ...authority,
    role: row.role,
    membershipRevision: row.revision,
  };
  return (await liveSlackAuthorityIsActive(db, refreshed)) ? refreshed : null;
}

async function liveRequestAuthorityIsActive(
  db: OrganisationDatabase,
  authority: RequestAuthority,
): Promise<boolean> {
  switch (authority.kind) {
    case "direct_conversation":
    case "shared_conversation":
      return liveSlackAuthorityIsActive(db, authority);
    case "control":
      return liveControlAuthorityIsActive(db, authority);
    case "workflow":
      return liveWorkflowAuthorityIsActive(db, authority);
    case "agent_mailbox":
      return inboxSubjectReads.use().agentMailboxAuthorityIsLive(db, authority);
    case "whatsapp_support":
      return inboxSubjectReads
        .use()
        .whatsAppSupportAuthorityIsLive(db, authority);
    default:
      return assertNever(authority, "unhandled request authority branch");
  }
}

async function liveSlackAuthorityIsActive(
  db: OrganisationDatabase,
  authority: Variant<
    RequestAuthority,
    "direct_conversation" | "shared_conversation"
  >,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present
       FROM organisation AS organisation
       JOIN integration_account AS account
         ON account.organisation_id = organisation.organisation_id
        AND account.integration_account_id = ?
       JOIN provider_connection AS connection
         ON connection.provider_connection_id = account.provider_connection_id
        AND connection.organisation_id = account.organisation_id
        AND connection.provider = account.provider
        AND connection.environment = account.environment
       JOIN provider_credential_generation AS generation
         ON generation.provider_connection_id = connection.provider_connection_id
        AND generation.credential_generation = connection.credential_generation
        AND generation.organisation_id = connection.organisation_id
        AND generation.provider = connection.provider
        AND generation.environment = connection.environment
        AND generation.credential_ref = connection.credential_ref
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = account.organisation_id
        AND onboarding.environment = account.environment
       JOIN service_role_grant AS membership
         ON membership.organisation_id = organisation.organisation_id
        AND membership.person_id = ?
       WHERE organisation.organisation_id = ?
         AND organisation.status = 'active'
         AND account.provider = 'slack'
         AND account.lifecycle = 'active'
         AND connection.lifecycle = 'active'
         AND generation.lifecycle = 'active'
         AND membership.status = 'active'
         AND membership.role = ?
         AND onboarding.configuration_version = ?
         AND ? = 'connector_slack_' || account.integration_account_id
       LIMIT 1`,
    )
    .bind(
      authority.integrationAccountId,
      authority.requesterPersonId,
      authority.organisationId,
      authority.role,
      authority.membershipRevision,
      authority.connectorId,
    )
    .first<{ readonly present: 1 }>();
  return row?.present === 1;
}

async function liveControlAuthorityIsActive(
  db: OrganisationDatabase,
  authority: Variant<RequestAuthority, "control">,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present
       FROM organisation AS organisation
       JOIN service_role_grant AS membership
         ON membership.organisation_id = organisation.organisation_id
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = organisation.organisation_id
       WHERE organisation.organisation_id = ?
         AND organisation.status = 'active'
         AND membership.user_id = ?
         AND membership.person_id = ?
         AND membership.status = 'active'
         AND membership.role = ?
         AND onboarding.lifecycle = 'active'
         AND onboarding.configuration_version = ?
         AND onboarding.configuration_version = (
           SELECT MAX(current_onboarding.configuration_version)
             FROM organisation_onboarding AS current_onboarding
            WHERE current_onboarding.organisation_id = organisation.organisation_id
         )
       LIMIT 1`,
    )
    .bind(
      authority.organisationId,
      authority.userId,
      authority.requesterPersonId,
      authority.role,
      authority.membershipRevision,
    )
    .first<{ readonly present: 1 }>();
  return row?.present === 1;
}

/**
 * A workflow authority names organisation-configured automation: a cue subscription
 * or, since plan 30, an enabled agent schedule binding. Either source proves
 * the workflow is still live at its pinned revision.
 */
async function liveWorkflowAuthorityIsActive(
  db: OrganisationDatabase,
  authority: Variant<RequestAuthority, "workflow">,
): Promise<boolean> {
  const reads = workflowSubjectReads.use();
  return (
    (await reads.cueSubscriptionAuthorityIsLive(db, authority)) ||
    reads.scheduleBindingAuthorityIsLive(db, authority)
  );
}

function parseScopedSlackAuthority(
  raw: unknown,
): Result<ParsedSlackAuthority, RequestAuthorityBoundaryError> {
  const record = readRecord(raw, "authority");

  if (!record.ok) {
    return record;
  }

  const input = record.value;
  const organisationId = readOrganisationId(
    input.organisationId,
    "organisationId",
  );
  const requester = readRecordField(input.requester, "requester");
  const connector = readRecordField(input.connector, "connector");
  const workspace = readRecordField(input.workspace, "workspace");
  const integrationAccount = readRecordField(
    input.integrationAccount,
    "integrationAccount",
  );
  const conversation = readRecordField(input.conversation, "conversation");
  const revision = readPositiveRevision(
    input.membershipRevision,
    "membershipRevision",
  );
  const role = readNonEmptyString(input.role, "role");

  if (!organisationId.ok) return organisationId;
  if (!requester.ok) return requester;
  if (!connector.ok) return connector;
  if (!workspace.ok) return workspace;
  if (!integrationAccount.ok) return integrationAccount;
  if (!conversation.ok) return conversation;
  if (!revision.ok) return revision;
  if (!role.ok) return role;

  const requesterOrganisation = readOrganisationId(
    requester.value.organisationId,
    "requester.organisationId",
  );
  const requesterPersonId = readPersonId(
    requester.value.personId,
    "requester.personId",
  );
  const connectorOrganisation = readOrganisationId(
    connector.value.organisationId,
    "connector.organisationId",
  );
  const connectorId = readConnectorId(connector.value.id, "connector.id");
  const workspaceOrganisation = readOrganisationId(
    workspace.value.organisationId,
    "workspace.organisationId",
  );
  const workspaceId = readWorkspaceId(workspace.value.id, "workspace.id");
  const accountOrganisation = readOrganisationId(
    integrationAccount.value.organisationId,
    "integrationAccount.organisationId",
  );
  const integrationAccountId = readIntegrationAccountId(
    integrationAccount.value.id,
    "integrationAccount.id",
  );
  const accountWorkspaceId = readWorkspaceId(
    integrationAccount.value.workspaceId,
    "integrationAccount.workspaceId",
  );
  const conversationOrganisation = readOrganisationId(
    conversation.value.organisationId,
    "conversation.organisationId",
  );
  const conversationId = readNonEmptyString(
    conversation.value.id,
    "conversation.id",
  );
  const conversationWorkspaceId = readWorkspaceId(
    conversation.value.workspaceId,
    "conversation.workspaceId",
  );
  const conversationKind = readSlackConversationKind(conversation.value.kind);

  if (!requesterOrganisation.ok) return requesterOrganisation;
  if (!requesterPersonId.ok) return requesterPersonId;
  if (!connectorOrganisation.ok) return connectorOrganisation;
  if (!connectorId.ok) return connectorId;
  if (!workspaceOrganisation.ok) return workspaceOrganisation;
  if (!workspaceId.ok) return workspaceId;
  if (!accountOrganisation.ok) return accountOrganisation;
  if (!integrationAccountId.ok) return integrationAccountId;
  if (!accountWorkspaceId.ok) return accountWorkspaceId;
  if (!conversationOrganisation.ok) return conversationOrganisation;
  if (!conversationId.ok) return conversationId;
  if (!conversationWorkspaceId.ok) return conversationWorkspaceId;
  if (!conversationKind.ok) return conversationKind;

  const organisationScope = requireSameOrganisation(
    [
      ["requester.organisationId", requesterOrganisation.value],
      ["connector.organisationId", connectorOrganisation.value],
      ["workspace.organisationId", workspaceOrganisation.value],
      ["integrationAccount.organisationId", accountOrganisation.value],
      ["conversation.organisationId", conversationOrganisation.value],
    ],
    organisationId.value,
  );

  if (!organisationScope.ok) return organisationScope;

  const workspaceScope = requireSameWorkspace(
    [
      ["integrationAccount.workspaceId", accountWorkspaceId.value],
      ["conversation.workspaceId", conversationWorkspaceId.value],
    ],
    workspaceId.value,
  );

  if (!workspaceScope.ok) return workspaceScope;

  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      requesterPersonId: requesterPersonId.value,
      membershipRevision: revision.value,
      role: role.value,
      connectorId: connectorId.value,
      integrationAccountId: integrationAccountId.value,
      conversationId: conversationId.value,
      conversationKind: conversationKind.value,
      workspaceId: workspaceId.value,
    },
  };
}

function parseWorkflowAuthority(
  raw: unknown,
): Result<WorkflowAuthorityInput, RequestAuthorityBoundaryError> {
  const record = readRecord(raw, "authority");

  if (!record.ok) return record;

  const organisationId = readOrganisationId(
    record.value.organisationId,
    "organisationId",
  );
  const workflow = readRecordField(record.value.workflow, "workflow");

  if (!organisationId.ok) return organisationId;
  if (!workflow.ok) return workflow;
  if (!hasExactKeys(workflow.value, ["organisationId", "id", "revision"])) {
    return { ok: false, error: { code: "invalid_field", field: "workflow" } };
  }

  const workflowOrganisation = readOrganisationId(
    workflow.value.organisationId,
    "workflow.organisationId",
  );
  const workflowId = readNonEmptyString(workflow.value.id, "workflow.id");
  const workflowRevision = readPositiveRevision(
    workflow.value.revision,
    "workflow.revision",
  );
  if (!workflowOrganisation.ok) return workflowOrganisation;
  if (!workflowId.ok) return workflowId;
  if (!workflowRevision.ok) return workflowRevision;

  if (workflowOrganisation.value !== organisationId.value) {
    return {
      ok: false,
      error: {
        code: "cross_organisation_scope",
        field: "workflow.organisationId",
      },
    };
  }

  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      workflowId: workflowId.value,
      workflowRevision: workflowRevision.value,
    },
  };
}

function parseRawControlAuthority(
  raw: unknown,
): Result<ControlAuthorityInput, RequestAuthorityBoundaryError> {
  const record = readRecord(raw, "authority");

  if (!record.ok) return record;

  const organisationId = readOrganisationId(
    record.value.organisationId,
    "organisationId",
  );
  const requester = readRecordField(record.value.requester, "requester");
  const user = readRecordField(record.value.user, "user");
  const membershipRevision = readPositiveRevision(
    record.value.membershipRevision,
    "membershipRevision",
  );
  const role = readNonEmptyString(record.value.role, "role");

  if (!organisationId.ok) return organisationId;
  if (!requester.ok) return requester;
  if (!user.ok) return user;
  if (!membershipRevision.ok) return membershipRevision;
  if (!role.ok) return role;

  const requesterOrganisation = readOrganisationId(
    requester.value.organisationId,
    "requester.organisationId",
  );
  const requesterPersonId = readPersonId(
    requester.value.personId,
    "requester.personId",
  );
  const controlOrganisation = readOrganisationId(
    user.value.organisationId,
    "user.organisationId",
  );
  const userId = readScopedIdentifier(user.value.id, "user.id");

  if (!requesterOrganisation.ok) return requesterOrganisation;
  if (!requesterPersonId.ok) return requesterPersonId;
  if (!controlOrganisation.ok) return controlOrganisation;
  if (!userId.ok) return userId;

  if (requesterOrganisation.value !== organisationId.value) {
    return {
      ok: false,
      error: {
        code: "cross_organisation_scope",
        field: "requester.organisationId",
      },
    };
  }
  if (controlOrganisation.value !== organisationId.value) {
    return {
      ok: false,
      error: { code: "cross_organisation_scope", field: "user.organisationId" },
    };
  }

  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      requesterPersonId: requesterPersonId.value,
      userId: userId.value,
      membershipRevision: membershipRevision.value,
      role: role.value,
    },
  };
}

function readRecord(
  raw: unknown,
  field: string,
): Result<RawRecord, RequestAuthorityBoundaryError> {
  if (!isRecord(raw)) {
    return { ok: false, error: { code: "invalid_input", field } };
  }

  return { ok: true, value: raw };
}

function readRecordField(
  raw: unknown,
  field: string,
): Result<RawRecord, RequestAuthorityBoundaryError> {
  if (raw === undefined) {
    return { ok: false, error: { code: "missing_field", field } };
  }

  return readRecord(raw, field);
}

function readNonEmptyString(
  raw: unknown,
  field: string,
): Result<string, RequestAuthorityBoundaryError> {
  if (raw === undefined) {
    return { ok: false, error: { code: "missing_field", field } };
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value: raw.trim() };
}

function readPositiveRevision(
  raw: unknown,
  field: string,
): Result<number, RequestAuthorityBoundaryError> {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value: raw };
}

function readOrganisationId(
  raw: unknown,
  field: string,
): Result<OrganisationId, RequestAuthorityBoundaryError> {
  const value = readNonEmptyString(raw, field);

  if (!value.ok) return value;

  const parsed = parseOrganisationId(value.value);
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field } };
}

function readPersonId(
  raw: unknown,
  field: string,
): Result<PersonId, RequestAuthorityBoundaryError> {
  const value = readNonEmptyString(raw, field);

  if (!value.ok) return value;

  const parsed = parsePersonId(value.value);
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field } };
}

function readConnectorId(
  raw: unknown,
  field: string,
): Result<LocalConnectorId, RequestAuthorityBoundaryError> {
  const value = readNonEmptyString(raw, field);

  if (!value.ok) return value;

  const parsed = parseConnectorId(value.value);
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field } };
}

function readWorkspaceId(
  raw: unknown,
  field: string,
): Result<WorkspaceId, RequestAuthorityBoundaryError> {
  const value = readNonEmptyString(raw, field);

  if (!value.ok) return value;

  const parsed = parseWorkspaceId(value.value);
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field } };
}

function readIntegrationAccountId(
  raw: unknown,
  field: string,
): Result<IntegrationAccountId, RequestAuthorityBoundaryError> {
  const value = readNonEmptyString(raw, field);

  if (!value.ok) return value;

  const parsed = parseIntegrationAccountId(value.value);
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field } };
}

function readScopedIdentifier(
  raw: unknown,
  field: string,
): Result<string, RequestAuthorityBoundaryError> {
  const value = readNonEmptyString(raw, field);

  if (!value.ok) return value;

  const parsed = parseUserId(value.value);
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field } };
}

function readSlackConversationKind(
  raw: unknown,
): Result<SlackConversationKind, RequestAuthorityBoundaryError> {
  const value = readNonEmptyString(raw, "conversation.kind");

  if (!value.ok) return value;

  if (value.value === "im" || isSharedSlackConversationKind(value.value)) {
    return { ok: true, value: value.value };
  }

  return {
    ok: false,
    error: {
      code: "unknown_slack_conversation_kind",
      value: value.value,
    },
  };
}

function isSharedSlackConversationKind(
  value: string,
): value is Exclude<SlackConversationKind, "im"> {
  for (const kind of SHARED_SLACK_CONVERSATION_KINDS) {
    if (kind === value) {
      return true;
    }
  }

  return false;
}

function requireSameOrganisation(
  values: readonly (readonly [string, OrganisationId])[],
  expected: OrganisationId,
): Result<true, RequestAuthorityBoundaryError> {
  for (const [field, value] of values) {
    if (value !== expected) {
      return { ok: false, error: { code: "cross_organisation_scope", field } };
    }
  }

  return { ok: true, value: true };
}

function requireSameWorkspace(
  values: readonly (readonly [string, WorkspaceId])[],
  expected: WorkspaceId,
): Result<true, RequestAuthorityBoundaryError> {
  for (const [field, value] of values) {
    if (value !== expected) {
      return { ok: false, error: { code: "cross_workspace_scope", field } };
    }
  }

  return { ok: true, value: true };
}
