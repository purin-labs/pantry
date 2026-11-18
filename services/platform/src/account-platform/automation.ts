import {
  authorizeOrganisationControl,
  resolveControlSessionById,
  type ActiveControlSession,
} from "../data/control-plane";
import type { Env } from "../env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import { createAccountPlatformClient } from "./client";
import { resolvePantryAccountBinding } from "./binding";
import {
  resolveLinkedPantryAccountAutomation,
  resolveLinkedPantryAccountUser,
  type PantryNativeAutomation,
} from "./identity";
import {
  accountObject,
  accountText,
  sameAccountScope,
  type AccountPlatformError,
  type LinkedPantryAccountAutomation,
} from "./types";

/** This command grants one existing native revision through a real admin control session. */
export async function ensurePantryAccountAutomationGrant(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    session: ActiveControlSession;
    native: PantryNativeAutomation;
  }>,
): Promise<Result<LinkedPantryAccountAutomation, AccountPlatformError>> {
  const session = await resolveControlSessionById({
    db: input.env.DB,
    controlSessionId: input.session.controlSessionId,
    now: Date.now(),
  });
  if (!session.ok || session.value.userId !== input.session.userId)
    return denied();
  const actor = await authorizeOrganisationControl({
    db: input.scope.database,
    accountAccess: input.scope.accountAccess,
    action: "execute",
    session: session.value,
    organisationId: input.scope.organisationId,
    requiredRole: "admin",
  });
  if (!actor.ok || !(await input.scope.isActive())) return denied();
  if (!(await nativeAutomationExists(input.scope, input.native)))
    return denied();
  const client = createAccountPlatformClient(input.env);
  if (!client.ok) return client;
  const binding = await resolvePantryAccountBinding(
    input.env,
    input.scope.organisationId,
  );
  if (!binding.ok) return binding;
  const retained = await input.env.DB.prepare(
    "SELECT state FROM account_automation_link WHERE native_organisation_id = ? AND native_kind = ? AND native_id = ? AND native_revision = ?",
  )
    .bind(
      input.scope.organisationId,
      input.native.kind,
      input.native.nativeId,
      input.native.revision,
    )
    .first<{ state: unknown }>();
  if (retained !== null) {
    if (retained.state !== "active") return denied();
    const automation = await resolveLinkedPantryAccountAutomation(
      input.env,
      input.scope.organisationId,
      input.native,
    );
    if (!automation.ok) return automation;
    const checked = await client.value.checkAutomation({
      binding: binding.value,
      automation: automation.value,
      action: "execute",
    });
    if (!checked.ok) return checked;
    return checked.value.accessRevision === automation.value.accessRevision
      ? automation
      : denied();
  }
  const user = await resolveLinkedPantryAccountUser(
    input.env,
    session.value.userId,
  );
  if (!user.ok) return user;
  const nativePrincipalId = JSON.stringify([
    input.native.kind,
    input.native.nativeId,
    input.native.revision,
  ]);
  const automationId = JSON.stringify([
    "satyr",
    binding.value.instanceId,
    input.native.kind,
    input.native.nativeId,
  ]);
  const grantId = JSON.stringify([
    "satyr",
    binding.value.instanceId,
    input.native.kind,
    input.native.nativeId,
    input.native.revision,
  ]);
  const receipt = await client.value.setAutomationGrant({
    binding: binding.value,
    user: user.value,
    authority: {
      kind: "authenticated_session",
      nativeSessionId: session.value.controlSessionId,
    },
    automationId,
    grantId,
    nativePrincipalId,
    access: "allowed",
    expectedAccessRevision: 0,
  });
  if (!receipt.ok) return receipt;
  if (
    receipt.value.instanceId !== binding.value.instanceId ||
    !sameAccountScope(receipt.value.scope, binding.value.scope) ||
    receipt.value.automationId !== automationId ||
    receipt.value.grantId !== grantId ||
    receipt.value.nativePrincipalId !== nativePrincipalId ||
    receipt.value.access !== "allowed"
  )
    return denied();
  if (
    !(await nativeAutomationExists(input.scope, input.native)) ||
    !(await input.scope.isActive())
  )
    return denied();
  try {
    await input.env.DB.prepare(
      `INSERT INTO account_automation_link (native_organisation_id, native_kind, native_id, native_revision, native_principal_id, automation_id, grant_id, authority_revision, expected_access_revision, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?) ON CONFLICT (native_organisation_id, native_kind, native_id, native_revision) DO UPDATE SET authority_revision = excluded.authority_revision WHERE account_automation_link.expected_access_revision = excluded.expected_access_revision AND account_automation_link.native_principal_id = excluded.native_principal_id AND account_automation_link.automation_id = excluded.automation_id AND account_automation_link.grant_id = excluded.grant_id AND account_automation_link.state = 'active'`,
    )
      .bind(
        input.scope.organisationId,
        input.native.kind,
        input.native.nativeId,
        input.native.revision,
        nativePrincipalId,
        automationId,
        grantId,
        receipt.value.authorityRevision,
        receipt.value.accessRevision,
        Date.now(),
      )
      .run();
    const raw = await input.env.DB.prepare(
      `SELECT native_principal_id AS nativePrincipalId, automation_id AS automationId, grant_id AS grantId, expected_access_revision AS accessRevision, state FROM account_automation_link WHERE native_organisation_id = ? AND native_kind = ? AND native_id = ? AND native_revision = ?`,
    )
      .bind(
        input.scope.organisationId,
        input.native.kind,
        input.native.nativeId,
        input.native.revision,
      )
      .first<unknown>();
    const row = accountObject(raw, [
      "nativePrincipalId",
      "automationId",
      "grantId",
      "accessRevision",
      "state",
    ]);
    if (
      row.state !== "active" ||
      row.nativePrincipalId !== nativePrincipalId ||
      row.automationId !== automationId ||
      row.grantId !== grantId ||
      row.accessRevision !== receipt.value.accessRevision
    )
      return denied();
    return {
      ok: true,
      value: {
        nativePrincipalId: accountText(row.nativePrincipalId),
        automationId: accountText(row.automationId),
        grantId: accountText(row.grantId),
        authorityRevision: receipt.value.authorityRevision,
        accessRevision: receipt.value.accessRevision,
      },
    };
  } catch {
    return { ok: false, error: { code: "authority_unavailable" } };
  }
}

