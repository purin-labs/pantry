import { prepareBootstrapOrganisationRow } from "./shared-rows/organisation-row";
import { prepareConfiguringOnboardingRow } from "./organisation-lifecycle-moves";
import {
  prepareBootstrapPlacement,
  prepareInitialPlacementActivation,
} from "./shared-rows/placement-row";
import { prepareBootstrapReceiptPublication } from "./shared-rows/mutation-receipt";
import type { GlobalDatabase, OrganisationDatabase } from "../database-handles";
import type { ControlMembershipAvailability } from "@purin-labs/control-api";
import type {
  OrganisationAccess,
  OrganisationAdmissionAction,
  OrganisationAccessFailure,
} from "../organisation-access/access";
import {
  OrganisationExecutionScope,
  configuredOrganisationDatabases,
  selectOrganisationPlacementDatabase,
  type FencedRead,
  type OrganisationPlacementBindings,
  type OrganisationExecutionScopeError,
} from "../organisation-execution-scope";
import {
  newUserId,
  newControlSessionId,
  newPersonId,
  newOrganisationId,
  newWorkspaceId,
  parseUserId,
  parseControlSessionId,
  parseOrganisationHandle,
  parsePersonId,
  parseOrganisationId,
  parseWorkspaceHandle,
  parseWorkspaceId,
  type UserId,
  type ControlSessionId,
  type OrganisationHandle,
  type PersonId,
  type OrganisationId,
  type WorkspaceHandle,
  type WorkspaceId,
} from "../ids";
import {
  parseInitialOrganisationPlacement,
  type InitialOrganisationPlacement,
} from "../placement";
import type { Result } from "../result";
import {
  readControlMutationReplay,
  prepareControlMutationReceipt,
  prepareOnboardingAuditEvent,
  prepareOnboardingEvent,
  type ControlMutationBoundary,
  type UnversionedControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "./control-mutation";
import { organisationLifecycleParts } from "./organisation-lifecycle-port";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import type {
  OrganisationQuerySource,
  GlobalQuerySource,
} from "./query-source";
import {
  prepareBaseProjectRoleChange,
  prepareProjectMembershipRevocation,
} from "../projects/default-project";
import {
  prepareChatDirectoryRevisionBump,
  prepareReturnPrivateChatsToDefault,
} from "../projects/case-project";
import type { OnboardingControlRole } from "@purin-labs/contracts";
import { encodeBase64Url, isPositiveInteger, isRecord } from "@purin-labs/std";
import {
  prepareConfigurationVersionBump,
} from "./organisation-onboarding-row";

export type ControlRole = OnboardingControlRole;
export type AssignableControlRole = Exclude<ControlRole, "owner">;
export type OrganisationEnvironment = "development" | "production";
export type OrganisationInvitationEmail = { readonly value: string };
export type OrganisationOnboardingLifecycle =
  | {
      readonly kind: "configuring";
      readonly organisationId: OrganisationId;
      readonly configurationVersion: number;
      readonly environment: OrganisationEnvironment;
    }
  | {
      readonly kind: "activating";
      readonly organisationId: OrganisationId;
      readonly activationAttemptId: string;
      readonly readinessVersion: number;
      readonly environment: OrganisationEnvironment;
    }
  | {
      readonly kind: "active";
      readonly organisationId: OrganisationId;
      readonly activationReceiptId: string;
      readonly activatedAt: number;
      readonly environment: OrganisationEnvironment;
    }
  | {
      readonly kind: "archived";
      readonly organisationId: OrganisationId;
      readonly archivedAt: number;
      readonly purgeAfter: number;
      readonly environment: OrganisationEnvironment;
    };

export type VerifiedOidcIdentity = {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: true;
};

export type User = VerifiedOidcIdentity & {
  readonly userId: UserId;
  readonly createdAt: number;
  readonly lastAuthenticatedAt: number;
};

export type ActiveControlSession = {
  readonly kind: "active";
  readonly controlSessionId: ControlSessionId;
  readonly userId: UserId;
  readonly rotationGeneration: number;
  readonly createdAt: number;
  readonly rotatedAt: number;
  readonly expiresAt: number;
};

export type IssuedControlSession = {
  readonly session: ActiveControlSession;
  readonly token: string;
  readonly csrfToken: string;
};

export type ActiveOrganisationMembership = {
  readonly kind: "active";
  readonly organisationId: OrganisationId;
  readonly userId: UserId;
  readonly personId: PersonId;
  readonly role: ControlRole;
  readonly createdAt: number;
};

export type OrganisationWorkspace = {
  readonly workspaceId: WorkspaceId;
  readonly workspaceHandle: WorkspaceHandle;
  readonly name: string;
  readonly createdAt: number;
};

type OrganisationMembership = ActiveOrganisationMembership & {
  readonly organisationHandle: OrganisationHandle;
  readonly workspaces: readonly [
    OrganisationWorkspace,
    ...OrganisationWorkspace[],
  ];
};

export type OrganisationMember = ActiveOrganisationMembership & {
  readonly displayName: string;
};

type ControlAuthorization = {
  readonly session: ActiveControlSession;
  readonly membership: ActiveOrganisationMembership;
};

export type OrganisationBootstrap = {
  readonly organisationId: OrganisationId;
  readonly organisationHandle: OrganisationHandle;
  readonly workspace: OrganisationWorkspace;
  readonly personId: PersonId;
  readonly membership: ActiveOrganisationMembership;
  readonly onboarding: Variant<OrganisationOnboardingLifecycle, "configuring">;
  readonly mutationReceiptId: string;
};

export type OrganisationBootstrapMutation = {
  readonly boundary: UnversionedControlMutationBoundary;
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ControlMutationIdentity;
};

type OrganisationMembershipMutation = {
  readonly boundary: Variant<
    ControlMutationBoundary,
    "configuration_versioned"
  >;
  readonly scope: ControlMutationReceiptScope;
  readonly identity: ControlMutationIdentity;
};

type OrganisationMembershipMutationError =
  | { readonly code: "organisation_membership_not_found" }
  | { readonly code: "organisation_final_owner_required" }
  | { readonly code: "configuration_version_conflict" }
  | {
      readonly code: "organisation_lifecycle_conflict";
      readonly lifecycle: string;
    };

export type ControlSessionError =
  | { readonly code: "control_session_missing" }
  | { readonly code: "control_session_expired" }
  | { readonly code: "control_session_revoked" }
  | { readonly code: "control_session_corrupt" }
  | { readonly code: "control_session_rotation_conflict" };

type ControlAuthorizationError =
  | OrganisationAccessFailure
  | ControlSessionError
  | { readonly code: "csrf_invalid" }
  | {
      readonly code: "organisation_membership_missing";
      readonly organisationId: OrganisationId;
    }
  | {
      readonly code: "organisation_role_insufficient";
      readonly organisationId: OrganisationId;
      readonly requiredRole: ControlRole;
      readonly actualRole: ControlRole;
    };

type UserRow = {
  userId: unknown;
  issuer: unknown;
  subject: unknown;
  email: unknown;
  displayName: unknown;
  emailVerified: unknown;
  createdAt: unknown;
  lastAuthenticatedAt: unknown;
};

type ControlSessionRow = {
  controlSessionId: unknown;
  userId: unknown;
  rotationGeneration: unknown;
  createdAt: unknown;
  rotatedAt: unknown;
  expiresAt: unknown;
  revokedAt: unknown;
};

export type OrganisationMembershipRow = {
  organisationId: unknown;
  userId: unknown;
  personId: unknown;
  role: unknown;
  status: unknown;
  createdAt: unknown;
};

type OrganisationWorkspaceMembershipRow = OrganisationMembershipRow & {
  organisationHandle: unknown;
  workspaceId: unknown;
  workspaceHandle: unknown;
  workspaceName: unknown;
  workspaceCreatedAt: unknown;
};

type OrganisationMemberRow = OrganisationMembershipRow & {
  displayName: unknown;
};

/**
 * Whether a membership may change organisation configuration.
 *
 * The Portal's configuration route requires `admin`; Slack must ask the same
 * question of the same table, or the two surfaces drift into different
 * answers for the same person.
 */
export function roleMayConfigure(role: ControlRole): boolean {
  return CONTROL_ROLE_RANK[role] >= CONTROL_ROLE_RANK.admin;
}

/** The role that the shop's daily pages need, such as the order queue. */
export function roleMayOperate(role: ControlRole): boolean {
  return CONTROL_ROLE_RANK[role] >= CONTROL_ROLE_RANK.operator;
}

const CONTROL_ROLE_RANK: Readonly<Record<ControlRole, number>> = {
  owner: 4,
  admin: 3,
  operator: 2,
  viewer: 1,
};

export function parseControlRole(
  raw: unknown,
): Result<ControlRole, { code: "invalid_control_role" }> {
  switch (raw) {
    case "owner":
    case "admin":
    case "operator":
    case "viewer":
      return { ok: true, value: raw };
    default:
      return { ok: false, error: { code: "invalid_control_role" } };
  }
}

export function parseOrganisationInvitationEmail(
  raw: unknown,
): Result<
  OrganisationInvitationEmail,
  { readonly code: "invalid_organisation_invitation_email" }
> {
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: { code: "invalid_organisation_invitation_email" },
    };
  }
  const value = raw.trim().toLowerCase();
  const separator = value.indexOf("@");
  if (
    value.length > 320 ||
    separator < 1 ||
    separator === value.length - 1 ||
    value.indexOf("@", separator + 1) !== -1
  ) {
    return {
      ok: false,
      error: { code: "invalid_organisation_invitation_email" },
    };
  }
  return { ok: true, value: { value } };
}

