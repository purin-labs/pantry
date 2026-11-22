import type { GlobalDatabase, OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  acceptedExecutionAuthority,
  type OrganisationAccess,
} from "@purin-labs/tenancy/organisation-access/access";
import type { HarnessTurnLease, RequestAuthority } from "@purin-labs/contracts";
import {
  isProjectId,
  isConversationId,
  isUserId,
  type ConversationId,
  type ProjectId,
  type UserId,
} from "@purin-labs/control-api";
import {
  assertNever,
  hasExactKeys,
  isRecord,
  isNonBlankString,
  isNonNegativeInteger,
} from "@purin-labs/std";
import type { ControlSessionId, SessionId, OrganisationId } from "@purin-labs/kernel/ids";
import { resolveControlSessionById } from "@purin-labs/tenancy/data/control-plane";
import type { ConversationScope } from "./store";
import {
  authorizeConversation,
  NATIVE_CHAT_SOURCE_ACCESS,
  VISIBLE_CONVERSATIONS_SQL,
} from "./conversation-access";
import { authorizeProject } from "../projects/access";
import { createCurrentSourceFlowLabel } from "../policy/information-flow";
import {
  parseControlSessionId,
  parseSessionId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  parseStoredRequestAuthority,
  validateLiveRequestAuthority,
} from "../request-authority";

export type SessionTurnExecution = Readonly<{
  sessionId: SessionId;
  turnId: string;
  requestAuthority: RequestAuthority;
}>;

export function sessionTurnExecution(
  lease: HarnessTurnLease,
): SessionTurnExecution {
  return {
    sessionId: requireSessionId(lease.session.sessionId),
    turnId: lease.turn.turnId,
    requestAuthority: lease.requestAuthority,
  };
}

function requireSessionId(raw: string): SessionId {
  const parsed = parseSessionId(raw);
  if (!parsed.ok) throw new Error("session_turn_execution_identity_invalid");
  return parsed.value;
}

export function parseSessionTurnExecution(
  raw: unknown,
): SessionTurnExecution | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["sessionId", "turnId", "requestAuthority"]) ||
    typeof raw.sessionId !== "string" ||
    !isNonBlankString(raw.turnId)
  )
    return null;
  const sessionId = parseSessionId(raw.sessionId);
  const authority = parseStoredRequestAuthority(raw.requestAuthority);
  if (!sessionId.ok || !authority.ok) return null;
  return {
    sessionId: sessionId.value,
    turnId: raw.turnId,
    requestAuthority: authority.value.requestAuthority,
  };
}

export type OperatorExecutionOrigin =
  | Readonly<{ kind: "control_session"; controlSessionId: ControlSessionId }>
  | Readonly<{ kind: "slack"; controlSessionId?: never }>;

type SessionTurnOrigin =
  | Readonly<{
      kind: "conversation_session";
      userId: UserId;
      controlSessionId: ControlSessionId;
      conversationId: ConversationId;
      // The Project this turn reads from; null when it reads from none.
      projectId: ProjectId | null;
      audience: AdmittedChatAudience;
    }>
  | Readonly<{
      kind: "operator_session";
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>
  | Readonly<{
      kind: "slack_operator";
      userId: UserId;
      controlSessionId?: never;
    }>;

export async function bindOperatorTurnAccess(
  scope: OrganisationExecutionScope,
  sessionId: SessionId,
  turnId: string,
  authority: Variant<RequestAuthority, "control">,
  origin: OperatorExecutionOrigin,
): Promise<boolean> {
  if (
    authority.organisationId !== scope.organisationId ||
    !isUserId(authority.userId)
  )
    return false;
  const originKind =
    origin.kind === "slack" ? "slack_operator" : "operator_session";
  const controlSessionId =
    origin.kind === "control_session" ? origin.controlSessionId : null;
  await scope.database
    .prepare(
      `INSERT OR IGNORE INTO session_turn_access
      (organisation_id, session_id, turn_id, origin_kind, actor_user_id, control_session_id)
    SELECT ?, ?, ?, ?, ?, ? FROM organisation_placement
    WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
      AND fence_token = ? AND status = 'active'`,
    )
    .bind(
      scope.organisationId,
      sessionId,
      turnId,
      originKind,
      authority.userId,
      controlSessionId,
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    )
    .run();
  const bound = await readSessionTurnOrigin(
    scope.database,
    scope.organisationId,
    sessionId,
    turnId,
  );
  if (
    bound === null ||
    bound.userId !== authority.userId ||
    bound.kind !== originKind
  )
    return false;
  if (
    origin.kind === "control_session" &&
    (bound.kind !== "operator_session" ||
      bound.controlSessionId !== origin.controlSessionId)
  )
    return false;
  return scope.isActive();
}

/**
 * Whether a Session runs the steps of a Portal chat. The chat binds each step
 * before its turn starts, and the binding is never removed.
 */
export async function isConversationSession(
  db: OrganisationDatabase,
  organisationId: string,
  sessionId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS bound FROM session_turn_access WHERE organisation_id = ? AND session_id = ? AND origin_kind = 'conversation_session' LIMIT 1",
    )
    .bind(organisationId, sessionId)
    .first();
  return row !== null;
}

