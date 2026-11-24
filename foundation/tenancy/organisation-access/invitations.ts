import { encodeBase64Url, sha256Hex } from "@purin-labs/std";
import {
  parseAssignableControlRole,
  readActiveOrganisationMembership,
  readOrganisationMembershipMutationState,
  type ActiveOrganisationMembership,
  type User,
} from "../data/control-plane";
import {
  prepareControlMutationReceipt,
  prepareControlMutationReceiptAfterWrite,
  prepareOnboardingAuditEventAfterWrite,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "../data/control-mutation";
import type { OrganisationQuerySource } from "../data/query-source";
import type { UserId } from "@purin-labs/control-api/ids";
import { newPersonId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { organisationLifecycleParts } from "../data/organisation-lifecycle-port";
import type { Result } from "@purin-labs/kernel/result";

/**
 * Plan 95 step 2: Pantry keeps the invitations of an organisation. An admin
 * or the owner invites an email with a role. Pantry gives back a link with a
 * random token and keeps only the SHA-256 of the token. The person who
 * accepts signs in with a verified Google email equal to the invitation
 * email. Pantry sends no e-mail (decision 5).
 *
 * Each issue, revoke and accept writes its control mutation receipt and one
 * onboarding_audit_event row in the batch of its change. No receipt keeps a
 * token: a replay of an issue answers the invitation without its link.
 */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationRole = "admin" | "operator" | "viewer";

/** The pending invitation as the Portal shows it. */
export type PendingInvitation = Readonly<{
  organisationInvitationId: string;
  invitedEmail: string;
  role: InvitationRole;
  createdAt: number;
  expiresAt: number;
  kind: "pending";
}>;

/** An invitation that a person closed, and who closed it. */
export type RevokedInvitation = Omit<PendingInvitation, "kind"> &
  Readonly<{ kind: "revoked"; revokedAt: number; revokedByUserId: UserId }>;

/**
 * The answer of an issue: a new link one time, or the open invitation of the
 * email without its link. An open link stays until a person revokes it.
 */
export type IssuedInvitation =
  | Readonly<{ kind: "issued"; invitation: PendingInvitation; token: string }>
  | Readonly<{ kind: "open"; invitation: PendingInvitation }>;

/** The idempotency boundary, the replay scope and the audit identity of a change. */
export type InvitationMutation = Readonly<{
  boundary: ControlMutationBoundary;
  scope: ControlMutationReceiptScope;
  identity: ControlMutationIdentity;
}>;

export type InvitationError = Readonly<{
  code:
    | "organisation_invitation_not_found"
    | "organisation_invitation_closed"
    | "organisation_invitation_expired"
    | "organisation_invitation_email_mismatch"
    | "organisation_placement_conflict";
}>;

type InvitationRow = Readonly<{
  invitationId: string;
  email: string;
  role: unknown;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  state: string;
  acceptedUserId: string | null;
}>;

const INVITATION_COLUMNS = `invitation_id AS invitationId, email, role,
  token_hash AS tokenHash, created_at AS createdAt, expires_at AS expiresAt,
  state, accepted_user_id AS acceptedUserId`;

/** The open invitations of the organisation, newest first. */
export async function listPendingInvitations(
  scope: OrganisationExecutionScope,
  now: number,
): Promise<readonly PendingInvitation[]> {
  const rows = await scope.database
    .prepare(
      `SELECT ${INVITATION_COLUMNS} FROM organisation_invitation
       WHERE organisation_id = ? AND state = 'pending' AND expires_at > ?
       ORDER BY created_at DESC, invitation_id`,
    )
    .bind(scope.organisationId, now)
    .all<InvitationRow>();
  return rows.results.map(pendingInvitation);
}

/**
 * Issues an invitation and returns its token once. While the email has an
 * open invitation, a new issue answers that invitation without its link and
 * changes nothing: a person revokes it to make a new link. An expired open
 * invitation of the email closes with the issue.
 */
export async function issueInvitation(
  scope: OrganisationExecutionScope,
  input: Readonly<{
    email: string;
    role: InvitationRole;
    invitedBy: UserId;
    now: number;
    mutation: InvitationMutation;
  }>,
): Promise<Result<IssuedInvitation, InvitationError>> {
  const db = scope.database.withSession("first-primary");
  const open = await readOpenInvitation(db, scope, input.email);
  if (open !== null && open.expiresAt > input.now) {
    const invitation = pendingInvitation(open);
    await db.batch([
      scope.prepareMutationFence(),
      prepareControlMutationReceipt(db, {
        ...input.mutation,
        responseStatus: 200,
        responseBody: { ok: true, invitation },
      }),
    ]);
    if (!(await scope.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    return { ok: true, value: { kind: "open", invitation } };
  }
  const audit = await auditState(db, scope);
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const invitation: PendingInvitation = {
    organisationInvitationId: `invitation_${crypto.randomUUID()}`,
    invitedEmail: input.email,
    role: input.role,
    createdAt: input.now,
    expiresAt: input.now + INVITATION_TTL_MS,
    kind: "pending",
  };
  const [, , inserted] = await db.batch([
    scope.prepareMutationFence(),
    db
      .prepare(
        `UPDATE organisation_invitation
         SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?
         WHERE organisation_id = ? AND email = ? AND state = 'pending'
           AND expires_at <= ?`,
      )
      .bind(
        input.now,
        input.invitedBy,
        scope.organisationId,
        input.email,
        input.now,
      ),
    db
      .prepare(
        `INSERT INTO organisation_invitation (organisation_id, invitation_id, email,
           role, token_hash, invited_by_user_id, created_at, expires_at, state)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
         WHERE NOT EXISTS (SELECT 1 FROM organisation_invitation
           WHERE organisation_id = ? AND email = ? AND state = 'pending')`,
      )
      .bind(
        scope.organisationId,
        invitation.organisationInvitationId,
        input.email,
        input.role,
        await sha256Hex(token),
        input.invitedBy,
        input.now,
        invitation.expiresAt,
        scope.organisationId,
        input.email,
      ),
    prepareControlMutationReceiptAfterWrite(db, {
      ...input.mutation,
      responseStatus: 201,
      responseBody: { ok: true, invitation },
    }),
    prepareOnboardingAuditEventAfterWrite(db, input.mutation.identity, {
      ...audit,
      actorUserId: input.invitedBy,
      operation: "organisation.invitation.issue",
      targetKind: "invitation",
      targetId: invitation.organisationInvitationId,
      oldLifecycle: null,
      newLifecycle: "pending",
      reasonCode: "invitation_issued",
    }),
  ]);
  if (!(await scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  if (inserted?.meta.changes !== 1) {
    // Another issue opened a link for the email first.
    const raced = await readOpenInvitation(db, scope, input.email);
    return raced === null
      ? { ok: false, error: { code: "organisation_invitation_closed" } }
      : {
          ok: true,
          value: { kind: "open", invitation: pendingInvitation(raced) },
        };
  }
  return { ok: true, value: { kind: "issued", invitation, token } };
}

/** Closes an open invitation, so that its link no longer works. */
export async function revokeInvitation(
  scope: OrganisationExecutionScope,
  input: Readonly<{
    invitationId: string;
    revokedBy: UserId;
    now: number;
    mutation: InvitationMutation;
  }>,
): Promise<Result<RevokedInvitation, InvitationError>> {
  const db = scope.database.withSession("first-primary");
  const row = await readInvitation(db, scope, input.invitationId);
  if (row === null)
    return { ok: false, error: { code: "organisation_invitation_not_found" } };
  if (row.state !== "pending")
    return { ok: false, error: { code: "organisation_invitation_closed" } };
  const audit = await auditState(db, scope);
  const invitation: RevokedInvitation = {
    ...pendingInvitation(row),
    kind: "revoked",
    revokedAt: input.now,
    revokedByUserId: input.revokedBy,
  };
  const [, revoked] = await db.batch([
    scope.prepareMutationFence(),
    db
      .prepare(
        `UPDATE organisation_invitation
         SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?
         WHERE organisation_id = ? AND invitation_id = ? AND state = 'pending'`,
      )
      .bind(
        input.now,
        input.revokedBy,
        scope.organisationId,
        input.invitationId,
      ),
    prepareControlMutationReceiptAfterWrite(db, {
      ...input.mutation,
      responseStatus: 200,
      responseBody: { ok: true, invitation },
    }),
    prepareOnboardingAuditEventAfterWrite(db, input.mutation.identity, {
      ...audit,
      actorUserId: input.revokedBy,
      operation: "organisation.invitation.revoke",
      targetKind: "invitation",
      targetId: input.invitationId,
      oldLifecycle: "pending",
      newLifecycle: "revoked",
      reasonCode: "invitation_revoked",
    }),
  ]);
  if (revoked?.meta.changes !== 1)
    return { ok: false, error: { code: "organisation_invitation_closed" } };
  return { ok: true, value: invitation };
}

/**
 * Accepts an invitation for the signed-in person. One batch writes the
 * person, the role, the default project membership and the accepted state.
 * A second accept by the same person answers the same membership. A person
 * who is already a member keeps the role they have.
 */
export async function acceptInvitation(
  scope: OrganisationExecutionScope,
  input: Readonly<{
    invitationId: string;
    token: string;
    user: User;
    now: number;
    mutation: InvitationMutation;
  }>,
): Promise<Result<ActiveOrganisationMembership, InvitationError>> {
  const primary = scope.database.withSession("first-primary");
  const row = await readInvitation(primary, scope, input.invitationId);
  const tokenHash = await sha256Hex(input.token);
  // A wrong token answers as a missing invitation, so a link cannot be guessed.
  if (row === null || row.tokenHash !== tokenHash)
    return { ok: false, error: { code: "organisation_invitation_not_found" } };
  if (row.state === "accepted")
    return row.acceptedUserId === input.user.userId
      ? currentMembership(scope, input.user.userId)
      : { ok: false, error: { code: "organisation_invitation_closed" } };
  if (row.state !== "pending")
    return { ok: false, error: { code: "organisation_invitation_closed" } };
  if (input.now >= row.expiresAt)
    return { ok: false, error: { code: "organisation_invitation_expired" } };
  if (
    input.user.issuer !== "https://accounts.google.com" ||
    !input.user.emailVerified ||
    input.user.email.trim().toLowerCase() !== row.email
  )
    return {
      ok: false,
      error: { code: "organisation_invitation_email_mismatch" },
    };
  const role = parseAssignableControlRole(row.role);
  if (!role.ok) throw new Error("Invalid stored invitation role");
  const db = scope.database;
  // Each write holds only while the invitation is still open and the
  // organisation can take a member.
  const open = `EXISTS (SELECT 1 FROM organisation_invitation i
      JOIN organisation_onboarding o ON o.organisation_id = i.organisation_id
      WHERE i.organisation_id = ? AND i.invitation_id = ? AND i.state = 'pending'
        AND i.token_hash = ? AND i.expires_at > ?
        AND o.lifecycle NOT IN ('activating', 'archived'))`;
  const openBindings = [
    scope.organisationId,
    input.invitationId,
    tokenHash,
    input.now,
  ] as const;
  const close = db
    .prepare(
      `UPDATE organisation_invitation SET state = 'accepted',
         accepted_user_id = ?, accepted_at = ?
       WHERE organisation_id = ? AND invitation_id = ? AND state = 'pending'
         AND ${open}
         AND EXISTS (SELECT 1 FROM service_role_grant
           WHERE organisation_id = ? AND user_id = ? AND status = 'active')`,
    )
    .bind(
      input.user.userId,
      input.now,
      scope.organisationId,
      input.invitationId,
      ...openBindings,
      scope.organisationId,
      input.user.userId,
    );
  // The receipt and the audit row hold only when the close above applied.
  const audit = await auditState(primary, scope);
  const recorded = [
    prepareControlMutationReceiptAfterWrite(db, {
      ...input.mutation,
      responseStatus: 200,
      responseBody: {
        ok: true,
        invitation_id: input.invitationId,
        user_id: input.user.userId,
      },
    }),
    prepareOnboardingAuditEventAfterWrite(db, input.mutation.identity, {
      ...audit,
      actorUserId: input.user.userId,
      operation: "organisation.invitation.accept",
      targetKind: "invitation",
      targetId: input.invitationId,
      oldLifecycle: "pending",
      newLifecycle: "accepted",
      reasonCode: "invitation_accepted",
    }),
  ];
  const existing = await readActiveOrganisationMembership(
    db,
    scope.organisationId,
    input.user.userId,
  );
  if (existing !== null) {
    await db.batch([scope.prepareMutationFence(), close, ...recorded]);
  } else {
    // A removed member keeps their person; a new member gets one.
    const personId = newPersonId();
    await db.batch([
      scope.prepareMutationFence(),
      db
        .prepare(
          `INSERT INTO person (organisation_id, person_id, display_name)
           SELECT ?, ?, ? WHERE NOT EXISTS (
             SELECT 1 FROM service_role_grant WHERE organisation_id = ? AND user_id = ?)
           AND ${open}`,
        )
        .bind(
          scope.organisationId,
          personId,
          input.user.displayName,
          scope.organisationId,
          input.user.userId,
          ...openBindings,
        ),
      db
        .prepare(
          `INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
           SELECT ?, ?, ?, ?, 'active', ?, NULL WHERE ${open}
           ON CONFLICT (organisation_id, user_id) DO UPDATE SET
             role = excluded.role, status = 'active', revoked_at = NULL
           WHERE service_role_grant.status <> 'active'`,
        )
        .bind(
          scope.organisationId,
          input.user.userId,
          personId,
          role.value,
          input.now,
          ...openBindings,
        ),
      ...organisationLifecycleParts().membership.baseProjectMembership(db, {
        organisationId: scope.organisationId,
        userId: input.user.userId,
        role: role.value,
        now: input.now,
      }),
      close,
      ...recorded,
    ]);
  }
  const accepted = await readInvitation(primary, scope, input.invitationId);
  if (
    accepted?.state !== "accepted" ||
    accepted.acceptedUserId !== input.user.userId
  )
    return { ok: false, error: { code: "organisation_invitation_closed" } };
  return currentMembership(scope, input.user.userId);
}

async function currentMembership(
  scope: OrganisationExecutionScope,
  userId: UserId,
): Promise<Result<ActiveOrganisationMembership, InvitationError>> {
  const membership = await readActiveOrganisationMembership(
    scope.database,
    scope.organisationId,
    userId,
  );
  return membership === null
    ? { ok: false, error: { code: "organisation_invitation_closed" } }
    : { ok: true, value: membership };
}

async function readInvitation(
  db: OrganisationQuerySource,
  scope: OrganisationExecutionScope,
  invitationId: string,
): Promise<InvitationRow | null> {
  return db
    .prepare(
      `SELECT ${INVITATION_COLUMNS} FROM organisation_invitation
       WHERE organisation_id = ? AND invitation_id = ?`,
    )
    .bind(scope.organisationId, invitationId)
    .first<InvitationRow>();
}

/** The open invitation of an email, expired or not. */
async function readOpenInvitation(
  db: OrganisationQuerySource,
  scope: OrganisationExecutionScope,
  email: string,
): Promise<InvitationRow | null> {
  return db
    .prepare(
      `SELECT ${INVITATION_COLUMNS} FROM organisation_invitation
       WHERE organisation_id = ? AND email = ? AND state = 'pending'`,
    )
    .bind(scope.organisationId, email)
    .first<InvitationRow>();
}

/** The organisation, environment and versions that an audit row records. */
async function auditState(
  db: OrganisationQuerySource,
  scope: OrganisationExecutionScope,
): Promise<
  Readonly<{
    organisationId: OrganisationExecutionScope["organisationId"];
    environment: "development" | "production";
    configurationVersion: number;
    projectionRevision: number;
  }>
> {
  const state = await readOrganisationMembershipMutationState(
    db,
    scope.organisationId,
  );
  if (state === null)
    throw new Error("An organisation with invitations has no onboarding row");
  return {
    organisationId: scope.organisationId,
    environment: state.environment,
    configurationVersion: state.configurationVersion,
    projectionRevision: state.projectionRevision,
  };
}

function pendingInvitation(row: InvitationRow): PendingInvitation {
  const role = parseAssignableControlRole(row.role);
  if (!role.ok) throw new Error("Invalid stored invitation role");
  return {
    organisationInvitationId: row.invitationId,
    invitedEmail: row.email,
    role: role.value,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    kind: "pending",
  };
}