export function parseAssignableControlRole(
  raw: unknown,
): Result<AssignableControlRole, { code: "invalid_assignable_control_role" }> {
  switch (raw) {
    case "admin":
    case "operator":
    case "viewer":
      return { ok: true, value: raw };
    default:
      return { ok: false, error: { code: "invalid_assignable_control_role" } };
  }
}

export async function upsertUser(input: {
  readonly db: GlobalDatabase;
  readonly identity: VerifiedOidcIdentity;
  readonly now: number;
}): Promise<User> {
  const existing = await input.db
    .prepare(
      `SELECT
         user_id AS userId,
         issuer,
         subject,
         email,
         display_name AS displayName,
         email_verified AS emailVerified,
         created_at AS createdAt,
         last_authenticated_at AS lastAuthenticatedAt
       FROM app_user
       WHERE issuer = ? AND subject = ?`,
    )
    .bind(input.identity.issuer, input.identity.subject)
    .first<UserRow>();

  const userId =
    existing === null ? newUserId() : requireUserId(existing.userId);
  const createdAt =
    existing === null ? input.now : requireInteger(existing.createdAt);

  await input.db
    .prepare(
      `INSERT INTO app_user (
         user_id, issuer, subject, email, display_name, email_verified,
         created_at, last_authenticated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (issuer, subject) DO UPDATE SET
         email = excluded.email,
         display_name = excluded.display_name,
         email_verified = 1,
         last_authenticated_at = excluded.last_authenticated_at`,
    )
    .bind(
      userId,
      input.identity.issuer,
      input.identity.subject,
      normalizeEmail(input.identity.email),
      normalizeDisplayName(input.identity.displayName),
      createdAt,
      input.now,
    )
    .run();

  return {
    userId,
    issuer: input.identity.issuer,
    subject: input.identity.subject,
    email: normalizeEmail(input.identity.email),
    displayName: normalizeDisplayName(input.identity.displayName),
    emailVerified: true,
    createdAt,
    lastAuthenticatedAt: input.now,
  };
}

export async function resolveUser(input: {
  readonly db: GlobalQuerySource;
  readonly userId: UserId;
}): Promise<User | null> {
  const row = await input.db
    .prepare(
      `SELECT
         user_id AS userId,
         issuer,
         subject,
         email,
         display_name AS displayName,
         email_verified AS emailVerified,
         created_at AS createdAt,
         last_authenticated_at AS lastAuthenticatedAt
       FROM app_user
       WHERE user_id = ?`,
    )
    .bind(input.userId)
    .first<UserRow>();

  return row === null ? null : parseUserRow(row);
}