export async function bindConversationTurnAccess(
  db: OrganisationDatabase,
  scope: ConversationScope,
  conversationId: ConversationId,
  sessionId: SessionId,
  turnId: string,
  controlSessionId: ControlSessionId,
): Promise<boolean> {
  const result = await db
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    INSERT OR IGNORE INTO session_turn_access (organisation_id, session_id, turn_id, origin_kind, conversation_id, actor_user_id, control_session_id, project_id, access_revision, audience_json)
    SELECT organisation_id, ?, ?, 'conversation_session', conversation_id, ?, ?,
      CASE WHEN project_readable THEN project_id END, access_revision,
      json_object('conversationRevision', revision, 'accessRevision', access_revision,
        'surface', access_kind,
        'organisationMembershipRevision', (SELECT configuration_version FROM organisation_onboarding o WHERE o.organisation_id = visible_conversation.organisation_id),
        'membershipRevision', membership_revision, 'projectId', project_id,
        'projectAccessRevision', CASE WHEN project_readable THEN (SELECT access_revision FROM project p WHERE p.organisation_id = visible_conversation.organisation_id AND p.project_id = visible_conversation.project_id) END,
        'projectContentRevision', CASE WHEN project_readable THEN (SELECT content_revision FROM project p WHERE p.organisation_id = visible_conversation.organisation_id AND p.project_id = visible_conversation.project_id) END,
        'recipients', CASE WHEN access_kind = 'private' THEN json_array(user_id) WHEN access_kind = 'workspace_canvas' THEN (SELECT json_group_array(tm.user_id) FROM service_role_grant tm WHERE tm.organisation_id = visible_conversation.organisation_id AND tm.status = 'active') ELSE
          (SELECT json_group_array(pm.user_id) FROM project_member pm JOIN service_role_grant tm ON tm.organisation_id = pm.organisation_id AND tm.user_id = pm.user_id AND tm.status = 'active'
           WHERE pm.organisation_id = visible_conversation.organisation_id AND pm.project_id = visible_conversation.project_id) END)
    FROM visible_conversation
    WHERE conversation_id = ? AND active_user_id = ? AND (access_kind = 'private' OR member_role IN ('owner', 'editor'))`,
    )
    .bind(
      scope.organisationId,
      scope.userId,
      sessionId,
      turnId,
      scope.userId,
      controlSessionId,
      conversationId,
      scope.userId,
    )
    .run();
  if (result.meta.changes === 0) {
    const bound = await db
      .prepare(
        "SELECT origin_kind, conversation_id, actor_user_id, control_session_id FROM session_turn_access WHERE organisation_id = ? AND session_id = ? AND turn_id = ?",
      )
      .bind(scope.organisationId, sessionId, turnId)
      .first<{
        origin_kind: unknown;
        conversation_id: unknown;
        actor_user_id: unknown;
        control_session_id: unknown;
      }>();
    if (
      bound?.origin_kind !== "conversation_session" ||
      bound.conversation_id !== conversationId ||
      bound.actor_user_id !== scope.userId ||
      bound.control_session_id !== controlSessionId ||
      !(await authorizeChatTurnAccess(
        db,
        scope.organisationId,
        sessionId,
        turnId,
        scope.userId,
      ))
    )
      return false;
  }
  return true;
}

export async function authorizeChatTurnAccess(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  sessionId: string,
  turnId: string,
  userId: string,
): Promise<boolean> {
  const origin = await readSessionTurnOrigin(
    db,
    organisationId,
    sessionId,
    turnId,
  );
  return origin !== null && origin.userId === userId
    ? authorizeOriginConversationAccess(db, organisationId, origin)
    : false;
}

/** Canvas conversations retain their document scope across every tool call. */
export async function authorizeCanvasTurnDocument(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  execution: SessionTurnExecution,
  documentId: string,
): Promise<boolean> {
  if (controlAuthorityUserId(execution.requestAuthority) === null) return true;
  const origin = await readSessionTurnOrigin(
    db,
    organisationId,
    execution.sessionId,
    execution.turnId,
  );
  if (origin === null) return false;
  if (origin.kind !== "conversation_session") return true;
  const access = await authorizeConversation(
    db,
    { organisationId, userId: origin.userId },
    origin.conversationId,
  );
  if (access === null) return false;
  return (
    access.access.kind !== "workspace_canvas" ||
    access.access.documentId === documentId
  );
}

async function authorizeOriginConversationAccess(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  origin: SessionTurnOrigin,
): Promise<boolean> {
  if (origin.kind !== "conversation_session") return true;
  if (!origin.audience.recipients.includes(origin.userId)) return false;
  const scope = { organisationId, userId: origin.userId };
  const access = await authorizeConversation(db, scope, origin.conversationId);
  if (
    access === null ||
    (access.access.kind !== "private" && access.role === "viewer")
  )
    return false;
  if (
    origin.projectId !== null &&
    (await authorizeProject(db, scope, origin.projectId, "read")) === null
  )
    return false;
  return true;
}

export async function authorizeChatHarnessLease(
  globalDatabase: GlobalDatabase,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
  accountAccess: OrganisationAccess,
): Promise<boolean> {
  return authorizeSessionTurnExecution(
    globalDatabase,
    db,
    organisationId,
    sessionTurnExecution(lease),
    accountAccess,
  );
}

export async function authorizeSessionTurnExecution(
  globalDatabase: GlobalDatabase,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  execution: SessionTurnExecution,
  accountAccess: OrganisationAccess,
): Promise<boolean> {
  if (execution.requestAuthority.organisationId !== organisationId)
    return false;
  const userId = controlAuthorityUserId(execution.requestAuthority);
  const origin =
    userId === null
      ? null
      : await readSessionTurnOrigin(
          db,
          organisationId,
          execution.sessionId,
          execution.turnId,
        );
  if (userId !== null && (origin === null || origin.userId !== userId))
    return false;
  // The origin's reads run beside the live authority check. They count only
  // after that check passed.
  const originChecks = Promise.all([
    origin === null
      ? Promise.resolve(true)
      : authorizeRecordedSessionOrigin(globalDatabase, origin),
    origin === null
      ? Promise.resolve(true)
      : authorizeOriginConversationAccess(db, organisationId, origin),
  ]);
  void originChecks.catch(ignoreUnusedOriginChecks);
  const live = await validateLiveRequestAuthority({
    db,
    accountAccess,
    action: "execute",
    userAuthority:
      origin !== null && origin.kind !== "slack_operator"
        ? {
            kind: "authenticated_session",
            nativeSessionId: origin.controlSessionId,
          }
        : acceptedExecutionAuthority(
            execution.sessionId,
            execution.turnId,
          ),
    authority: execution.requestAuthority,
  });
  if (!live.ok) return false;
  const [originAuthorized, accessible] = await originChecks;
  return originAuthorized && accessible;
}

/** A refused live authority never consults the origin's reads. */
function ignoreUnusedOriginChecks(): void {}

export async function authorizeSessionTurnOrigin(
  globalDatabase: GlobalDatabase,
  database: OrganisationDatabase,
  organisationId: OrganisationId,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  const origin = await readSessionTurnOrigin(
    database,
    organisationId,
    sessionId,
    turnId,
  );
  if (origin === null) return false;
  return authorizeRecordedSessionOrigin(globalDatabase, origin);
}

async function authorizeRecordedSessionOrigin(
  globalDatabase: GlobalDatabase,
  origin: SessionTurnOrigin,
): Promise<boolean> {
  switch (origin.kind) {
    case "slack_operator":
      return true;
    case "conversation_session":
    case "operator_session": {
      const session = await resolveControlSessionById({
        db: globalDatabase,
        controlSessionId: origin.controlSessionId,
        now: Date.now(),
      });
      return session.ok && session.value.userId === origin.userId;
    }
    default:
      return assertNever(origin);
  }
}

async function readSessionTurnOrigin(
  database: OrganisationDatabase,
  organisationId: OrganisationId,
  sessionId: string,
  turnId: string,
): Promise<SessionTurnOrigin | null> {
  const row = await database
    .prepare(
      `SELECT origin_kind, actor_user_id, control_session_id,
              conversation_id, project_id, audience_json FROM session_turn_access
     WHERE organisation_id = ? AND session_id = ? AND turn_id = ?`,
    )
    .bind(organisationId, sessionId, turnId)
    .first<SessionTurnOriginRow>();
  return row === null ? null : parseSessionTurnOrigin(row);
}

type SessionTurnOriginRow = {
  readonly origin_kind: unknown;
  readonly actor_user_id: unknown;
  readonly control_session_id: unknown;
  readonly conversation_id: unknown;
  readonly project_id: unknown;
  readonly audience_json: unknown;
};

function parseSessionTurnOrigin(
  row: SessionTurnOriginRow,
): SessionTurnOrigin | null {
  if (!isUserId(row.actor_user_id)) return null;
  if (row.origin_kind === "slack_operator" && row.control_session_id === null)
    return { kind: "slack_operator", userId: row.actor_user_id };
  if (
    (row.origin_kind !== "conversation_session" &&
      row.origin_kind !== "operator_session") ||
    typeof row.control_session_id !== "string"
  )
    return null;
  const origin = parseControlSessionId(row.control_session_id);
  if (!origin.ok) return null;
  if (row.origin_kind === "operator_session") {
    return {
      kind: "operator_session",
      userId: row.actor_user_id,
      controlSessionId: origin.value,
    };
  }
  if (
    !isConversationId(row.conversation_id) ||
    (row.project_id !== null && !isProjectId(row.project_id))
  )
    return null;
  const audience = parseAdmittedChatAudience(row.audience_json);
  if (audience === null) return null;
  return {
    kind: "conversation_session",
    userId: row.actor_user_id,
    controlSessionId: origin.value,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    audience,
  };
}

function controlAuthorityUserId(authority: RequestAuthority): string | null {
  return authority.kind === "control" ? authority.userId : null;
}

type AdmittedChatAudience = Readonly<{
  surface: "private" | "shared" | "workspace_canvas";
  conversationRevision: number;
  accessRevision: number;
  organisationMembership:
    | Readonly<{ kind: "unconfigured" }>
    | Readonly<{ kind: "configured"; revision: number }>;
  membershipRevision: number;
  recipients: readonly UserId[];
  // The Project the chat sat in when the turn was admitted. Withheld means the
  // turn read nothing from it and does not depend on its access.
  association:
    | Readonly<{
        kind: "withheld";
        projectId: ProjectId;
        accessRevision?: never;
        contentRevision?: never;
      }>
    | Readonly<{
        kind: "project";
        projectId: ProjectId;
        accessRevision: number;
        contentRevision: number;
      }>;
}>;

function parseAdmittedChatAudience(
  serialized: unknown,
): AdmittedChatAudience | null {
  if (typeof serialized !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "surface",
      "conversationRevision",
      "accessRevision",
      "organisationMembershipRevision",
      "membershipRevision",
      "projectId",
      "projectAccessRevision",
      "projectContentRevision",
      "recipients",
    ]) ||
    (raw.surface !== "private" &&
      raw.surface !== "shared" &&
      raw.surface !== "workspace_canvas") ||
    !isNonNegativeInteger(raw.conversationRevision) ||
    !isNonNegativeInteger(raw.accessRevision) ||
    (raw.organisationMembershipRevision !== null &&
      (!isNonNegativeInteger(raw.organisationMembershipRevision) ||
        raw.organisationMembershipRevision < 1)) ||
    !isNonNegativeInteger(raw.membershipRevision) ||
    !Array.isArray(raw.recipients) ||
    raw.recipients.length === 0
  )
    return null;
  const recipients: UserId[] = [];
  for (const userId of raw.recipients) {
    if (!isUserId(userId) || recipients.includes(userId)) return null;
    recipients.push(userId);
  }
  if (!isProjectId(raw.projectId)) return null;
  let association: AdmittedChatAudience["association"];
  if (
    raw.projectAccessRevision === null &&
    raw.projectContentRevision === null &&
    (raw.surface === "private" || raw.surface === "workspace_canvas")
  ) {
    association = { kind: "withheld", projectId: raw.projectId };
  } else if (
    isNonNegativeInteger(raw.projectAccessRevision) &&
    isNonNegativeInteger(raw.projectContentRevision) &&
    raw.projectContentRevision >= 1
  ) {
    association = {
      kind: "project",
      projectId: raw.projectId,
      accessRevision: raw.projectAccessRevision,
      contentRevision: raw.projectContentRevision,
    };
  } else return null;
  if (raw.surface === "private" && recipients.length !== 1) return null;
  if (raw.surface === "workspace_canvas" && association.kind !== "withheld")
    return null;
  return {
    surface: raw.surface,
    conversationRevision: raw.conversationRevision,
    accessRevision: raw.accessRevision,
    organisationMembership:
      raw.organisationMembershipRevision === null
        ? { kind: "unconfigured" }
        : { kind: "configured", revision: raw.organisationMembershipRevision },
    membershipRevision: raw.membershipRevision,
    recipients: Object.freeze(recipients.sort()),
    association,
  };
}

export async function readAdmittedChatInput(
  db: OrganisationDatabase,
  authority: Variant<RequestAuthority, "control">,
  turnId: string,
) {
  const rows = await db
    .prepare(
      `SELECT session_id, origin_kind, conversation_id, actor_user_id,
           control_session_id, project_id, audience_json
    FROM session_turn_access WHERE organisation_id = ? AND turn_id = ? AND origin_kind = 'conversation_session'`,
    )
    .bind(authority.organisationId, turnId)
    .all<SessionTurnOriginRow & { readonly session_id: unknown }>();
  if (rows.results.length === 0) return null;
  const row = rows.results[0];
  if (
    rows.results.length !== 1 ||
    row === undefined ||
    !isConversationId(row.conversation_id) ||
    row.actor_user_id !== authority.userId ||
    typeof row.session_id !== "string"
  )
    throw new Error("chat_input_evidence_unavailable");
  const organisation = parseOrganisationId(authority.organisationId);
  const session = parseSessionId(row.session_id);
  const origin = parseSessionTurnOrigin(row);
  if (
    !organisation.ok ||
    !session.ok ||
    origin === null ||
    origin.kind !== "conversation_session"
  ) {
    throw new Error("chat_input_access_changed");
  }
  const source = {
    kind: "chat_conversation" as const,
    organisationId: organisation.value,
    conversationId: origin.conversationId,
  };
  const [authorized, label] = await Promise.all([
    authorizeOriginConversationAccess(db, organisation.value, origin),
    origin.audience.surface !== "private"
      ? createCurrentSourceFlowLabel({
          kind: "native_chat",
          db,
          authority,
          source,
          access: NATIVE_CHAT_SOURCE_ACCESS,
        })
      : createCurrentSourceFlowLabel({ kind: "ingress", db, authority }),
  ]);
  if (!authorized) throw new Error("chat_input_access_changed");
  if (!label.ok) throw new Error("chat_input_evidence_unavailable");
  return {
    sessionId: session.value,
    source,
    audience: origin.audience,
    inputLabel: label.value,
  };
}
