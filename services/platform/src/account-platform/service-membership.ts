import {
  parseAssignableControlRole,
  readActiveOrganisationMembership,
  type ActiveControlSession,
  type ActiveOrganisationMembership,
} from "../data/control-plane";
import { newPersonId, type OrganisationId, type UserId } from "../ids";
import type { Result } from "../result";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { prepareBaseProjectMembership } from "../projects/default-project";
import {
  createAccountPlatformClient,
  type AccountMembershipActor,
  type AccountPlatformClient,
} from "./client";
import type { AccountPlatformBindings } from "./config";
import { resolvePantryAccountBinding } from "./binding";
import { resolveLinkedPantryAccountUser } from "./identity";
import type { OrganizationMembership as AccountMembership } from "@seams-internal/console-shared/accountPlatform";
import type { AccountPlatformError, PantryAccountBinding } from "./types";
import type { Variant } from "@purin-labs/type-utils";

type AccountMembershipContext = Readonly<{
  client: AccountPlatformClient;
  actor: AccountMembershipActor;
  nativeUserId: UserId;
}>;

export async function resolveAccountMembershipContext(
  env: AccountPlatformBindings,
  organisationId: OrganisationId,
  session: ActiveControlSession,
): Promise<Result<AccountMembershipContext, AccountPlatformError>> {
  const client = createAccountPlatformClient(env);
  if (!client.ok) return client;
  const [binding, user] = await Promise.all([
    resolvePantryAccountBinding(env, organisationId),
    resolveLinkedPantryAccountUser(env, session.userId),
  ]);
  if (!binding.ok) return binding;
  if (!user.ok) return user;
  return {
    ok: true,
    value: {
      client: client.value,
      nativeUserId: session.userId,
      actor: {
        binding: binding.value,
        user: user.value,
        authority: {
          kind: "authenticated_session",
          nativeSessionId: session.controlSessionId,
        },
      },
    },
  };
}

/** Only an actual shared token acceptance can create this receipt. */
export class AccountServiceGrantAcceptance {
  readonly #acceptedSharedInvitation = true;

  private constructor(
    readonly binding: PantryAccountBinding,
    readonly nativeUserId: UserId,
    readonly invitationId: string,
    readonly membership: Variant<AccountMembership, "active">,
    readonly receiptId: string,
  ) {
    Object.freeze(this.membership);
    Object.freeze(this);
  }

  static async accept(
    context: AccountMembershipContext,
    invitationId: string,
    token: string,
  ): Promise<Result<AccountServiceGrantAcceptance, AccountPlatformError>> {
    const accepted = await context.client.acceptInvitation({
      binding: context.actor.binding,
      user: context.actor.user,
      authority: context.actor.authority,
      invitationId,
      token,
    });
    if (!accepted.ok) return accepted;
    if (
      accepted.value.orgId !== context.actor.binding.scope.organizationId ||
      accepted.value.userId !== context.actor.user.platformUserId
    )
      return { ok: false, error: { code: "scope_forbidden" } };
    return {
      ok: true,
      value: new AccountServiceGrantAcceptance(
        context.actor.binding,
        context.nativeUserId,
        invitationId,
        accepted.value,
        invitationId,
      ),
    };
  }

  static is(value: unknown): value is AccountServiceGrantAcceptance {
    return (
      typeof value === "object" &&
      value !== null &&
      #acceptedSharedInvitation in value
    );
  }
}