export async function issueControlSession(input: {
  readonly db: GlobalDatabase;
  readonly userId: UserId;
  readonly now: number;
  readonly ttlMs: number;
}): Promise<IssuedControlSession> {
  const controlSessionId = newControlSessionId();
  const token = randomOpaqueToken();
  const csrfToken = randomOpaqueToken();
  const expiresAt = input.now + requirePositiveInteger(input.ttlMs);

  await input.db
    .prepare(
      `INSERT INTO control_session (
         control_session_id, user_id, token_hash, csrf_hash,
         rotation_generation, created_at, rotated_at, expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
    )
    .bind(
      controlSessionId,
      input.userId,
      await hashOpaqueSecret(token),
      await hashOpaqueSecret(csrfToken),
      input.now,
      input.now,
      expiresAt,
    )
    .run();

  return {
    session: {
      kind: "active",
      controlSessionId,
      userId: input.userId,
      rotationGeneration: 1,
      createdAt: input.now,
      rotatedAt: input.now,
      expiresAt,
    },
    token,
    csrfToken,
  };
}

export async function resolveControlSession(input: {
  readonly db: GlobalQuerySource;
  readonly token: string;
  readonly now: number;
}): Promise<Result<ActiveControlSession, ControlSessionError>> {
  const row = await input.db
    .prepare(
      `SELECT
         control_session_id AS controlSessionId,
         user_id AS userId,
         rotation_generation AS rotationGeneration,
         created_at AS createdAt,
         rotated_at AS rotatedAt,
         expires_at AS expiresAt,
         revoked_at AS revokedAt
       FROM control_session
       WHERE token_hash = ?`,
    )
    .bind(await hashOpaqueSecret(input.token))
    .first<ControlSessionRow>();

  return validateResolvedControlSession(row, input.now);
}

// Durable work retains the session identity, never the browser's bearer token.
export async function resolveControlSessionById(input: {
  readonly db: GlobalQuerySource;
  readonly controlSessionId: ControlSessionId;
  readonly now: number;
}): Promise<Result<ActiveControlSession, ControlSessionError>> {
  const row = await input.db
    .prepare(
      `SELECT control_session_id AS controlSessionId,
       user_id AS userId,
       rotation_generation AS rotationGeneration, created_at AS createdAt,
       rotated_at AS rotatedAt, expires_at AS expiresAt, revoked_at AS revokedAt
     FROM control_session WHERE control_session_id = ?`,
    )
    .bind(input.controlSessionId)
    .first<ControlSessionRow>();
  return validateResolvedControlSession(row, input.now);
}

function validateResolvedControlSession(
  row: ControlSessionRow | null,
  now: number,
): Result<ActiveControlSession, ControlSessionError> {
  if (row === null) {
    return { ok: false, error: { code: "control_session_missing" } };
  }

  const parsed = parseActiveControlSessionRow(row);
  if (!parsed.ok) {
    return parsed;
  }

  if (row.revokedAt !== null) {
    return { ok: false, error: { code: "control_session_revoked" } };
  }

  if (parsed.value.expiresAt <= now) {
    return { ok: false, error: { code: "control_session_expired" } };
  }

  return parsed;
}

// Extends the session in place: its tokens stay, so other tabs keep working.
// A session that was rotated, revoked or already renewed further is left alone.
export async function renewControlSession(input: {
  readonly db: GlobalDatabase;
  readonly session: ActiveControlSession;
  readonly expiresAt: number;
}): Promise<ActiveControlSession | null> {
  const result = await input.db
    .prepare(
      `UPDATE control_session
       SET expires_at = ?
       WHERE control_session_id = ? AND rotation_generation = ?
         AND revoked_at IS NULL AND expires_at < ?`,
    )
    .bind(
      input.expiresAt,
      input.session.controlSessionId,
      input.session.rotationGeneration,
      input.expiresAt,
    )
    .run();
  return hasExactlyOneChange(result)
    ? { ...input.session, expiresAt: input.expiresAt }
    : null;
}

export async function rotateControlSession(input: {
  readonly db: GlobalDatabase;
  readonly session: ActiveControlSession;
  readonly now: number;
  readonly expiresAt: number;
}): Promise<Result<IssuedControlSession, ControlSessionError>> {
  const token = randomOpaqueToken();
  const csrfToken = randomOpaqueToken();
  const rotationGeneration = input.session.rotationGeneration + 1;
  const expiresAt = input.expiresAt;
  const result = await input.db
    .prepare(
      `UPDATE control_session
       SET token_hash = ?, csrf_hash = ?, rotation_generation = ?, rotated_at = ?, expires_at = ?
       WHERE control_session_id = ? AND rotation_generation = ? AND revoked_at IS NULL`,
    )
    .bind(
      await hashOpaqueSecret(token),
      await hashOpaqueSecret(csrfToken),
      rotationGeneration,
      input.now,
      expiresAt,
      input.session.controlSessionId,
      input.session.rotationGeneration,
    )
    .run();

  if (!hasExactlyOneChange(result)) {
    return { ok: false, error: { code: "control_session_rotation_conflict" } };
  }

  return {
    ok: true,
    value: {
      session: {
        kind: "active",
        controlSessionId: input.session.controlSessionId,
        userId: input.session.userId,
        rotationGeneration,
        createdAt: input.session.createdAt,
        rotatedAt: input.now,
        expiresAt,
      },
      token,
      csrfToken,
    },
  };
}

export async function revokeControlSession(input: {
  readonly db: GlobalDatabase;
  readonly session: ActiveControlSession;
  readonly now: number;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE control_session
       SET revoked_at = ?
       WHERE control_session_id = ? AND revoked_at IS NULL`,
    )
    .bind(input.now, input.session.controlSessionId)
    .run();
}

export async function validateControlCsrf(input: {
  readonly db: GlobalQuerySource;
  readonly session: ActiveControlSession;
  readonly csrfToken: string;
}): Promise<
  Result<true, VariantBy<ControlAuthorizationError, "code", "csrf_invalid">>
> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS valid
       FROM control_session
       WHERE control_session_id = ? AND csrf_hash = ? AND rotation_generation = ?
         AND revoked_at IS NULL`,
    )
    .bind(
      input.session.controlSessionId,
      await hashOpaqueSecret(input.csrfToken),
      input.session.rotationGeneration,
    )
    .first<{ valid: unknown }>();

  return row?.valid === 1
    ? { ok: true, value: true }
    : { ok: false, error: { code: "csrf_invalid" } };
}

export async function authorizeOrganisationControl(input: {
  readonly db: OrganisationQuerySource;
  readonly accountAccess: OrganisationAccess;
  readonly action: OrganisationAdmissionAction;
  readonly session: ActiveControlSession;
  readonly organisationId: OrganisationId;
  readonly requiredRole: ControlRole;
  /**
   * The membership, when the caller read it live under the placement fence.
   * Without it, the membership is read here.
   */
  readonly membership?: ActiveOrganisationMembership | null;
}): Promise<Result<ControlAuthorization, ControlAuthorizationError>> {
  const membership =
    input.membership === undefined
      ? await readActiveOrganisationMembership(
          input.db,
          input.organisationId,
          input.session.userId,
        )
      : input.membership;
  if (membership === null || membership.role === null) {
    return {
      ok: false,
      error: {
        code: "organisation_membership_missing",
        organisationId: input.organisationId,
      },
    };
  }

  if (
    CONTROL_ROLE_RANK[membership.role] < CONTROL_ROLE_RANK[input.requiredRole]
  ) {
    return {
      ok: false,
      error: {
        code: "organisation_role_insufficient",
        organisationId: input.organisationId,
        requiredRole: input.requiredRole,
        actualRole: membership.role,
      },
    };
  }

  const account = await input.accountAccess.checkUser({
    userId: input.session.userId,
    authority: {
      kind: "authenticated_session",
      nativeSessionId: input.session.controlSessionId,
    },
    action: input.action,
  });
  if (!account.ok) return account;
  const currentMembership = await readActiveOrganisationMembership(
    input.db,
    input.organisationId,
    input.session.userId,
  );
  if (currentMembership === null)
    return {
      ok: false,
      error: {
        code: "organisation_membership_missing",
        organisationId: input.organisationId,
      },
    };
  if (
    CONTROL_ROLE_RANK[currentMembership.role] <
    CONTROL_ROLE_RANK[input.requiredRole]
  )
    return {
      ok: false,
      error: {
        code: "organisation_role_insufficient",
        organisationId: input.organisationId,
        requiredRole: input.requiredRole,
        actualRole: currentMembership.role,
      },
    };
  return {
    ok: true,
    value: { session: input.session, membership: currentMembership },
  };
}

export async function resolveOrganisationProvisioningActor(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<UserId | null> {
  const row = await input.db
    .prepare(
      `SELECT user_id AS userId FROM service_role_grant
       WHERE organisation_id = ? AND status = 'active' AND role = 'owner'
       ORDER BY user_id LIMIT 1`,
    )
    .bind(input.organisationId)
    .first<{ userId: unknown }>();

  if (row === null || typeof row.userId !== "string") {
    return null;
  }

  const parsed = parseUserId(row.userId);
  return parsed.ok ? parsed.value : null;
}

type OrganisationBootstrapError =
  | OrganisationExecutionScopeError
  | { readonly code: "idempotency_key_conflict" }
  | { readonly code: "organisation_bootstrap_publication_pending" };

export async function bootstrapOrganisation(input: {
  readonly env: OrganisationPlacementBindings;
  readonly owner: User;
  readonly organisationName: string;
  readonly environment: OrganisationEnvironment;
  readonly placement: InitialOrganisationPlacement;
  readonly mutation: OrganisationBootstrapMutation;
  readonly now: number;
}): Promise<Result<OrganisationBootstrap, OrganisationBootstrapError>> {
  const parts = organisationLifecycleParts().creation;
  const reserved = await reserveOrganisationBootstrap(input);
  if (!reserved.ok) return reserved;
  const reservation = reserved.value;
  const organisationId = reservation.organisationId;
  const personId = reservation.personId;
  const organisationHandle = reservation.organisationHandle;
  const workspace = reservation.workspace;
  const defaultProjectId = await parts.baseProjectId(organisationId);
  const organisationName = normalizeOrganisationName(input.organisationName);
  const selected = selectOrganisationPlacementDatabase(
    input.env,
    organisationId,
    reservation.placement,
  );
  if (!selected.ok) return selected;
  const session = selected.value.withSession("first-primary");
  const receipt = {
    receipt_id: reservation.receiptId,
    organisation_id: organisationId,
  };
  const completed = await session
    .prepare(
      "SELECT 1 AS present FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first();

  if (completed === null) {
    try {
      await session.batch([
        prepareBootstrapOrganisationRow(session, reservation, organisationName),
        ...parts.workspace(session, {
          organisationId,
          workspaceId: workspace.workspaceId,
          workspaceHandle: workspace.workspaceHandle,
          name: workspace.name,
          createdAt: workspace.createdAt,
        }),
        prepareBootstrapPlacement(session, reservation, input.environment),
        prepareInitialPlacementActivation(session, {
          organisationId,
          fenceToken: reservation.fenceToken,
          activatedAt: reservation.createdAt,
        }),
        session
          .prepare(
            `INSERT INTO person (organisation_id, person_id, display_name)
         VALUES (?, ?, ?)`,
          )
          .bind(organisationId, personId, input.owner.displayName),
        session
          .prepare(
            `INSERT INTO service_role_grant (
           organisation_id, user_id, person_id, role, status, created_at, revoked_at
         ) VALUES (?, ?, ?, 'owner', 'active', ?, NULL)`,
          )
          .bind(
            organisationId,
            input.owner.userId,
            personId,
            reservation.createdAt,
          ),
        ...parts.baseProject(session, {
          organisationId,
          projectId: defaultProjectId,
          ownerUserId: input.owner.userId,
          now: reservation.createdAt,
        }),
        prepareConfiguringOnboardingRow(session, {
          organisationId,
          environment: input.environment,
          capabilityProfile: "read_and_propose",
          now: reservation.createdAt,
        }),
        ...parts.accessDefaults(session, {
          organisationId,
          placement: reservation.placement,
          materializationReceiptId: reservation.receiptId,
          now: reservation.createdAt,
        }),
        prepareOnboardingAuditEvent(session, input.mutation.identity, {
          organisationId,
          environment: input.environment,
          actorUserId: input.owner.userId,
          operation: "organisation.create",
          targetKind: "organisation",
          targetId: organisationId,
          oldLifecycle: null,
          newLifecycle: "configuring",
          configurationVersion: 1,
          projectionRevision: 1,
          reasonCode: "merchant_created",
        }),
        prepareOnboardingEvent(session, input.mutation.identity, {
          eventId: `event_${crypto.randomUUID()}`,
          eventType: "organisation_created",
          organisationId,
          environment: input.environment,
          projectionRevision: 1,
          attributes: {
            lifecycle: "configuring",
            receipt_id: reservation.receiptId,
          },
        }),
        prepareOnboardingEvent(session, input.mutation.identity, {
          eventId: `event_${crypto.randomUUID()}`,
          eventType: "onboarding_started",
          organisationId,
          environment: input.environment,
          projectionRevision: 1,
          attributes: {
            stage: "workspace",
            receipt_id: reservation.receiptId,
          },
        }),
        prepareOnboardingEvent(session, input.mutation.identity, {
          eventId: `event_${crypto.randomUUID()}`,
          eventType: "onboarding_stage_completed",
          organisationId,
          environment: input.environment,
          projectionRevision: 1,
          attributes: {
            stage: "workspace",
            receipt_id: reservation.receiptId,
          },
        }),
      ]);
    } catch (error) {
      const committed = await session
        .prepare(
          "SELECT 1 FROM organisation_onboarding WHERE organisation_id = ?",
        )
        .bind(organisationId)
        .first();
      if (committed === null) throw error;
    }
  }
  const ready = await session
    .prepare(
      `SELECT 1 FROM organisation_onboarding AS onboarding
     JOIN organisation_placement AS placement ON placement.organisation_id = onboarding.organisation_id
     WHERE onboarding.organisation_id = ? AND placement.placement_epoch = 1
       AND placement.placement_cell_id = ? AND placement.fence_token = ?
       AND placement.status = 'active'`,
    )
    .bind(
      organisationId,
      reservation.placement.placementCellId,
      reservation.fenceToken,
    )
    .first();
  if (ready === null) {
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  }
  const directory = input.env.DB.withSession("first-primary");
  await directory.batch([
    prepareInitialPlacementActivation(directory, {
      organisationId,
      fenceToken: reservation.fenceToken,
      activatedAt: reservation.createdAt,
    }),
    prepareBootstrapReceiptPublication(directory, {
      receiptId: reservation.receiptId,
      requestHash: input.mutation.boundary.requestHash,
      responseBody: { ...receipt, reservation },
      organisationId,
      fenceToken: reservation.fenceToken,
    }),
  ]);

  const published = await directory
    .prepare(
      `SELECT 1 FROM control_mutation_receipt AS receipt
     JOIN organisation_placement AS placement ON placement.organisation_id = ?
     WHERE receipt.receipt_id = ? AND receipt.request_hash = ?
       AND receipt.response_status = 201 AND placement.placement_epoch = 1
       AND placement.fence_token = ? AND placement.status = 'active'`,
    )
    .bind(
      organisationId,
      reservation.receiptId,
      input.mutation.boundary.requestHash,
      reservation.fenceToken,
    )
    .first();
  if (published === null) {
    return {
      ok: false,
      error: { code: "organisation_bootstrap_publication_pending" },
    };
  }
  return {
    ok: true,
    value: {
      organisationId,
      organisationHandle,
      workspace,
      personId,
      membership: {
        kind: "active",
        organisationId,
        userId: input.owner.userId,
        personId,
        role: "owner",
        createdAt: reservation.createdAt,
      },
      onboarding: {
        kind: "configuring",
        organisationId,
        configurationVersion: 1,
        environment: input.environment,
      },
      mutationReceiptId: reservation.receiptId,
    },
  };
}

export type OrganisationBootstrapReservation = {
  readonly organisationId: OrganisationId;
  readonly personId: PersonId;
  readonly organisationHandle: OrganisationHandle;
  readonly workspace: OrganisationWorkspace;
  readonly placement: InitialOrganisationPlacement;
  readonly fenceToken: string;
  readonly receiptId: string;
  readonly createdAt: number;
};

async function reserveOrganisationBootstrap(
  input: Parameters<typeof bootstrapOrganisation>[0],
): Promise<
  Result<OrganisationBootstrapReservation, OrganisationBootstrapError>
> {
  const replay = await readControlMutationReplay({
    db: input.env.DB,
    scope: input.mutation.scope,
    boundary: input.mutation.boundary,
  });
  if (replay.kind === "conflict") {
    return { ok: false, error: { code: "idempotency_key_conflict" } };
  }
  if (replay.kind === "replay")
    return {
      ok: true,
      value: parseOrganisationBootstrapReservation(replay.receipt.responseBody),
    };
  const reservation: OrganisationBootstrapReservation = {
    organisationId: newOrganisationId(),
    personId: newPersonId(),
    organisationHandle: await allocateOrganisationHandle(
      input.env.DB,
      normalizeOrganisationName(input.organisationName),
    ),
    workspace: initialOrganisationWorkspace(input.now),
    placement: input.placement,
    fenceToken: crypto.randomUUID(),
    receiptId: input.mutation.identity.receiptId,
    createdAt: input.now,
  };
  const selected = selectOrganisationPlacementDatabase(
    input.env,
    reservation.organisationId,
    reservation.placement,
  );
  if (!selected.ok) return selected;
  const session = input.env.DB.withSession("first-primary");
  try {
    await session.batch([
      prepareBootstrapOrganisationRow(
        session,
        reservation,
        normalizeOrganisationName(input.organisationName),
      ),
      prepareBootstrapPlacement(session, reservation, input.environment),
      prepareControlMutationReceipt(session, {
        scope: input.mutation.scope,
        boundary: input.mutation.boundary,
        identity: input.mutation.identity,
        responseStatus: 202,
        responseBody: { reservation },
      }),
    ]);
    return { ok: true, value: reservation };
  } catch (error) {
    const concurrent = await readControlMutationReplay({
      db: input.env.DB,
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
    });
    if (concurrent.kind === "replay")
      return {
        ok: true,
        value: parseOrganisationBootstrapReservation(
          concurrent.receipt.responseBody,
        ),
      };
    throw error;
  }
}

function parseOrganisationBootstrapReservation(
  raw: unknown,
): OrganisationBootstrapReservation {
  if (!isRecord(raw) || !isRecord(raw.reservation))
    throw new Error("organisation_bootstrap_reservation_corrupt");
  const row = raw.reservation;
  if (
    !isRecord(row.workspace) ||
    typeof row.organisationHandle !== "string" ||
    typeof row.workspace.workspaceId !== "string" ||
    typeof row.workspace.workspaceHandle !== "string" ||
    typeof row.workspace.name !== "string" ||
    typeof row.fenceToken !== "string" ||
    row.fenceToken.length === 0 ||
    typeof row.receiptId !== "string"
  )
    throw new Error("organisation_bootstrap_reservation_corrupt");
  const organisationHandle = parseOrganisationHandle(row.organisationHandle);
  const workspaceId = parseWorkspaceId(row.workspace.workspaceId);
  const workspaceHandle = parseWorkspaceHandle(row.workspace.workspaceHandle);
  const placement = parseInitialOrganisationPlacement(row.placement);
  if (
    !organisationHandle.ok ||
    !workspaceId.ok ||
    !workspaceHandle.ok ||
    !placement.ok
  )
    throw new Error("organisation_bootstrap_reservation_corrupt");
  return {
    organisationId: requireOrganisationId(row.organisationId),
    personId: requirePersonId(row.personId),
    organisationHandle: organisationHandle.value,
    workspace: {
      workspaceId: workspaceId.value,
      workspaceHandle: workspaceHandle.value,
      name: row.workspace.name,
      createdAt: requireInteger(row.workspace.createdAt),
    },
    placement: placement.value,
    fenceToken: row.fenceToken,
    receiptId: row.receiptId,
    createdAt: requireInteger(row.createdAt),
  };
}

type ScopedControlMembership =
  | Readonly<{
      kind: "placed";
      membership: OrganisationMembership;
      execution: OrganisationExecutionScope;
    }>
  | Readonly<{ kind: "unavailable"; membership?: never; execution?: never }>;

type ControlMembershipLookup = Readonly<{
  env: OrganisationPlacementBindings;
  userId: UserId;
}>;

export async function listControlMemberships(
  input: ControlMembershipLookup,
): Promise<readonly OrganisationMembership[]> {
  const candidates = await listScopedControlMemberships(input);
  return candidates.flatMap(placedMembership);
}

function placedMembership(
  candidate: ScopedControlMembership,
): readonly OrganisationMembership[] {
  return candidate.kind === "placed" ? [candidate.membership] : [];
}

async function listScopedControlMemberships(
  input: ControlMembershipLookup,
): Promise<readonly ScopedControlMembership[]> {
  const memberships = await Promise.all(
    configuredOrganisationDatabases(input.env).map(
      listPlacedControlMemberships.bind(null, input),
    ),
  );
  return memberships.flat();
}

/** Keep the resolved scope for the current request's live eligibility check. */
async function listPlacedControlMemberships(
  input: ControlMembershipLookup,
  database: OrganisationDatabase,
): Promise<readonly ScopedControlMembership[]> {
  try {
    const candidates = await listRegionalControlMemberships({
      db: database,
      userId: input.userId,
    });
    const scopes = await Promise.all(
      candidates.map(
        resolvePlacedControlMembership.bind(null, input.env, database),
      ),
    );
    return scopes.flat();
  } catch {
    return [{ kind: "unavailable" }];
  }
}

async function resolvePlacedControlMembership(
  env: OrganisationPlacementBindings,
  database: D1Database,
  membership: OrganisationMembership,
): Promise<readonly ScopedControlMembership[]> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    membership.organisationId,
  );
  if (!execution.ok) return [{ kind: "unavailable" }];
  if (execution.value.database !== database) return [];
  return [{ kind: "placed", membership, execution: execution.value }];
}

async function listRegionalControlMemberships(input: {
  readonly db: OrganisationQuerySource;
  readonly userId: UserId;
}): Promise<readonly OrganisationMembership[]> {
  const rows = await input.db
    .prepare(
      `SELECT
         service_role_grant.organisation_id AS organisationId,
         service_role_grant.user_id AS userId,
         service_role_grant.person_id AS personId,
         service_role_grant.role,
         service_role_grant.status,
         service_role_grant.created_at AS createdAt,
         organisation.organisation_handle AS organisationHandle,
         organisation_workspace.workspace_id AS workspaceId,
         organisation_workspace.workspace_handle AS workspaceHandle,
         organisation_workspace.name AS workspaceName,
         organisation_workspace.created_at AS workspaceCreatedAt
       FROM service_role_grant
       JOIN organisation ON organisation.organisation_id = service_role_grant.organisation_id
       JOIN organisation_workspace ON organisation_workspace.organisation_id = organisation.organisation_id
       WHERE service_role_grant.user_id = ?
         AND service_role_grant.status = 'active'
         AND organisation_workspace.status = 'active'
       ORDER BY service_role_grant.organisation_id, organisation_workspace.created_at, organisation_workspace.workspace_id`,
    )
    .bind(input.userId)
    .all<OrganisationWorkspaceMembershipRow>();

  return parseOrganisationMemberships(rows.results);
}

interface EligibleControlMemberships {
  readonly memberships: readonly OrganisationMembership[];
  readonly availability: ControlMembershipAvailability;
}

type ControlMembershipEligibility =
  | Readonly<{ kind: "eligible"; membership: OrganisationMembership }>
  | Readonly<{ kind: "ineligible" | "unavailable"; membership?: never }>;

export async function listEligibleControlMemberships(
  input: Readonly<{
    env: OrganisationPlacementBindings;
    session: ActiveControlSession;
  }>,
): Promise<EligibleControlMemberships> {
  const candidates = await listScopedControlMemberships({
    env: input.env,
    userId: input.session.userId,
  });
  const checked = await Promise.all(
    candidates.map(checkControlMembershipEligibility.bind(null, input.session)),
  );
  const memberships: OrganisationMembership[] = [];
  let availability: ControlMembershipAvailability = "complete";
  for (const candidate of checked) {
    if (candidate.kind === "eligible") memberships.push(candidate.membership);
    if (candidate.kind === "unavailable") availability = "incomplete";
  }
  return { memberships, availability };
}

async function checkControlMembershipEligibility(
  session: ActiveControlSession,
  candidate: ScopedControlMembership,
): Promise<ControlMembershipEligibility> {
  if (candidate.kind === "unavailable") return candidate;
  try {
    const current = await candidate.execution.accountAccess.checkUser({
      userId: session.userId,
      authority: {
        kind: "authenticated_session",
        nativeSessionId: session.controlSessionId,
      },
      action: "disclose",
    });
    if (!current.ok)
      return {
        kind:
          current.error.code === "authority_unavailable"
            ? "unavailable"
            : "ineligible",
      };
    const grant = await readActiveOrganisationMembership(
      candidate.execution.database,
      candidate.membership.organisationId,
      session.userId,
    );
    if (grant === null) return { kind: "ineligible" };
    return {
      kind: "eligible",
      membership: {
        kind: "active",
        organisationId: grant.organisationId,
        userId: grant.userId,
        personId: grant.personId,
        role: grant.role,
        createdAt: grant.createdAt,
        organisationHandle: candidate.membership.organisationHandle,
        workspaces: candidate.membership.workspaces,
      },
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function readActiveOrganisationMembershipRevision(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<number | null> {
  const row = await input.db
    .prepare(
      `SELECT MAX(configuration_version) AS revision
       FROM organisation_onboarding
      WHERE organisation_id = ? AND lifecycle = 'active'`,
    )
    .bind(input.organisationId)
    .first<{ readonly revision: unknown }>();
  return typeof row?.revision === "number" &&
    Number.isSafeInteger(row.revision) &&
    row.revision > 0
    ? row.revision
    : null;
}

export async function listOrganisationMembers(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<readonly OrganisationMember[]> {
  const rows = await input.db
    .prepare(
      `SELECT
         m.organisation_id AS organisationId,
         m.user_id AS userId,
         m.person_id AS personId,
         m.role,
         m.status,
         m.created_at AS createdAt,
         p.display_name AS displayName
       FROM service_role_grant m
       JOIN person p ON p.organisation_id = m.organisation_id AND p.person_id = m.person_id
       WHERE m.organisation_id = ? AND m.status = 'active'
       ORDER BY CASE m.role
         WHEN 'owner' THEN 0
         WHEN 'admin' THEN 1
         WHEN 'operator' THEN 2
         ELSE 3
       END, p.display_name, m.user_id`,
    )
    .bind(input.organisationId)
    .all<OrganisationMemberRow>();

  return rows.results.map(parseOrganisationMemberRow);
}

export async function listOrganisationMemberProfiles(input: {
  readonly db: OrganisationQuerySource;
  readonly identityDatabase: GlobalQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<readonly (OrganisationMember & { readonly email: string })[]> {
  const members = await listOrganisationMembers(input);
  const profiles: (OrganisationMember & { readonly email: string })[] = [];
  for (const member of members) {
    const identity = await resolveUser({
      db: input.identityDatabase,
      userId: member.userId,
    });
    if (identity !== null) profiles.push({ ...member, email: identity.email });
  }
  return profiles;
}

export async function changeOrganisationServiceRole(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly targetUserId: UserId;
  readonly nextRole: ControlRole;
  readonly changedByUserId: UserId;
  readonly mutation: OrganisationMembershipMutation;
  readonly now: number;
}): Promise<
  Result<
    {
      readonly member: ActiveOrganisationMembership;
      readonly receiptId: string;
    },
    OrganisationMembershipMutationError
  >
> {
  const session = input.db.withSession("first-primary");
  const state = await readOrganisationMembershipMutationState(
    session,
    input.organisationId,
  );
  if (state === null) {
    return { ok: false, error: { code: "organisation_membership_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  if (
    state.lifecycle === "activating" ||
    state.lifecycle === "archived" ||
    state.lifecycle === "purging" ||
    state.lifecycle === "purged"
  ) {
    return {
      ok: false,
      error: {
        code: "organisation_lifecycle_conflict",
        lifecycle: state.lifecycle,
      },
    };
  }
  const member = await readActiveOrganisationMembership(
    session,
    input.organisationId,
    input.targetUserId,
  );
  if (member === null) {
    return { ok: false, error: { code: "organisation_membership_not_found" } };
  }
  if (
    member.role === "owner" &&
    input.nextRole !== "owner" &&
    (await countActiveOrganisationOwners(session, input.organisationId)) === 1
  ) {
    return { ok: false, error: { code: "organisation_final_owner_required" } };
  }
  const configurationVersion =
    member.role === input.nextRole
      ? state.configurationVersion
      : state.configurationVersion + 1;
  const projectionRevision =
    member.role === input.nextRole
      ? state.projectionRevision
      : state.projectionRevision + 1;
  const responseBody = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.organisationId,
    user_id: input.targetUserId,
    role: input.nextRole,
  };
  const statements: D1PreparedStatement[] = [];
  if (member.role !== input.nextRole) {
    statements.push(
      session
        .prepare(
          `UPDATE service_role_grant
         SET role = ?
         WHERE organisation_id = ? AND user_id = ? AND status = 'active'`,
        )
        .bind(input.nextRole, input.organisationId, input.targetUserId),
      ...prepareBaseProjectRoleChange(session, {
        organisationId: input.organisationId,
        userId: input.targetUserId,
        role: input.nextRole,
        now: input.now,
      }),
      prepareConfigurationVersionBump(session, input.organisationId, input.now, { atConfigurationVersion: state.configurationVersion }),
      session
        .prepare(
          `DELETE FROM organisation_readiness_assessment WHERE organisation_id = ?`,
        )
        .bind(input.organisationId),
      prepareOnboardingEvent(session, input.mutation.identity, {
        eventId: `event_${crypto.randomUUID()}`,
        eventType: "readiness_invalidated",
        organisationId: input.organisationId,
        environment: state.environment,
        projectionRevision,
        attributes: {
          reason_code: "organisation_membership_role_changed",
          configuration_version: configurationVersion,
        },
      }),
    );
  }
  statements.push(
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: state.environment,
      actorUserId: input.changedByUserId,
      operation: "organisation.service-role.change",
      targetKind: "service_role_grant",
      targetId: input.targetUserId,
      oldLifecycle: member.role,
      newLifecycle: input.nextRole,
      configurationVersion,
      projectionRevision,
      reasonCode:
        member.role === input.nextRole
          ? "membership_role_unchanged"
          : "membership_role_changed",
    }),
  );
  await session.batch(statements);
  const changed = await readActiveOrganisationMembership(
    session,
    input.organisationId,
    input.targetUserId,
  );
  if (changed === null || changed.role !== input.nextRole) {
    throw new Error("organisation membership role mutation invariant failed");
  }
  return {
    ok: true,
    value: {
      member: changed,
      receiptId: input.mutation.identity.receiptId,
    },
  };
}

/**
 * Remove a member. One batch revokes the role, returns the member's private
 * chats to the default Project and removes the member from each Project, so
 * the member's next request is refused (Plan 95).
 */
export async function revokeOrganisationMembership(input: {
  readonly execution: OrganisationExecutionScope;
  readonly organisationId: OrganisationId;
  readonly targetUserId: UserId;
  readonly revokedByUserId: UserId;
  readonly mutation: OrganisationMembershipMutation;
  readonly now: number;
}): Promise<
  Result<
    {
      readonly receiptId: string;
    },
    OrganisationMembershipMutationError
  >
> {
  if (input.execution.organisationId !== input.organisationId)
    return { ok: false, error: { code: "organisation_membership_not_found" } };
  const session = input.execution.database.withSession("first-primary");
  const state = await readOrganisationMembershipMutationState(
    session,
    input.organisationId,
  );
  if (state === null) {
    return { ok: false, error: { code: "organisation_membership_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  if (
    state.lifecycle === "activating" ||
    state.lifecycle === "archived" ||
    state.lifecycle === "purging" ||
    state.lifecycle === "purged"
  ) {
    return {
      ok: false,
      error: {
        code: "organisation_lifecycle_conflict",
        lifecycle: state.lifecycle,
      },
    };
  }
  const member = await readActiveOrganisationMembership(
    session,
    input.organisationId,
    input.targetUserId,
  );
  if (member === null) {
    return { ok: false, error: { code: "organisation_membership_not_found" } };
  }
  if (
    member.role === "owner" &&
    (await countActiveOrganisationOwners(session, input.organisationId)) === 1
  ) {
    return { ok: false, error: { code: "organisation_final_owner_required" } };
  }
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const responseBody = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.organisationId,
    user_id: input.targetUserId,
  };
  await session.batch([
    input.execution.prepareMutationFence(),
    session
      .prepare(
        `UPDATE service_role_grant
       SET status = 'revoked', revoked_at = ?
       WHERE organisation_id = ? AND user_id = ? AND status = 'active'`,
      )
      .bind(input.now, input.organisationId, input.targetUserId),
    ...prepareReturnPrivateChatsToDefault(session, {
      organisationId: input.organisationId,
      sourceProjectId: null,
      ownerUserId: input.targetUserId,
      now: input.now,
      guard: null,
    }),
    ...prepareProjectMembershipRevocation(session, {
      organisationId: input.organisationId,
      userId: input.targetUserId,
      now: input.now,
      guard: null,
    }),
    prepareChatDirectoryRevisionBump(session, input.organisationId),
    prepareConfigurationVersionBump(session, input.organisationId, input.now, { atConfigurationVersion: state.configurationVersion }),
    session
      .prepare(
        `DELETE FROM organisation_readiness_assessment WHERE organisation_id = ?`,
      )
      .bind(input.organisationId),
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: state.environment,
      actorUserId: input.revokedByUserId,
      operation: "organisation.membership.revoke",
      targetKind: "service_role_grant",
      targetId: input.targetUserId,
      oldLifecycle: member.role,
      newLifecycle: "revoked",
      configurationVersion,
      projectionRevision,
      reasonCode: "membership_revoked",
    }),
    prepareOnboardingEvent(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "readiness_invalidated",
      organisationId: input.organisationId,
      environment: state.environment,
      projectionRevision,
      attributes: {
        reason_code: "organisation_membership_revoked",
        configuration_version: configurationVersion,
      },
    }),
  ]);
  return {
    ok: true,
    value: { receiptId: input.mutation.identity.receiptId },
  };
}

export async function hashOpaqueSecret(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return encodeBase64Url(new Uint8Array(digest));
}

function parseActiveControlSessionRow(
  row: ControlSessionRow,
): Result<
  ActiveControlSession,
  VariantBy<ControlSessionError, "code", "control_session_corrupt">
> {
  const controlSessionId =
    typeof row.controlSessionId === "string"
      ? parseControlSessionId(row.controlSessionId)
      : { ok: false as const, error: { code: "invalid" as const, value: "" } };
  const userId =
    typeof row.userId === "string"
      ? parseUserId(row.userId)
      : { ok: false as const, error: { code: "invalid" as const, value: "" } };

  if (
    !controlSessionId.ok ||
    !userId.ok ||
    !isPositiveInteger(row.rotationGeneration) ||
    !isInteger(row.createdAt) ||
    !isInteger(row.rotatedAt) ||
    !isInteger(row.expiresAt)
  ) {
    return { ok: false, error: { code: "control_session_corrupt" } };
  }

  return {
    ok: true,
    value: {
      kind: "active",
      controlSessionId: controlSessionId.value,
      userId: userId.value,
      rotationGeneration: row.rotationGeneration,
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
      expiresAt: row.expiresAt,
    },
  };
}

function parseActiveOrganisationMembership(
  row: OrganisationMembershipRow,
): ActiveOrganisationMembership | null {
  if (row.status !== "active" || typeof row.organisationId !== "string") {
    return null;
  }

  const organisationId = parseOrganisationId(row.organisationId);
  const userId =
    typeof row.userId === "string" ? parseUserId(row.userId) : null;
  const personId =
    typeof row.personId === "string" ? parsePersonId(row.personId) : null;
  const role = parseControlRole(row.role);

  if (
    !organisationId.ok ||
    userId === null ||
    !userId.ok ||
    personId === null ||
    !personId.ok ||
    !role.ok ||
    !isInteger(row.createdAt)
  ) {
    return null;
  }

  return {
    kind: "active",
    organisationId: organisationId.value,
    userId: userId.value,
    personId: personId.value,
    role: role.value,
    createdAt: row.createdAt,
  };
}

export async function readActiveOrganisationMembership(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  userId: UserId,
): Promise<ActiveOrganisationMembership | null> {
  const row = await db
    .prepare(
      `SELECT organisation_id AS organisationId,
            user_id AS userId,
            person_id AS personId, role, status, created_at AS createdAt
     FROM service_role_grant
     WHERE organisation_id = ? AND user_id = ? AND status = 'active'`,
    )
    .bind(organisationId, userId)
    .first<OrganisationMembershipRow>();
  return row === null ? null : parseActiveOrganisationMembership(row);
}

/**
 * `readActiveOrganisationMembership` as a read under the placement fence. Its
 * row has null columns when the person has no active membership.
 */
export function activeOrganisationMembershipFencedRead(
  userId: UserId,
): FencedRead {
  return {
    columns: `membership.organisation_id AS organisationId,
            membership.user_id AS userId,
            membership.person_id AS personId, membership.role,
            membership.status, membership.created_at AS createdAt`,
    join: `service_role_grant AS membership
         ON membership.organisation_id = placement.organisation_id
        AND membership.user_id = ? AND membership.status = 'active'`,
    binds: [userId],
  };
}

export function parseFencedOrganisationMembership(
  row: OrganisationMembershipRow,
): ActiveOrganisationMembership | null {
  return parseActiveOrganisationMembership(row);
}

async function countActiveOrganisationOwners(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
     FROM service_role_grant
     WHERE organisation_id = ? AND status = 'active' AND role = 'owner'`,
    )
    .bind(organisationId)
    .first<{ readonly count: unknown }>();
  if (
    typeof row?.count !== "number" ||
    !Number.isSafeInteger(row.count) ||
    row.count < 1
  ) {
    throw new Error("organisation active owner invariant failed");
  }
  return row.count;
}

