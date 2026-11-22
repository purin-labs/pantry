import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  validStoredDisclosureState,
  verifyStoredDisclosureProof,
} from "../chat/disclosure-evidence";
import { isRecord, hasExactKeys } from "@purin-labs/std";
import { isProjectId, isUserId } from "@purin-labs/control-api";
import {
  DISCLOSURE_STATE_FENCE_SQL,
  disclosureStateFenceBindings,
  readDisclosureState,
  sameDisclosureState,
  type DisclosureProof,
  ProjectAudienceProposal,
} from "../chat/disclosure-evidence";
import type { ChatDisclosureFailure } from "@purin-labs/control-api";
import { checkProjectHistoryDisclosure } from "../chat/conversation-sharing";
import { listProjectMembers } from "./access";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type {
  ProjectAccessCommand,
  ProjectId,
  ProjectRole,
  UserId,
} from "@purin-labs/control-api";
import {
  assertNever,
  canonicalJson,
  isNonNegativeInteger,
  sha256Hex,
} from "@purin-labs/std";
import type { Env } from "@purin-labs/kernel/env";
import { authorizeProject, type ProjectAccessScope } from "./access";
import { prepareReturnPrivateChatsToDefault } from "./case-project";
import { readProject } from "./records";
import { observeProjectReference } from "./references";

type ProjectAccessResult =
  | ChatDisclosureFailure
  | Readonly<{ kind: "accepted"; accessRevision: number }>
  | Readonly<{
      kind: "rejected";
      code:
        | "project_unavailable"
        | "project_access_conflict"
        | "project_member_unavailable"
        | "project_last_owner"
        | "idempotency_key_conflict"
        | "chat_history_unavailable";
    }>;

type Member = Readonly<{ userId: UserId; role: ProjectRole }>;

const ACTIVE_PLACEMENT = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

const ACCESS_OPERATION_GUARD = `EXISTS (
  SELECT 1 FROM project_access_operation o
  JOIN project p ON p.organisation_id = o.organisation_id AND p.project_id = o.project_id
  WHERE o.organisation_id = ? AND o.actor_user_id = ? AND o.operation_id = ?
    AND p.access_revision + 1 = o.access_revision
) AND ${ACTIVE_PLACEMENT}`;

