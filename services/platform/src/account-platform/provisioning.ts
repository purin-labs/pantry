import type { GlobalDatabase } from "../database-handles";
import { canonicalJson, sha256Hex } from "@purin-labs/std";
import {
  bootstrapOrganisation,
  resolveUser,
  upsertUser,
  type User,
} from "../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
} from "../data/control-mutation";
import { parseOrganisationId, parseUserId } from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { parseOrganisationPlacementCells } from "../placement";
import type { Env } from "../env";
import {
  accountInteger,
  accountObject,
  accountText,
  parseAccountScope,
  sameAccountScope,
} from "./types";
import {
  readPantryProvisionApplied,
  type PantryNativeScope,
  type PantryProvisionApplied,
  type PantryProvisionEnvelope,
  type PantryProvisionOwner,
  type PantryProvisionOwnerMapping,
  type PantryServiceTenantBinding,
} from "./provisioning-boundary";
import type { Variant } from "@purin-labs/type-utils";

type PantryProvisionResult =
  | Readonly<{ kind: "accepted"; value: PantryProvisionApplied }>
  | Readonly<{
      kind: "rejected";
      error: Readonly<{
        code:
          | "scope_forbidden"
          | "operation_conflict"
          | "unavailable"
          | "provisioning_failed";
      }>;
    }>;

/** This evidence binds attachment to the existing native owner and tenant identity. */
async function pantryOrganisationAttachmentEvidence(
  nativeScope: PantryNativeScope,
  owner: Readonly<{ issuer: string; subject: string }>,
): Promise<Readonly<{ sourceRecordId: string; sourceDigest: string }>> {
  return {
    sourceRecordId: `satyr-organisation:${nativeScope.nativeOrganizationId}`,
    sourceDigest: await sha256Hex(
      canonicalJson({
        serviceId: "satyr",
        deploymentId: nativeScope.deploymentId,
        nativeOrganizationId: nativeScope.nativeOrganizationId,
        owner: { issuer: owner.issuer, subject: owner.subject },
      }),
    ),
  };
}

