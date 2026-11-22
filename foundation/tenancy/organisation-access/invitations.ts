import { encodeBase64Url, sha256Hex } from "@purin-labs/std";
import {
  parseAssignableControlRole,
  readActiveOrganisationMembership,
  type ActiveOrganisationMembership,
  type User,
} from "../data/control-plane";
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
 * Issues an invitation and returns its token once. A second invitation for
 * the same email replaces the open one, so that only the newest link works.
 */
export async function issueInvitation(
  scope: OrganisationExecutionScope,
  input: Readonly<{
    email: string;
    role: InvitationRole;
    invitedBy: UserId;
    now: number;
  }>,
): Promise<
  Result<
    Readonly<{ invitation: PendingInvitation; token: string }>,
    InvitationError
  >
> {
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const invitationId = `invitation_${crypto.randomUUID()}`;
  const expiresAt = input.now + INVITATION_TTL_MS;
  const db = scope.database;
  await db.batch([
    scope.prepareMutationFence(),
    db
      .prepare(
        `UPDATE organisation_invitation SET state = 'revoked', revoked_at = ?
         WHERE organisation_id = ? AND email = ? AND state = 'pending'`,
      )
      .bind(input.now, scope.organisationId, input.email),
    db
      .prepare(
        `INSERT INTO organisation_invitation (organisation_id, invitation_id, email,
           role, token_hash, invited_by_user_id, created_at, expires_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .bind(
        scope.organisationId,
        invitationId,
        input.email,
        input.role,
        await sha256Hex(token),
        input.invitedBy,
        input.now,
        expiresAt,
      ),
  ]);
  if (!(await scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  return {
    ok: true,
    value: {
      invitation: {
        organisationInvitationId: invitationId,
        invitedEmail: input.email,
        role: input.role,
        createdAt: input.now,
        expiresAt,
        kind: "pending",
      },
      token,
    },
  };
}

/** Closes an open invitation, so that its link no longer works. */
export async function revokeInvitation(
  scope: OrganisationExecutionScope,
  invitationId: string,
  now: number,
): Promise<Result<PendingInvitation, InvitationError>> {
  const row = await readInvitation(scope, invitationId);
  if (row === null)
    return { ok: false, error: { code: "organisation_invitation_not_found" } };
  if (row.state !== "pending")
    return { ok: false, error: { code: "organisation_invitation_closed" } };
  const [, revoked] = await scope.database.batch([
    scope.prepareMutationFence(),
    scope.database
      .prepare(
        `UPDATE organisation_invitation SET state = 'revoked', revoked_at = ?
         WHERE organisation_id = ? AND invitation_id = ? AND state = 'pending'`,
      )
      .bind(now, scope.organisationId, invitationId),
  ]);
  if (revoked?.meta.changes !== 1)
    return { ok: false, error: { code: "organisation_invitation_closed" } };
  return { ok: true, value: pendingInvitation(row) };
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
  }>,
): Promise<Result<ActiveOrganisationMembership, InvitationError>> {
  const row = await readInvitation(scope, input.invitationId);
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
  const existing = await readActiveOrganisationMembership(
    db,
    scope.organisationId,
    input.user.userId,
  );
  if (existing !== null) {
    await db.batch([scope.prepareMutationFence(), close]);
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
    ]);
  }
  const accepted = await readInvitation(scope, input.invitationId);
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
  scope: OrganisationExecutionScope,
  invitationId: string,
): Promise<InvitationRow | null> {
  return scope.database
    .withSession("first-primary")
    .prepare(
      `SELECT ${INVITATION_COLUMNS} FROM organisation_invitation
       WHERE organisation_id = ? AND invitation_id = ?`,
    )
    .bind(scope.organisationId, invitationId)
    .first<InvitationRow>();
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