export async function mutateProjectAccess(
  env: Env,
  execution: OrganisationExecutionScope,
  userId: UserId,
  projectId: ProjectId,
  command: ProjectAccessCommand,
): Promise<ProjectAccessResult> {
  const db = execution.database;
  const scope: ProjectAccessScope = {
    organisationId: execution.organisationId,
    userId,
  };
  if (!(await execution.isActive()))
    return { kind: "rejected", code: "project_access_conflict" };
  const fence = [
    execution.organisationId,
    execution.placement.placementEpoch,
    execution.placement.placementCellId,
    execution.fenceToken,
  ];
  // Self-removal can revoke management permission after the operation is accepted.
  const digest = await sha256Hex(canonicalJson({ projectId, command }));
  const replay = await readAccessOperation(
    db,
    scope,
    command.operationId,
    digest,
  );
  if (replay !== null) return replay;
  const authorized = await authorizeProject(
    db,
    scope,
    projectId,
    "manage_members",
  );
  if (authorized === null)
    return { kind: "rejected", code: "project_unavailable" };
  if (authorized.access.accessRevision !== command.expectedAccessRevision) {
    return { kind: "rejected", code: "project_access_conflict" };
  }
  if (
    (command.kind === "share_project") !==
    (authorized.access.kind === "personal")
  ) {
    return { kind: "rejected", code: "project_access_conflict" };
  }
  const state = await readDisclosureState(db, scope);
  if (state === null)
    return {
      kind: "rejected",
      code: "chat_history_unavailable",
      reason: "evidence_unavailable",
    };
  const proofs: DisclosureProof[] = [];
  const proposal = await ProjectAudienceProposal.prepare(
    db,
    scope,
    projectId,
    command,
  );
  if (proposal === null)
    return { kind: "rejected", code: "project_access_conflict" };
  const members = accessCommandMembers(scope.userId, command);
  if (members === null) return { kind: "rejected", code: "project_last_owner" };
  const project = await readProject(db, scope, projectId);
  if (project === null)
    return { kind: "rejected", code: "project_unavailable" };
  for (const member of members) {
    for (const reference of project.references) {
      const observation = await observeProjectReference(
        env,
        execution,
        { organisationId: scope.organisationId, userId: member.userId },
        reference,
        Date.now(),
        { kind: "project_admission", proposal },
      );
      if (observation.kind === "unavailable") {
        return {
          kind: "rejected",
          code: "project_reference_unavailable",
          reason: "source_policy_denied",
        };
      }
    }
  }
  let disclosedRevisions: string | null = null;
  if (authorized.access.kind === "shared") {
    const currentMembers = await listProjectMembers(db, scope, projectId);
    if (currentMembers === null)
      return { kind: "rejected", code: "project_unavailable" };
    const currentUsers = new Set(currentMembers.map(projectMemberUserId));
    const addedUsers = members
      .map(projectMemberUserId)
      .filter(isAddedProjectUser.bind(null, currentUsers));
    if (addedUsers.length > 0) {
      const disclosure = await checkProjectHistoryDisclosure(
        env,
        execution,
        scope,
        projectId,
        addedUsers,
        { kind: "project_admission", proposal },
      );
      if (disclosure.kind === "rejected") return disclosure;
      disclosedRevisions = JSON.stringify(disclosure.revisions);
      proofs.push(...disclosure.proofs);
    }
  }
  if (!sameDisclosureState(state, await readDisclosureState(db, scope)))
    return {
      kind: "rejected",
      code: "chat_history_forbidden",
      reason: "access_changed",
    };
  const proofJson = canonicalJson({
    state,
    projectId,
    commandDigest: digest,
    audience: proposal.recipients,
    histories: proofs,
  });
  const parameters = [
    scope.organisationId,
    scope.userId,
    command.operationId,
    ...fence,
  ];
  const membersJson = JSON.stringify(members);
  const removeUser =
    command.kind === "remove_project_member" ? command.userId : null;
  const demoteUser =
    command.kind === "set_project_member" && command.role !== "owner"
      ? command.userId
      : removeUser;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `
    INSERT OR IGNORE INTO project_access_operation
      (organisation_id, project_id, actor_user_id, operation_id, command_digest, access_revision, accepted_at, disclosure_proof_json)
    SELECT p.organisation_id, p.project_id, ?, ?, ?, p.access_revision + 1, ?, ?
    FROM project p
    JOIN organisation t ON t.organisation_id = p.organisation_id AND t.status = 'active'
    JOIN service_role_grant actor ON actor.organisation_id = p.organisation_id
      AND actor.user_id = ? AND actor.status = 'active'
    WHERE p.organisation_id = ? AND p.project_id = ? AND p.access_revision = ? AND p.content_revision = ?
      AND ((p.access_kind = 'personal' AND p.user_id = actor.user_id)
        OR (p.access_kind = 'shared' AND EXISTS (
          SELECT 1 FROM project_member owner WHERE owner.organisation_id = p.organisation_id
            AND owner.project_id = p.project_id AND owner.user_id = actor.user_id AND owner.role = 'owner')))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) candidate WHERE NOT EXISTS (
        SELECT 1 FROM service_role_grant tm WHERE tm.organisation_id = p.organisation_id
          AND tm.user_id = json_extract(candidate.value, '$.userId') AND tm.status = 'active'))
      AND (? IS NULL OR (
        (SELECT COUNT(*) FROM portal_conversation c JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id
          WHERE c.organisation_id = p.organisation_id AND cp.project_id = p.project_id AND c.access_kind = 'shared') = json_array_length(?)
        AND NOT EXISTS (SELECT 1 FROM json_each(?) disclosed WHERE NOT EXISTS (
          SELECT 1 FROM portal_conversation c JOIN case_project cp ON cp.organisation_id = c.organisation_id AND cp.case_id = c.case_id
          WHERE c.organisation_id = p.organisation_id AND cp.project_id = p.project_id
            AND c.conversation_id = json_extract(disclosed.value, '$.id') AND c.revision = json_extract(disclosed.value, '$.revision') AND c.active_user_id IS NULL))))
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM project_member affected
        WHERE affected.organisation_id = p.organisation_id AND affected.project_id = p.project_id
          AND affected.user_id = ? AND affected.role = 'owner') OR EXISTS (
        SELECT 1 FROM project_member other
        JOIN service_role_grant tm ON tm.organisation_id = other.organisation_id AND tm.user_id = other.user_id AND tm.status = 'active'
        WHERE other.organisation_id = p.organisation_id AND other.project_id = p.project_id
          AND other.role = 'owner' AND other.user_id <> ?))
      AND ${DISCLOSURE_STATE_FENCE_SQL} AND ${ACTIVE_PLACEMENT}
  `,
      )
      .bind(
        scope.userId,
        command.operationId,
        digest,
        Date.now(),
        proofJson,
        scope.userId,
        scope.organisationId,
        projectId,
        command.expectedAccessRevision,
        project.contentRevision,
        membersJson,
        disclosedRevisions,
        disclosedRevisions,
        disclosedRevisions,
        demoteUser,
        demoteUser,
        demoteUser,
        ...disclosureStateFenceBindings(state, scope),
        ...fence,
      ),
  ];
  if (removeUser !== null) {
    statements.push(
      db
        .prepare(
          `DELETE FROM project_member
      WHERE organisation_id = ? AND project_id = ? AND user_id = ? AND ${ACCESS_OPERATION_GUARD}`,
        )
        .bind(scope.organisationId, projectId, removeUser, ...parameters),
    );
    statements.push(
      ...prepareReturnPrivateChatsToDefault(db, {
        organisationId: scope.organisationId,
        sourceProjectId: projectId,
        ownerUserId: removeUser,
        now: Date.now(),
        guard: { sql: ACCESS_OPERATION_GUARD, bindings: parameters },
      }),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO project_member (organisation_id, project_id, user_id, role)
    SELECT ?, ?, json_extract(value, '$.userId'), json_extract(value, '$.role') FROM json_each(?)
    WHERE ${ACCESS_OPERATION_GUARD}
    ON CONFLICT (organisation_id, project_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(scope.organisationId, projectId, membersJson, ...parameters),
  );
  statements.push(
    db
      .prepare(
        `UPDATE project SET access_kind = 'shared', user_id = NULL,
    access_revision = access_revision + 1, updated_at = ?
    WHERE organisation_id = ? AND project_id = ? AND ${ACCESS_OPERATION_GUARD}`,
      )
      .bind(Date.now(), scope.organisationId, projectId, ...parameters),
  );
  statements.push(
    db
      .prepare(
        "UPDATE portal_chat_directory SET revision = revision + 1 WHERE organisation_id = ? AND changes() = 1",
      )
      .bind(scope.organisationId),
  );
  await db.batch(statements);
  const accepted = await readAccessOperation(
    db,
    scope,
    command.operationId,
    digest,
  );
  if (accepted !== null) return accepted;
  if (demoteUser !== null) {
    const otherOwner = await db
      .prepare(
        `SELECT 1 FROM project_member pm
      JOIN service_role_grant tm ON tm.organisation_id = pm.organisation_id AND tm.user_id = pm.user_id AND tm.status = 'active'
      WHERE pm.organisation_id = ? AND pm.project_id = ? AND pm.role = 'owner' AND pm.user_id <> ? LIMIT 1`,
      )
      .bind(scope.organisationId, projectId, demoteUser)
      .first();
    if (otherOwner === null)
      return { kind: "rejected", code: "project_last_owner" };
  }
  return { kind: "rejected", code: "project_access_conflict" };
}

function accessCommandMembers(
  actor: UserId,
  command: ProjectAccessCommand,
): readonly Member[] | null {
  switch (command.kind) {
    case "share_project": {
      const members: Member[] = [{ userId: actor, role: "owner" }];
      for (const member of command.members) {
        if (member.userId === actor) {
          if (member.role !== "owner") return null;
        } else {
          members.push(member);
        }
      }
      return members;
    }
    case "set_project_member":
      return [{ userId: command.userId, role: command.role }];
    case "remove_project_member":
      return [];
    default:
      return assertNever(command);
  }
}

async function readAccessOperation(
  db: OrganisationDatabase,
  scope: ProjectAccessScope,
  operationId: string,
  digest: string,
): Promise<ProjectAccessResult | null> {
  const row = await db
    .prepare(
      `SELECT command_digest, access_revision, disclosure_proof_json
    FROM project_access_operation WHERE organisation_id = ? AND actor_user_id = ? AND operation_id = ?`,
    )
    .bind(scope.organisationId, scope.userId, operationId)
    .first<{
      command_digest: unknown;
      access_revision: unknown;
      disclosure_proof_json: unknown;
    }>();
  if (row === null) return null;
  if (
    typeof row.command_digest !== "string" ||
    !isNonNegativeInteger(row.access_revision) ||
    row.access_revision === 0
  ) {
    throw new Error("project_operation_storage_invalid");
  }
  if (row.command_digest === digest) {
    if (typeof row.disclosure_proof_json !== "string")
      return {
        kind: "rejected",
        code: "chat_history_unavailable",
        reason: "evidence_unavailable",
      };
    const proof: unknown = JSON.parse(row.disclosure_proof_json);
    if (
      !isRecord(proof) ||
      !hasExactKeys(proof, [
        "state",
        "projectId",
        "commandDigest",
        "audience",
        "histories",
      ]) ||
      !validStoredDisclosureState(proof.state) ||
      !isProjectId(proof.projectId) ||
      proof.commandDigest !== digest ||
      !Array.isArray(proof.audience) ||
      !proof.audience.every(isUserId) ||
      !Array.isArray(proof.histories)
    ) {
      return {
        kind: "rejected",
        code: "chat_history_unavailable",
        reason: "evidence_unavailable",
      };
    }
    for (const history of proof.histories) {
      if (!(await verifyStoredDisclosureProof(history)))
        return {
          kind: "rejected",
          code: "chat_history_unavailable",
          reason: "evidence_unavailable",
        };
    }
  }
  return row.command_digest === digest
    ? { kind: "accepted", accessRevision: row.access_revision }
    : { kind: "rejected", code: "idempotency_key_conflict" };
}

function projectMemberUserId(member: { userId: UserId }): UserId {
  return member.userId;
}
function isAddedProjectUser(
  current: ReadonlySet<UserId>,
  userId: UserId,
): boolean {
  return !current.has(userId);
}