export async function applyAccountServiceGrantAcceptance(
  input: Readonly<{
    execution: OrganisationExecutionScope;
    receipt: AccountServiceGrantAcceptance;
    displayName: string;
    now: number;
  }>,
): Promise<Result<ActiveOrganisationMembership, AccountPlatformError>> {
  const { execution, receipt } = input;
  if (
    !AccountServiceGrantAcceptance.is(receipt) ||
    receipt.binding.nativeOrganisationId !== execution.organisationId
  )
    return { ok: false, error: { code: "scope_forbidden" } };
  const invitation = await execution.database
    .prepare(
      `SELECT i.role, i.accepted_native_user_id AS acceptedUserId FROM account_service_invitation_role i
       JOIN organisation_onboarding o ON o.organisation_id = i.native_organisation_id
       WHERE i.native_organisation_id = ? AND i.platform_invitation_id = ?
         AND o.lifecycle NOT IN ('activating', 'archived')`,
    )
    .bind(execution.organisationId, receipt.invitationId)
    .first<{ role: unknown; acceptedUserId: unknown }>();
  const role = parseAssignableControlRole(invitation?.role);
  if (
    !role.ok ||
    (invitation?.acceptedUserId !== null &&
      invitation?.acceptedUserId !== receipt.nativeUserId)
  )
    return { ok: false, error: { code: "scope_forbidden" } };
  if (invitation.acceptedUserId !== null) {
    const existing = await execution.database
      .prepare(
        `SELECT platform_membership_id AS membershipId FROM service_role_grant
       WHERE organisation_id = ? AND user_id = ? AND status = 'active'`,
      )
      .bind(execution.organisationId, receipt.nativeUserId)
      .first<{ membershipId: unknown }>();
    if (existing?.membershipId !== receipt.membership.id)
      return { ok: false, error: { code: "membership_ineligible" } };
    const granted = await readActiveOrganisationMembership(
      execution.database,
      execution.organisationId,
      receipt.nativeUserId,
    );
    return granted === null
      ? { ok: false, error: { code: "membership_ineligible" } }
      : { ok: true, value: granted };
  }
  const personId = newPersonId();
  await execution.database.batch([
    execution.prepareMutationFence(),
    execution.database
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
       SELECT ?, ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM service_role_grant WHERE organisation_id = ? AND user_id = ?)
       AND EXISTS (SELECT 1 FROM account_service_invitation_role i
         JOIN organisation_onboarding o ON o.organisation_id = i.native_organisation_id
         WHERE i.native_organisation_id = ? AND i.platform_invitation_id = ? AND i.accepted_at IS NULL
           AND o.lifecycle NOT IN ('activating', 'archived'))`,
      )
      .bind(
        execution.organisationId,
        personId,
        input.displayName,
        execution.organisationId,
        receipt.nativeUserId,
        execution.organisationId,
        receipt.invitationId,
      ),
    execution.database
      .prepare(
        `INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at,
        revoked_at, platform_membership_id, account_acceptance_receipt_id)
       SELECT ?, ?, ?, ?, 'active', ?, NULL, ?, ?
       WHERE EXISTS (SELECT 1 FROM account_service_invitation_role i
         JOIN organisation_onboarding o ON o.organisation_id = i.native_organisation_id
         WHERE i.native_organisation_id = ? AND i.platform_invitation_id = ? AND i.accepted_at IS NULL
           AND o.lifecycle NOT IN ('activating', 'archived'))
       ON CONFLICT (organisation_id, user_id) DO UPDATE SET
         role = CASE WHEN service_role_grant.status = 'active' AND service_role_grant.role = 'owner'
           THEN 'owner' ELSE excluded.role END,
         status = 'active', revoked_at = NULL, platform_membership_id = excluded.platform_membership_id,
         account_acceptance_receipt_id = excluded.account_acceptance_receipt_id`,
      )
      .bind(
        execution.organisationId,
        receipt.nativeUserId,
        personId,
        role.value,
        input.now,
        receipt.membership.id,
        receipt.receiptId,
        execution.organisationId,
        receipt.invitationId,
      ),
    ...prepareBaseProjectMembership(execution.database, {
      organisationId: execution.organisationId,
      userId: receipt.nativeUserId,
      role: role.value,
      now: input.now,
    }),
    execution.database
      .prepare(
        `UPDATE account_service_invitation_role SET accepted_at = ?, accepted_native_user_id = ?
       WHERE native_organisation_id = ? AND platform_invitation_id = ? AND accepted_at IS NULL
         AND EXISTS (SELECT 1 FROM service_role_grant g
           JOIN organisation_onboarding o ON o.organisation_id = g.organisation_id
           WHERE g.organisation_id = account_service_invitation_role.native_organisation_id
             AND g.user_id = ? AND g.status = 'active' AND g.platform_membership_id = ?
             AND g.account_acceptance_receipt_id = ?
             AND o.lifecycle NOT IN ('activating', 'archived'))`,
      )
      .bind(
        input.now,
        receipt.nativeUserId,
        execution.organisationId,
        receipt.invitationId,
        receipt.nativeUserId,
        receipt.membership.id,
        receipt.receiptId,
      ),
  ]);
  const applied = await execution.database
    .prepare(
      `SELECT 1 AS found FROM service_role_grant g
     WHERE g.organisation_id = ? AND g.user_id = ? AND g.status = 'active'
       AND g.platform_membership_id = ? AND g.account_acceptance_receipt_id = ?`,
    )
    .bind(
      execution.organisationId,
      receipt.nativeUserId,
      receipt.membership.id,
      receipt.receiptId,
    )
    .first<{ found: unknown }>();
  if (applied?.found !== 1)
    return { ok: false, error: { code: "membership_ineligible" } };
  const granted = await readActiveOrganisationMembership(
    execution.database,
    execution.organisationId,
    receipt.nativeUserId,
  );
  return granted === null
    ? { ok: false, error: { code: "scope_forbidden" } }
    : { ok: true, value: granted };
}
