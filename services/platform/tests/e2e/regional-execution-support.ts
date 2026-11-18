import { organisationDatabase as organisationHandle } from "../../src/database-handles";
import {
  startVaultRootRotation,
  runVaultRootRotationStep,
  parseVaultRootRotationId,
  parseVaultRotationBatchLimit,
  vaultRootVersionRemovalStatus,
} from "../../src/credential-vault/root-rotation";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect } from "vitest";
import gateway from "../../src/integration-gateway";
import {
  issueControlSession,
  revokeControlSession,
} from "../../src/data/control-plane";
import { runAgentOperation } from "../../src/data/agent-operation-runner";
import { parseUserId } from "../../src/ids";
import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import {
  registerWhatsAppPhoneNumberAccount,
  selectWhatsAppPhoneNumberAccount,
} from "../../src/data/whatsapp";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppPhoneNumberId,
} from "../../src/whatsapp/identifiers";
import { resolveWhatsAppOrganisationCredential } from "../../src/whatsapp/credential";
import type { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import type { Result } from "../../src/result";

const PHONE = "510000000000055";
const WABA = "410000000000055";
const SECRET = "regional-callback-test-secret";

export async function exerciseRegionalExecution(
  scope: OrganisationExecutionScope,
) {
  await scope.database
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'activation_regional_execution', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), Date.now(), scope.organisationId)
    .run();
  const member = await scope.database
    .prepare(
      "SELECT user_id AS userId, person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND role = 'owner'",
    )
    .bind(scope.organisationId)
    .first<{ userId: string; personId: string }>();
  if (member === null) throw new Error("Regional owner missing");
  const userId = required(parseUserId(member.userId));
  const issued = await issueControlSession({
    db: env.DB,
    userId,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const actor = {
    userId,
    personId: member.personId,
    role: "owner" as const,
    origin: {
      kind: "control_session" as const,
      controlSessionId: issued.session.controlSessionId,
    },
  };
  const command = {
    env,
    scope,
    actor,
    now: Date.now(),
    operationId: "area_regional_accepted",
    operation: {
      kind: "create_area" as const,
      name: "Regional bakery",
      purpose: "Regional execution acceptance",
    },
  };
  expect((await runAgentOperation(command)).ok).toBe(true);
  const raced = await runAgentOperation({
    ...command,
    operationId: "area_regional_raced",
    trailing: [
      scope.database
        .prepare(
          "UPDATE organisation_placement SET status = 'frozen', frozen_at = ? WHERE organisation_id = ?",
        )
        .bind(Date.now(), scope.organisationId),
    ],
  });
  expect(raced).toMatchObject({ ok: false });
  expect(await scope.isActive()).toBe(true);
  await revokeControlSession({
    db: env.DB,
    session: issued.session,
    now: Date.now(),
  });
  expect(
    await runAgentOperation({
      ...command,
      operationId: "area_regional_revoked",
    }),
  ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(
    await scope.database
      .prepare("SELECT area_id FROM operational_area WHERE organisation_id = ?")
      .bind(scope.organisationId)
      .all(),
  ).toMatchObject({ results: [{ area_id: "area_regional_accepted" }] });
  const handle = required(
    parseVaultHandle("vault:whatsapp:regional-execution"),
  );
  required(
    await storeVaultSecret({
      db: scope.database,
      keys: env,
      organisationId: scope.organisationId,
      handle,
      secret: { kind: "bearer", value: "regional-provider-token" },
      now: Date.now(),
    }),
  );
  const connected = await createActiveConnectedIntegration(scope.database, {
    organisationId: scope.organisationId,
    provider: "whatsapp",
    providerSubjectId: WABA,
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: ["whatsapp_business_messaging"],
    createdByUserId: userId,
    providerAccountId: PHONE,
    accountKind: "phone_number",
    displayName: "Regional bakery",
    capabilities: ["whatsapp.support.ingress"],
    audiencePolicy: { kind: "customer", consentRequired: true },
    retentionPolicy: { kind: "organisation_default" },
    now: Date.now(),
  });
  const integrationAccountId = connected.account.integrationAccountId;
  required(
    await registerWhatsAppPhoneNumberAccount({
      db: scope.database,
      organisationId: scope.organisationId,
      integrationAccountId,
      providerConnectionId: connected.connection.providerConnectionId,
      environment: "development",
      businessPortfolioId: required(
        parseMetaBusinessPortfolioId("310000000000055"),
      ),
      wabaId: required(parseWhatsAppBusinessAccountId(WABA)),
      phoneNumberId: required(parseWhatsAppPhoneNumberId(PHONE)),
      displayPhoneNumber: required(parseE164PhoneNumber("+819000000055")),
      verifiedName: "Regional bakery",
      now: Date.now(),
    }),
  );
  required(
    await selectWhatsAppPhoneNumberAccount({
      db: scope.database,
      organisationId: scope.organisationId,
      integrationAccountId,
      now: Date.now(),
    }),
  );
  const credential = await resolveWhatsAppOrganisationCredential({
    env,
    scope,
    integrationAccountId,
    now: Date.now(),
  });
  expect(credential, JSON.stringify(credential)).toMatchObject({
    ok: true,
    value: { accessToken: "regional-provider-token" },
  });
  await regionalCallback(200);
  await regionalQueue(scope, false);
  return integrationAccountId;
}

export async function regionalCallback(status: number): Promise<void> {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: PHONE,
                display_phone_number: "+819000000055",
              },
              statuses: [
                {
                  id: "wamid.regional",
                  status: "delivered",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: "819000000055",
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  let signature = "";
  for (const byte of digest) signature += byte.toString(16).padStart(2, "0");
  const context = createExecutionContext();
  const response = await gateway.fetch(
    new Request("https://satyr.test/hook/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    }),
    { ...env, WHATSAPP_APP_SECRET: SECRET },
    context,
  );
  expect(response.status, await response.clone().text()).toBe(status);
  await waitOnExecutionContext(context);
}

class RegionalQueueMessage implements Message<unknown> {
  readonly id = "regional-queue";
  readonly timestamp = new Date();
  readonly attempts = 1;
  readonly body: unknown;
  retried = false;
  constructor(scope: OrganisationExecutionScope) {
    this.body = {
      type: "agent_schedule.dispatch.v1",
      requestId: "request_regional_queue",
      receivedAt: Date.now(),
      organisationId: scope.organisationId,
      bindingId: "binding_deleted_before_delivery",
      windowKey: "2026-10-05",
    };
  }
  ack(): void {}
  retry(): void {
    this.retried = true;
  }
}

export async function regionalQueue(
  scope: OrganisationExecutionScope,
  retry: boolean,
): Promise<void> {
  const message = new RegionalQueueMessage(scope);
  await gateway.queue(
    {
      queue: "satyr-events",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
      messages: [message],
      ackAll: message.ack.bind(message),
      retryAll: message.retry.bind(message),
    },
    env,
  );
  expect(message.retried).toBe(retry);
}

function required<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export async function exerciseRegionalVaultRotation(): Promise<void> {
  if (!env.ORGANISATION_DB_WNAM || !env.ORGANISATION_DB_APAC)
    throw new Error("Missing regional stores");
  // The two regional cells of the E2E placement profile.
  const databases = [env.ORGANISATION_DB_WNAM, env.ORGANISATION_DB_APAC].map(
    organisationHandle,
  );
  const keys = { ...env, SATYR_VAULT_ACTIVE_KEY_VERSION: "v2" as const };
  const rotationId = required(
    parseVaultRootRotationId(`vrot_${crypto.randomUUID()}`),
  );
  const started = required(
    await startVaultRootRotation({
      db: env.DB,
      databases,
      keys,
      rotationId,
      sourceVersion: "v1",
      now: Date.now(),
    }),
  );
  expect(started.counts.sourceRowCount).toBe(2);
  const limit = required(parseVaultRotationBatchLimit(1));
  const first = required(
    await runVaultRootRotationStep({
      db: env.DB,
      databases,
      keys,
      rotationId,
      limit,
      now: Date.now(),
    }),
  );
  expect(first.kind).toBe("running");
  const final = required(
    await runVaultRootRotationStep({
      db: env.DB,
      databases,
      keys,
      rotationId,
      limit,
      now: Date.now(),
    }),
  );
  expect(final.kind).toBe("completed");
  expect(
    await vaultRootVersionRemovalStatus({ databases, version: "v1" }),
  ).toEqual({ kind: "removable", version: "v1" });
}