async function readOrganisationMembershipMutationState(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<{
  readonly environment: OrganisationEnvironment;
  readonly lifecycle: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT environment, lifecycle,
            configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly environment: unknown;
      readonly lifecycle: unknown;
      readonly configurationVersion: unknown;
      readonly projectionRevision: unknown;
    }>();
  if (row === null || typeof row.lifecycle !== "string") {
    return null;
  }
  return {
    environment: requireOrganisationEnvironment(row.environment),
    lifecycle: row.lifecycle,
    configurationVersion: requirePositiveInteger(row.configurationVersion),
    projectionRevision: requirePositiveInteger(row.projectionRevision),
  };
}

type OrganisationMembershipGroup = {
  readonly membership: ActiveOrganisationMembership;
  readonly organisationHandle: OrganisationHandle;
  readonly workspaces: OrganisationWorkspace[];
};

function parseOrganisationMemberships(
  rows: readonly OrganisationWorkspaceMembershipRow[],
): readonly OrganisationMembership[] {
  const groups = new Map<OrganisationId, OrganisationMembershipGroup>();
  for (const row of rows) {
    const parsed = parseOrganisationWorkspaceMembershipRow(row);
    if (parsed === null) continue;
    const current = groups.get(parsed.membership.organisationId);
    if (current === undefined) {
      groups.set(parsed.membership.organisationId, {
        membership: parsed.membership,
        organisationHandle: parsed.organisationHandle,
        workspaces: [parsed.workspace],
      });
      continue;
    }
    if (current.organisationHandle === parsed.organisationHandle) {
      current.workspaces.push(parsed.workspace);
    }
  }
  return [...groups.values()].flatMap(finalizeOrganisationMembership);
}