export async function provisionPantryAccount(
  env: Env,
  envelope: PantryProvisionEnvelope,
): Promise<PantryProvisionResult> {
  const { delivery, owner } = envelope;
  const command = delivery.command;
  if (
    delivery.authority.deploymentId !== env.ACCOUNT_PLATFORM_DEPLOYMENT_ID ||
    owner.platformUserId !== delivery.requestedByUserId
  )
    return rejected("scope_forbidden");
  const commandDigest = await sha256Hex(canonicalJson(command));
  const replay = await readProvisionReplay(
    env.DB,
    command.operationId,
    delivery.payloadDigest,
    commandDigest,
    delivery.requestedByUserId,
  );
  if (replay !== null) return replay;
  const retained = await readRetainedBinding(env.DB, command.instanceId);
  if (
    retained !== null &&
    (!sameAccountScope(retained.binding.scope, delivery.scope) ||
      retained.binding.nativeScope.deploymentId !==
        delivery.authority.deploymentId)
  )
    return rejected("scope_forbidden");
  if (
    retained !== null &&
    (retained.desiredRevision >= command.desiredRevision ||
      retained.accountState === "archived")
  )
    return rejected("operation_conflict");
  const native = await resolveProvisionNativeTenant(
    env,
    envelope,
    retained?.binding ?? null,
  );
  if (native.kind === "rejected") return native;
  const { binding, user } = native.value;
  if (
    retained === null &&
    !(await mapInitialNativeOwnerGrant(env, binding, user, owner))
  )
    return rejected("scope_forbidden");
  if (!(await persistProvisionIdentity(env.DB, user, owner)))
    return rejected("operation_conflict");
  const mapping: PantryProvisionOwnerMapping = {
    nativePrincipalId: user.userId,
    platformUserId: owner.platformUserId,
    issuer: owner.issuer,
    subject: owner.subject,
    verificationReceiptId: owner.verificationReceiptId,
  };
  const applied: PantryProvisionApplied = {
    kind: "applied",
    receipt: {
      version: 1,
      operationId: command.operationId,
      instanceId: command.instanceId,
      desiredRevision: command.desiredRevision,
      result: commandState(command.command),
      binding,
    },
    owner: mapping,
  };
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO account_service_binding (instance_id, native_organisation_id, deployment_id, scope_json, account_state, desired_revision, operation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (instance_id) DO NOTHING`,
      ).bind(
        command.instanceId,
        binding.nativeScope.nativeOrganizationId,
        binding.nativeScope.deploymentId,
        canonicalJson(binding.scope),
        applied.receipt.result,
        command.desiredRevision,
        command.operationId,
        now,
      ),
      env.DB.prepare(
        `UPDATE account_service_binding SET account_state = ?, desired_revision = ?, operation_id = ? WHERE instance_id = ? AND native_organisation_id = ? AND deployment_id = ? AND scope_json = ? AND desired_revision < ? AND account_state <> 'archived'`,
      ).bind(
        applied.receipt.result,
        command.desiredRevision,
        command.operationId,
        command.instanceId,
        binding.nativeScope.nativeOrganizationId,
        binding.nativeScope.deploymentId,
        canonicalJson(binding.scope),
        command.desiredRevision,
      ),
      env.DB.prepare(
        `INSERT INTO account_provision_receipt (operation_id, instance_id, desired_revision, payload_digest, command_digest, requested_by_user_id, receipt_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM account_service_binding b JOIN account_identity_link i ON i.native_user_id = ? WHERE b.instance_id = ? AND b.native_organisation_id = ? AND b.desired_revision = ? AND b.operation_id = ? AND i.platform_user_id = ? AND i.provider_issuer = ? AND i.provider_subject = ? ON CONFLICT DO NOTHING`,
      ).bind(
        command.operationId,
        command.instanceId,
        command.desiredRevision,
        delivery.payloadDigest,
        commandDigest,
        delivery.requestedByUserId,
        JSON.stringify(applied),
        now,
        user.userId,
        command.instanceId,
        binding.nativeScope.nativeOrganizationId,
        command.desiredRevision,
        command.operationId,
        owner.platformUserId,
        owner.issuer,
        owner.subject,
      ),
    ]);
  } catch (error) {
    return rejected(
      /constraint|account_service_binding_conflict|UNIQUE/i.test(String(error))
        ? "operation_conflict"
        : "unavailable",
    );
  }
  const saved = await readProvisionReplay(
    env.DB,
    command.operationId,
    delivery.payloadDigest,
    commandDigest,
    delivery.requestedByUserId,
  );
  return saved ?? rejected("operation_conflict");
}

type NativeTenantResult =
  | Readonly<{
      kind: "accepted";
      value: Readonly<{ binding: PantryServiceTenantBinding; user: User }>;
    }>
  | Variant<PantryProvisionResult, "rejected">;
async function resolveProvisionNativeTenant(
  env: Env,
  envelope: PantryProvisionEnvelope,
  retained: PantryServiceTenantBinding | null,
): Promise<NativeTenantResult> {
  const { delivery, owner } = envelope;
  const command = delivery.command;
  if (retained !== null) {
    if (command.binding.kind !== undefined) {
      if (
        command.binding.kind === "attach_existing_scope" &&
        canonicalJson(command.binding.nativeScope) !==
          canonicalJson(retained.nativeScope)
      )
        return rejected("scope_forbidden");
      if (
        command.binding.kind === "create_native_scope" &&
        !sameAccountScope(command.binding.parent, retained.scope)
      )
        return rejected("scope_forbidden");
    } else if (canonicalJson(command.binding) !== canonicalJson(retained))
      return rejected("scope_forbidden");
    const existingUser = await findVerifiedNativeUser(env.DB, owner);
    if (existingUser !== null)
      return {
        kind: "accepted",
        value: { binding: retained, user: existingUser },
      };
    if (owner.email === null || !owner.emailVerified)
      return rejected("scope_forbidden");
    const user = await upsertUser({
      db: env.DB,
      identity: {
        issuer: owner.issuer,
        subject: owner.subject,
        email: owner.email,
        displayName: owner.displayName ?? owner.email,
        emailVerified: true,
      },
      now: Date.now(),
    });
    return { kind: "accepted", value: { binding: retained, user } };
  }
  if (owner.serviceGrant.kind !== "instance_access")
    return rejected("scope_forbidden");
  switch (command.binding.kind) {
    case "create_native_scope": {
      const request = command.binding;
      if (
        !sameAccountScope(request.parent, delivery.scope) ||
        request.configuration.deploymentId !==
          delivery.authority.deploymentId ||
        owner.email === null ||
        !owner.emailVerified
      )
        return rejected("scope_forbidden");
      const cells = parseOrganisationPlacementCells(
        env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
      );
      if (!cells.ok) return rejected("unavailable");
      let placement = null;
      for (const cell of cells.value)
        if (
          cell.placement.placementCellId ===
          request.configuration.placementCellId
        )
          placement = cell.placement;
      if (placement === null) return rejected("scope_forbidden");
      const now = Date.now();
      const user = await upsertUser({
        db: env.DB,
        identity: {
          issuer: owner.issuer,
          subject: owner.subject,
          email: owner.email,
          displayName: owner.displayName ?? owner.email,
          emailVerified: true,
        },
        now,
      });
      const requestHash = await sha256Hex(
        canonicalJson({
          scope: delivery.scope,
          configuration: request.configuration,
          owner: { issuer: owner.issuer, subject: owner.subject },
        }),
      );
      const bootstrap = await bootstrapOrganisation({
        env,
        owner: user,
        organisationName: "Seams Pantry workspace",
        environment: request.configuration.environment,
        placement,
        mutation: {
          boundary: {
            kind: "unversioned",
            idempotencyKey: `account_service:${command.instanceId}`,
            requestHash,
          },
          scope: {
            userId: user.userId,
            organisationScope: "organisation:create",
            route: "/account-platform/v1/provision",
            operation: "account.service.create",
          },
          identity: newControlMutationIdentity({
            portalSubjectHash: await hashPortalSubject(
              owner.issuer,
              owner.subject,
            ),
            causationId: command.operationId,
            now,
          }),
        },
        now,
      });
      if (!bootstrap.ok)
        return rejected(
          bootstrap.error.code === "idempotency_key_conflict"
            ? "operation_conflict"
            : "unavailable",
        );
      return {
        kind: "accepted",
        value: {
          binding: {
            instanceId: command.instanceId,
            scope: delivery.scope,
            nativeScope: {
              serviceId: "satyr",
              deploymentId: delivery.authority.deploymentId,
              nativeOrganizationId: bootstrap.value.organisationId,
            },
          },
          user,
        },
      };
    }
    case "attach_existing_scope": {
      const request = command.binding;
      if (request.nativeScope.deploymentId !== delivery.authority.deploymentId)
        return rejected("scope_forbidden");
      const organisationId = parseOrganisationId(
        request.nativeScope.nativeOrganizationId,
      );
      if (!organisationId.ok) return rejected("scope_forbidden");
      const user = await findVerifiedNativeUser(env.DB, owner);
      if (user === null) return rejected("scope_forbidden");
      const scope = await OrganisationExecutionScope.resolve(
        env,
        organisationId.value,
      );
      if (!scope.ok) return rejected("unavailable");
      const membership = await scope.value.database
        .prepare(
          `SELECT person_id FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND role = 'owner' AND status = 'active'`,
        )
        .bind(organisationId.value, user.userId)
        .first();
      if (membership === null) return rejected("scope_forbidden");
      const proof = await pantryOrganisationAttachmentEvidence(
        request.nativeScope,
        owner,
      );
      if (
        proof.sourceRecordId !== request.authorityEvidence.sourceRecordId ||
        proof.sourceDigest !== request.authorityEvidence.sourceDigest
      )
        return rejected("scope_forbidden");
      return {
        kind: "accepted",
        value: {
          binding: {
            instanceId: command.instanceId,
            scope: delivery.scope,
            nativeScope: request.nativeScope,
          },
          user,
        },
      };
    }
    case undefined:
      return rejected("scope_forbidden");
  }
}

async function mapInitialNativeOwnerGrant(
  env: Env,
  binding: PantryServiceTenantBinding,
  user: User,
  owner: PantryProvisionOwner,
): Promise<boolean> {
  if (owner.serviceGrant.kind !== "instance_access") return false;
  const organisationId = parseOrganisationId(
    binding.nativeScope.nativeOrganizationId,
  );
  if (!organisationId.ok) return false;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!scope.ok) return false;
  const result = await scope.value.database
    .prepare(
      `UPDATE service_role_grant SET platform_membership_id = ?, account_access_revision = ?, account_acceptance_receipt_id = ? WHERE organisation_id = ? AND user_id = ? AND role = 'owner' AND status = 'active' AND (platform_membership_id IS NULL OR platform_membership_id = ?)`,
    )
    .bind(
      owner.platformMembershipId,
      owner.serviceGrant.accessRevision,
      owner.accountAcceptanceReceiptId,
      organisationId.value,
      user.userId,
      owner.platformMembershipId,
    )
    .run();
  return result.meta.changes === 1;
}

async function persistProvisionIdentity(
  database: GlobalDatabase,
  user: User,
  owner: PantryProvisionOwner,
): Promise<boolean> {
  await database
    .prepare(
      `INSERT INTO account_identity_link (native_user_id, platform_user_id, provider_issuer, provider_subject, verification_receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (native_user_id) DO NOTHING`,
    )
    .bind(
      user.userId,
      owner.platformUserId,
      owner.issuer,
      owner.subject,
      owner.verificationReceiptId,
      Date.now(),
    )
    .run();
  const raw = await database
    .prepare(
      `SELECT platform_user_id AS platformUserId, provider_issuer AS issuer, provider_subject AS subject FROM account_identity_link WHERE native_user_id = ?`,
    )
    .bind(user.userId)
    .first<unknown>();
  if (raw === null) return false;
  const row = accountObject(raw, ["platformUserId", "issuer", "subject"]);
  return (
    row.platformUserId === owner.platformUserId &&
    row.issuer === owner.issuer &&
    row.subject === owner.subject
  );
}

async function findVerifiedNativeUser(
  database: GlobalDatabase,
  owner: PantryProvisionOwner,
): Promise<User | null> {
  const row = await database
    .prepare(
      `SELECT user_id AS userId FROM app_user WHERE issuer = ? AND subject = ? AND email_verified = 1`,
    )
    .bind(owner.issuer, owner.subject)
    .first<unknown>();
  if (row === null) return null;
  const r = accountObject(row, ["userId"]);
  const userId = parseUserId(accountText(r.userId));
  return userId.ok ? resolveUser({ db: database, userId: userId.value }) : null;
}

async function readProvisionReplay(
  database: GlobalDatabase,
  operationId: string,
  digest: string,
  commandDigest: string,
  requestedByUserId: string,
): Promise<PantryProvisionResult | null> {
  const row = await database
    .prepare(
      `SELECT payload_digest AS payloadDigest, command_digest AS commandDigest, requested_by_user_id AS requestedByUserId, receipt_json AS receiptJson FROM account_provision_receipt WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<unknown>();
  if (row === null) return null;
  const r = accountObject(row, [
    "payloadDigest",
    "commandDigest",
    "requestedByUserId",
    "receiptJson",
  ]);
  if (
    r.payloadDigest !== digest ||
    r.commandDigest !== commandDigest ||
    r.requestedByUserId !== requestedByUserId
  )
    return rejected("operation_conflict");
  return {
    kind: "accepted",
    value: readPantryProvisionApplied(JSON.parse(accountText(r.receiptJson))),
  };
}
export async function readRetainedBinding(
  database: GlobalDatabase,
  instanceId: string,
): Promise<Readonly<{
  binding: PantryServiceTenantBinding;
  desiredRevision: number;
  accountState: "active" | "disabled" | "archived";
  operationId: string;
}> | null> {
  const row = await database
    .prepare(
      `SELECT native_organisation_id AS nativeOrganisationId, deployment_id AS deploymentId, scope_json AS scopeJson, account_state AS accountState, desired_revision AS desiredRevision, operation_id AS operationId FROM account_service_binding WHERE instance_id = ?`,
    )
    .bind(instanceId)
    .first<unknown>();
  if (row === null) return null;
  const r = accountObject(row, [
    "nativeOrganisationId",
    "deploymentId",
    "scopeJson",
    "accountState",
    "desiredRevision",
    "operationId",
  ]);
  if (
    r.accountState !== "active" &&
    r.accountState !== "disabled" &&
    r.accountState !== "archived"
  )
    throw new Error("Invalid retained account state");
  return {
    binding: {
      instanceId,
      scope: parseAccountScope(JSON.parse(accountText(r.scopeJson))),
      nativeScope: {
        serviceId: "satyr",
        deploymentId: accountText(r.deploymentId),
        nativeOrganizationId: accountText(r.nativeOrganisationId),
      },
    },
    desiredRevision: accountInteger(r.desiredRevision, 1),
    accountState: r.accountState,
    operationId: accountText(r.operationId),
  };
}
function commandState(
  command: "enable" | "disable" | "archive",
): "active" | "disabled" | "archived" {
  switch (command) {
    case "enable":
      return "active";
    case "disable":
      return "disabled";
    case "archive":
      return "archived";
  }
}
function rejected(
  code: Variant<PantryProvisionResult, "rejected">["error"]["code"],
): Variant<PantryProvisionResult, "rejected"> {
  return { kind: "rejected", error: { code } };
}