async function nativeAutomationExists(
  scope: OrganisationExecutionScope,
  native: PantryNativeAutomation,
): Promise<boolean> {
  let sql: string;
  switch (native.kind) {
    case "workflow":
      sql = `SELECT 1 AS present FROM cue_subscription WHERE organisation_id = ? AND subscription_id = ? AND version = ? AND enabled = 1 UNION ALL SELECT 1 AS present FROM schedule_binding WHERE organisation_id = ? AND binding_id = ? AND revision = ? AND enabled = 1 LIMIT 1`;
      break;
    case "agent_mailbox":
      sql = `SELECT 1 AS present FROM agent_mailbox_binding b JOIN integration_account a ON a.organisation_id = b.organisation_id AND a.integration_account_id = b.integration_account_id WHERE b.organisation_id = ? AND b.mailbox_binding_id = ? AND b.current_revision = ? AND a.lifecycle = 'active' LIMIT 1`;
      break;
    case "whatsapp_support":
      sql = `SELECT 1 AS present FROM whatsapp_support_binding b JOIN integration_account a ON a.organisation_id = b.organisation_id AND a.integration_account_id = b.integration_account_id WHERE b.organisation_id = ? AND b.support_binding_id = ? AND b.current_revision = ? AND a.lifecycle = 'active' LIMIT 1`;
      break;
  }
  const parameters =
    native.kind === "workflow"
      ? [
          scope.organisationId,
          native.nativeId,
          native.revision,
          scope.organisationId,
          native.nativeId,
          native.revision,
        ]
      : [scope.organisationId, native.nativeId, native.revision];
  try {
    return (
      (await scope.database
        .prepare(sql)
        .bind(...parameters)
        .first()) !== null
    );
  } catch {
    return false;
  }
}
function denied<T>(): Result<T, AccountPlatformError> {
  return { ok: false, error: { code: "scope_forbidden" } };
}