function parseOrganisationWorkspaceMembershipRow(
  row: OrganisationWorkspaceMembershipRow,
): {
  readonly membership: ActiveOrganisationMembership;
  readonly organisationHandle: OrganisationHandle;
  readonly workspace: OrganisationWorkspace;
} | null {
  const membership = parseActiveOrganisationMembership(row);
  const organisationHandle =
    typeof row.organisationHandle === "string"
      ? parseOrganisationHandle(row.organisationHandle)
      : null;
  const workspaceId =
    typeof row.workspaceId === "string"
      ? parseWorkspaceId(row.workspaceId)
      : null;
  const workspaceHandle =
    typeof row.workspaceHandle === "string"
      ? parseWorkspaceHandle(row.workspaceHandle)
      : null;
  if (
    membership === null ||
    organisationHandle === null ||
    !organisationHandle.ok ||
    workspaceId === null ||
    !workspaceId.ok ||
    workspaceHandle === null ||
    !workspaceHandle.ok ||
    typeof row.workspaceName !== "string" ||
    row.workspaceName.length === 0 ||
    typeof row.workspaceCreatedAt !== "number" ||
    !Number.isSafeInteger(row.workspaceCreatedAt) ||
    row.workspaceCreatedAt < 0
  ) {
    return null;
  }
  return {
    membership,
    organisationHandle: organisationHandle.value,
    workspace: {
      workspaceId: workspaceId.value,
      workspaceHandle: workspaceHandle.value,
      name: row.workspaceName,
      createdAt: row.workspaceCreatedAt,
    },
  };
}

