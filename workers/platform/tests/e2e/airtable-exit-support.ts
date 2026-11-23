// The Airtable account and the pending list of the journeys of a held Airtable
// write (Plan 27C, Plan 89).
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { isRecord } from "@purin-labs/std";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  parseVaultHandle,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import { parseUserId } from "@purin-labs/control-api/ids";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import { accessControlPath, enableCapability } from "./access-route-support";
import { commerceHeaders } from "./commerce-support";
import { fixtureDatabase } from "./organisation-database";
import {
  CHANNEL_ID,
  createRequiredGrant,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";

const TOKEN = "airtable-exit-approval-token";
export const BASE_ID = "appExitApproval";
export const SUPPLIER_BASE_ID = "appExitSuppliers";

export async function pending(
  session: IssuedControlSession,
): Promise<readonly Record<string, unknown>[]> {
  const response = await exports.default.fetch(
    `${accessControlPath(ORGANISATION_ID)}/permission-requests`,
    { headers: commerceHeaders(session) },
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.heldOutputs))
    throw new Error("Pending list invalid");
  return body.heldOutputs.filter(isRecord);
}

/**
 * Connects the order base. Each role in `roles` and the Slack channel may read
 * and write it.
 */
export async function connectAirtable(
  owner: IssuedControlSession,
  slackAccountId: string,
  roles: readonly ("operator" | "owner" | "admin")[] = ["operator", "owner"],
): Promise<string> {
  const user = parseUserId(SLACK_ACTOR_USER_ID);
  const handle = parseVaultHandle("vault:airtable:exit-approval");
  if (!user.ok || !handle.ok) throw new Error("Invalid provider identity");
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_airtable_exit', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(now, ORGANISATION_ID),
  ]);
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    handle: handle.value,
    secret: { kind: "bearer", value: TOKEN },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "airtable",
    providerSubjectId: "usrExitApproval",
    environment: "development",
    authMode: "api_key",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: ["data.records:read", "data.records:write"],
    createdByUserId: user.value,
    providerAccountId: "usrExitApproval",
    accountKind: "user_grant",
    displayName: "Order base",
    capabilities: [
      CAPABILITY_KEYS.airtableApiRead,
      CAPABILITY_KEYS.airtableApiWrite,
    ],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const accountId = connected.account.integrationAccountId;
  // A channel turn acts for the channel and for the person, so each holds them.
  const subjects = [
    ...roles.map((role) => ({ kind: "organisation_role", role }) as const),
    {
      kind: "conversation",
      integrationAccountId: slackAccountId,
      conversationId: CHANNEL_ID,
    } as const,
  ];
  for (const capabilityId of [
    CAPABILITY_KEYS.airtableApiRead,
    CAPABILITY_KEYS.airtableApiWrite,
  ]) {
    await enableCapability(ORGANISATION_ID, owner, capabilityId);
    for (const baseId of [BASE_ID, SUPPLIER_BASE_ID])
      for (const [index, subject] of subjects.entries())
        await createRequiredGrant({
          grantId: `grant_airtable_exit_${capabilityId}_${baseId}_${index}`,
          subject,
          target: {
            kind: "provider_resource",
            capabilityId,
            capabilityVersion: 1,
            integrationAccountId: accountId,
            resourceScope: `base:${baseId}`,
          },
          now,
        });
  }
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisation,
    organisationId: ORGANISATION_ID,
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
  return accountId;
}

/** A Portal request of this member, as one Case command. */
export function command(
  session: IssuedControlSession,
  key: string,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/cases/commands`,
    {
      method: "POST",
      headers: {
        origin: "https://localhost",
        "content-type": "application/json",
        "idempotency-key": key,
        cookie: `pantry_session=${session.token}; pantry_csrf=${session.csrfToken}`,
        "x-pantry-csrf": session.csrfToken,
      },
      body: JSON.stringify({ instruction: "Add order 481 to the order base." }),
    },
  );
}
