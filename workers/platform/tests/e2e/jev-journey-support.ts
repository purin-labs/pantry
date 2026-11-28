// The fixtures that the Jev journeys share: plan-88-jev-features.test.ts and
// plan-95-stripe-billing.test.ts. The fake TypeSafe only records the key and
// the purpose of each request and answers; the fake Gmail answers a message.
// Product code chooses the key, writes the records and refuses the requests
// that the journeys assert.
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";
import {
  parseJevFeaturesView,
  type JevFeaturesView,
} from "@purin-labs/control-api/portal/jev-features";
import { encodeBase64Url, isRecord } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { typeSafeMonth } from "@purin-labs/agent/typesafe/usage-store";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import {
  bootstrapOrganisation,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { newControlMutationIdentity } from "@purin-labs/tenancy/data/control-mutation";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import { storeVaultSecret } from "@purin-labs/authority/credential-vault/index";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { GMAIL_FULL_MAILBOX_SCOPES } from "@purin-labs/connections/mail/gmail-authorization";
import { parseInitialOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { defaultDenyPolicy } from "@purin-labs/authority/policy-snapshot";
import { requireVaultHandle } from "../test-ids";
import { commerceClient } from "./commerce-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { controlFetch } from "./chat-journey-support";

export const PANTRY_KEY = "typesafe-pantry-e2e-key-0000000000";
const RULE = {
  kind: "categorize",
  ruleId: "rule_supplier",
  category: "Suppliers",
  instruction: "Emails from a supplier about deliveries",
} as const;

export type JevClient = Awaited<ReturnType<typeof commerceClient>>;
export type TypeSafeCall = Readonly<{ key: string; purpose: "probe" | "mail" }>;

/** One settled Pantry-funded related Cases row with a token total, this month. */
export function seedTokenUse(
  organisationId: OrganisationId,
  evaluationId: string,
  tokens: number,
  _actor: unknown,
  state: DurableObjectState,
): void {
  const at = Math.max(typeSafeMonth(Date.now()).start, Date.now() - 5_000);
  state.storage.sql.exec(
    `INSERT INTO typesafe_evaluation (
      organisation_id, purpose, evaluation_id, request_digest, policy_revision, funding,
      connection_revision, disclosure_decision_digest, input_bytes, reserved_input_tokens,
      reserved_wall_ms, reserved_cost_microusd, estimated_cost_microusd, input_tokens,
      output_tokens, reserved_at, expires_at, state, settlement_state, failure_code
    ) VALUES (?, 'case_context_discovery_relationship', ?, ?, 1, 'pantry_platform', NULL, ?,
      100, 100, 1000, ?, ?, ?, 0, ?, ?, 'evaluated', 'settled', NULL)`,
    organisationId,
    evaluationId,
    "a".repeat(64),
    "b".repeat(64),
    Math.ceil(tokens * 0.042),
    Math.ceil(tokens * 0.042),
    tokens,
    at,
    at + 1_000,
  );
}

export function installFakes(
  held: Promise<void> = Promise.resolve(),
  mailTokens = 50,
): TypeSafeCall[] {
  const calls: TypeSafeCall[] = [];
  network.use(
    http.post(
      "https://api.typesafe.ai/v1/systemone",
      typeSafe.bind(null, calls, held, mailTokens),
    ),
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/*", gmail),
  );
  return calls;
}

async function typeSafe(
  calls: TypeSafeCall[],
  held: Promise<void>,
  mailTokens: number,
  {
    request,
  }: {
    request: { headers: Headers; json: () => Promise<unknown> };
  },
): Promise<Response> {
  const key = (request.headers.get("authorization") ?? "").replace(
    /^Bearer /,
    "",
  );
  const raw: unknown = await request.json();
  if (!isRecord(raw) || !isRecord(raw.questions))
    throw new Error("Invalid fake TypeSafe request");
  if (raw.questions.in_transit !== undefined) {
    calls.push({ key, purpose: "probe" });
    return HttpResponse.json({
      model: "jev-1.13.0",
      answers: { in_transit: { type: "noul", noul: 1 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
  }
  calls.push({ key, purpose: "mail" });
  await held;
  return HttpResponse.json({
    model: "jev-1.13.0",
    answers: { rule_0: { type: "choice", choice: "matched" } },
    usage: { input_tokens: mailTokens, output_tokens: 2 },
  });
}

function gmail({ request }: { request: { url: string } }): Response {
  const url = new URL(request.url);
  const match = /\/messages\/(m[1-3])$/.exec(url.pathname);
  if (match === null) return new Response("missing", { status: 404 });
  const id = match[1] ?? "m1";
  return HttpResponse.json({
    id,
    threadId: `t${id.slice(1)}`,
    internalDate: "1790726400000",
    sizeEstimate: 200,
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Supplier <supplier@example.test>" },
        { name: "Subject", value: "Packaging delivery delayed" },
      ],
      body: {
        data: encodeBase64Url(
          new TextEncoder().encode("Packaging arrives Friday."),
        ),
      },
    },
  });
}

export async function shop(name: string): Promise<{
  organisationId: OrganisationId;
  owner: JevClient;
  accountId: string;
}> {
  const owner = await commerceClient(`${name}-owner`);
  const now = Date.now();
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const created = await bootstrapOrganisation({
    env,
    owner: owner.identity,
    organisationName: "Jev settings",
    environment: "development",
    placement: placement.value,
    now,
    mutation: {
      scope: {
        userId: owner.identity.userId,
        organisationScope: "organisation:create",
        route: "/v1/control/organisations",
        operation: "organisation.create",
      },
      boundary: {
        kind: "unversioned",
        idempotencyKey: crypto.randomUUID(),
        requestHash: "jev-e2e",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "jev-e2e",
        causationId: crypto.randomUUID(),
        now,
      }),
    },
  });
  if (!created.ok) throw new Error(created.error.code);
  const organisationId = created.value.organisationId;
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'jev-e2e', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    )
    .bind(now, now, organisationId)
    .run();
  const policy = defaultDenyPolicy({ now });
  policy.version = 1;
  policy.authz.allowedTools = [
    CAPABILITY_KEYS.emailMailboxRead,
    CONTEXT_CASE_READ_CAPABILITY,
  ];
  await fixtureDatabase()
    .prepare(
      "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 1, ?, ?, 'jev-e2e')",
    )
    .bind(organisationId, JSON.stringify(policy), now)
    .run();
  await env.POLICY_KV.put(
    `policy:${organisationId}:latest`,
    JSON.stringify(policy),
  );
  await env.POLICY_KV.put(
    `policy:${organisationId}:v1`,
    JSON.stringify(policy),
  );
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now,
  });
  await organisation.ensureOrganisation({
    organisationId,
    name: "Jev settings",
    plan: "beta",
    status: "active",
    createdAt: now,
  });
  return {
    organisationId,
    owner,
    accountId: await mailbox(organisationId, owner, name),
  };
}

async function mailbox(
  organisationId: OrganisationId,
  owner: JevClient,
  name: string,
): Promise<string> {
  const now = Date.now();
  const handle = requireVaultHandle(
    `vault:${organisationId.toLowerCase()}:gmail:${name}:oauth:g1`,
  );
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId,
    handle,
    now,
    secret: {
      kind: "oauth_tokens",
      accessToken: "jev-e2e-token",
      refreshToken: "jev-e2e-refresh",
      expiry: { kind: "expires", expiresAt: now + 3_600_000 },
    },
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId,
    provider: "gmail",
    authorizationProduct: "full_mailbox_pilot",
    providerSubjectId: name,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: GMAIL_FULL_MAILBOX_SCOPES,
    createdByUserId: owner.identity.userId,
    providerAccountId: name,
    accountKind: "mailbox",
    displayName: name,
    capabilities: [CAPABILITY_KEYS.emailMailboxRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const granted = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId,
    grantId: `grant_mail_${name}`,
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "provider_resource",
      capabilityId: CAPABILITY_KEYS.emailMailboxRead,
      capabilityVersion: 1,
      integrationAccountId: connected.account.integrationAccountId,
      resourceScope: "mailbox",
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "jev-e2e",
    },
    now,
  });
  if (!granted.ok) throw new Error(granted.error.code);
  return connected.account.integrationAccountId;
}

export async function features(
  organisationId: OrganisationId,
  session: IssuedControlSession,
): Promise<JevFeaturesView> {
  const response = await controlFetch(
    organisationId,
    session,
    "jev-features",
    null,
  );
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw)) throw new Error("Invalid Jev settings answer");
  return parseJevFeaturesView(raw.value);
}

export async function change(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  body: unknown,
): Promise<JevFeaturesView> {
  const response = await controlFetch(
    organisationId,
    session,
    "jev-features",
    body,
  );
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw)) throw new Error("Invalid Jev settings answer");
  return parseJevFeaturesView(raw.value);
}

export function preview(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  accountId: string,
  messageIds: readonly string[] = ["m1"],
): Promise<Response> {
  return controlFetch(
    organisationId,
    session,
    `mail-inbox/${accountId}/organization`,
    { kind: "preview", rules: [RULE], messageIds, consent: true },
  );
}