function finalizeOrganisationMembership(
  group: OrganisationMembershipGroup,
): readonly OrganisationMembership[] {
  const [first, ...rest] = group.workspaces;
  return first === undefined
    ? []
    : [
        {
          ...group.membership,
          organisationHandle: group.organisationHandle,
          workspaces: [first, ...rest],
        },
      ];
}

function parseOrganisationMemberRow(
  row: OrganisationMemberRow,
): OrganisationMember {
  const membership = parseActiveOrganisationMembership(row);
  if (membership === null || typeof row.displayName !== "string") {
    throw new Error("organisation member row is corrupt");
  }
  return {
    ...membership,
    displayName: normalizeDisplayName(row.displayName),
  };
}

function requireOrganisationId(raw: unknown): OrganisationId {
  if (typeof raw !== "string") {
    throw new Error("organisation row is corrupt");
  }
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) {
    throw new Error("organisation row is corrupt");
  }
  return parsed.value;
}

function requirePersonId(raw: unknown): PersonId {
  if (typeof raw !== "string") {
    throw new Error("organisation membership row is corrupt");
  }
  const parsed = parsePersonId(raw);
  if (!parsed.ok) {
    throw new Error("organisation membership row is corrupt");
  }
  return parsed.value;
}

function requireUserId(raw: unknown): UserId {
  if (typeof raw !== "string") {
    throw new Error("control identity row is corrupt");
  }

  const parsed = parseUserId(raw);
  if (!parsed.ok) {
    throw new Error("control identity row is corrupt");
  }

  return parsed.value;
}

function parseUserRow(row: UserRow): User {
  const userId = requireUserId(row.userId);
  if (
    typeof row.issuer !== "string" ||
    typeof row.subject !== "string" ||
    typeof row.email !== "string" ||
    typeof row.displayName !== "string" ||
    row.emailVerified !== 1
  ) {
    throw new Error("control identity row is corrupt");
  }

  return {
    userId,
    issuer: row.issuer,
    subject: row.subject,
    email: normalizeEmail(row.email),
    displayName: normalizeDisplayName(row.displayName),
    emailVerified: true,
    createdAt: requireInteger(row.createdAt),
    lastAuthenticatedAt: requireInteger(row.lastAuthenticatedAt),
  };
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || !normalized.includes("@")) {
    throw new Error("verified OIDC email is invalid");
  }
  return normalized;
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (normalized.length === 0 || normalized.length > 160) {
    throw new Error("OIDC display name is invalid");
  }
  return normalized;
}

function normalizeOrganisationName(organisationName: string): string {
  const normalized = organisationName.trim();
  if (normalized.length < 2 || normalized.length > 120) {
    throw new Error("organisation name is invalid");
  }
  return normalized;
}

async function allocateOrganisationHandle(
  db: D1Database,
  organisationName: string,
): Promise<OrganisationHandle> {
  const base = portalHandleBase(organisationName, "organisation");
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const parsed = parseOrganisationHandle(candidate);
    if (!parsed.ok) {
      throw new Error("organisation handle generation failed");
    }
    const existing = await db
      .prepare(
        "SELECT 1 AS present FROM organisation WHERE organisation_handle = ? COLLATE NOCASE",
      )
      .bind(parsed.value)
      .first<{ present: number }>();
    if (existing === null) {
      return parsed.value;
    }
  }
  throw new Error("organisation handle allocation exhausted");
}

function initialOrganisationWorkspace(
  createdAt: number,
): OrganisationWorkspace {
  const workspaceHandle = parseWorkspaceHandle("cafe-operations");
  if (!workspaceHandle.ok) {
    throw new Error("initial workspace handle invariant failed");
  }
  return {
    workspaceId: newWorkspaceId(),
    workspaceHandle: workspaceHandle.value,
    name: "Cafe operations",
    createdAt,
  };
}

function portalHandleBase(name: string, fallback: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "");
  return normalized.length === 0 ? fallback : normalized;
}

function randomOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function requireOrganisationEnvironment(
  value: unknown,
): OrganisationEnvironment {
  if (value !== "development" && value !== "production") {
    throw new Error("organisation environment invariant failed");
  }
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (!isPositiveInteger(value)) {
    throw new Error("positive integer required");
  }
  return value;
}

function requireInteger(value: unknown): number {
  if (!isInteger(value)) {
    throw new Error("integer invariant failed");
  }
  return value;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasExactlyOneChange(result: D1Result<unknown>): boolean {
  return result.meta.changes === 1;
}
