// Plan 88 phase 1: Jev from Pantry. Journeys J1, J2 and J6 of
// docs/plan-88-satyr-funded-jev.md. The fake TypeSafe only records the key and
// the purpose of each request and answers; product code chooses the key, writes
// the switch records and refuses the requests that the journeys assert.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import {
  parseJevFeaturesView,
  type JevFeaturesView,
} from "@purin-labs/control-api/portal/jev-features";
import { encodeBase64Url, isRecord } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { typeSafeMonth } from "../../src/integrations/typesafe/usage-store";
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
import { addOrganisationMember } from "./organisation-fixture";
import { controlFetch } from "./chat-journey-support";

const PANTRY_KEY = "typesafe-pantry-e2e-key-0000000000";
const OWN_KEY = "typesafe-own-e2e-key-00000000000";
const RULE = {
  kind: "categorize",
  ruleId: "rule_supplier",
  category: "Suppliers",
  instruction: "Emails from a supplier about deliveries",
} as const;

type Client = Awaited<ReturnType<typeof commerceClient>>;
type TypeSafeCall = Readonly<{ key: string; purpose: "probe" | "mail" }>;

it(
  "J1 and J2: an Organisation with no TypeSafe key sorts mail with Pantry's key, and a switch turned off stops its feature for admins only",
  noKeyJourney,
  120_000,
);

it(
  "J6: an Organisation with its own key sorts mail with that key, and the mail switch stays on across the key change",
  ownKeyJourney,
  120_000,
);

it(
  "J3: at the free use of the month a Jev call fails before any TypeSafe request, the page names the reset date, and a call accepted before the stop settles",
  allowanceJourney,
  120_000,
);

async function allowanceJourney(): Promise<void> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = installFakes(held);
  const { organisationId, owner, accountId } = await shop("p88-allowance");
  await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  // Seed: earlier Jev use of this month on Pantry's key, as the ledger records it.
  await runInDurableObject(
    organisation,
    seedPantryUse.bind(null, organisationId, "earlier-use", 990_000),
  );
  expect((await features(organisationId, owner.session)).allowance).toEqual({
    usedMicrousd: 990_000,
    limitMicrousd: 1_000_000,
    resetsAt: typeSafeMonth(Date.now()).next,
    reached: false,
  });

  // A call is accepted while it fits, and stays in flight at TypeSafe.
  const accepted = preview(organisationId, owner.session, accountId, ["m1"]);
  await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
  // Meanwhile other Jev use of the month takes the rest of the free use.
  await runInDurableObject(
    organisation,
    seedPantryUse.bind(null, organisationId, "other-use", 8_000),
  );

  // The next call fails before any TypeSafe request.
  const refused = await preview(organisationId, owner.session, accountId, [
    "m2",
  ]);
  expect(refused.status).not.toBe(200);
  expect(await refused.text()).toContain("allowance_reached");
  expect(calls).toHaveLength(1);

  // The call accepted before the stop settles with its answer.
  release();
  const settled = await accepted;
  expect(settled.status, await settled.clone().text()).toBe(200);
  expect(await settled.json()).toMatchObject({
    kind: "preview",
    classifications: [{ messageId: "m1", outcome: "matched" }],
  });

  // The page says the free use is used and names the reset date.
  const view = await features(organisationId, owner.session);
  expect(view.allowance).toMatchObject({
    limitMicrousd: 1_000_000,
    resetsAt: typeSafeMonth(Date.now()).next,
    reached: true,
  });
  expect(view.allowance?.usedMicrousd).toBeGreaterThan(998_000);
  expect(calls).toHaveLength(1);
}

/** One settled Pantry-funded related Cases row: other Jev use of the current month. */
function seedPantryUse(
  organisationId: OrganisationId,
  evaluationId: string,
  costMicrousd: number,
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
    ) VALUES (?, 'case_context_discovery_relationship', ?, ?, 1, 'pantry_platform', NULL, ?, 100, 100,
      1000, ?, ?, 100, 0, ?, ?, 'evaluated', 'settled', NULL)`,
    organisationId,
    evaluationId,
    "a".repeat(64),
    "b".repeat(64),
    costMicrousd,
    costMicrousd,
    at,
    at + 1_000,
  );
}

it(
  "J4: a closed hour of Jev use on Pantry's key becomes one record for each feature, with the exact token total",
  recordsJourney,
  120_000,
);

const HOUR_MS = 3_600_000;

async function recordsJourney(): Promise<void> {
  installFakes();
  const { organisationId } = await shop("p88-records");
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  // Seed: the ledger rows of a closed hour, as the Jev calls of that hour wrote them.
  const closedHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;
  await runInDurableObject(
    organisation,
    seedHourLedger.bind(null, organisationId, closedHour),
  );
  expect(await runDurableObjectAlarm(organisation)).toBe(true);

  // One record for each feature: mail 120 + 30, related Cases 70. The call on
  // the Organisation's own key in the same hour is not Pantry's use. Pantry
  // sends no hour to a meter until its own billing (Plan 95 step 6).
  expect(await runInDurableObject(organisation, readHours)).toEqual([
    { feature: "mail_classification", inputTokens: 150, state: "not_billed" },
    { feature: "related_cases", inputTokens: 70, state: "not_billed" },
  ]);
}

async function seedHourLedger(
  organisationId: OrganisationId,
  hourStart: number,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const rows: readonly [string, string, string, number][] = [
    ["mail_classification", "hour-mail-1", "pantry_platform", 120],
    ["mail_classification", "hour-mail-2", "pantry_platform", 30],
    [
      "case_context_discovery_relationship",
      "hour-related-1",
      "pantry_platform",
      70,
    ],
    ["mail_classification", "hour-own-key", "organisation_byo", 500],
  ];
  for (const [purpose, evaluationId, funding, tokens] of rows) {
    const at = hourStart + 60_000;
    state.storage.sql.exec(
      `INSERT INTO typesafe_evaluation (
        organisation_id, purpose, evaluation_id, request_digest, policy_revision, funding,
        connection_revision, disclosure_decision_digest, input_bytes, reserved_input_tokens,
        reserved_wall_ms, reserved_cost_microusd, estimated_cost_microusd, input_tokens,
        output_tokens, reserved_at, expires_at, state, settlement_state, failure_code
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 100, 1000, 1000, 3000, ?, ?, 0, ?, ?, 'evaluated', 'settled', NULL)`,
      organisationId,
      purpose,
      evaluationId,
      "a".repeat(64),
      funding,
      funding === "organisation_byo" ? 1 : null,
      "b".repeat(64),
      Math.ceil(tokens * 0.042),
      tokens,
      at,
      at + 10_000,
    );
  }
  await state.storage.setAlarm(Date.now() + HOUR_MS);
}

function readHours(
  _actor: unknown,
  state: DurableObjectState,
): readonly { feature: string; inputTokens: number; state: string }[] {
  return state.storage.sql
    .exec<{ feature: string; input_tokens: number; state: string }>(
      "SELECT feature, input_tokens, state FROM jev_usage_hour ORDER BY feature",
    )
    .toArray()
    .map((row) => ({
      feature: row.feature,
      inputTokens: row.input_tokens,
      state: row.state,
    }));
}

it(
  "J7: paid use is closed until Pantry bills through Stripe: above the free use a call stops, and neither an admin nor the owner can turn paid use on",
  paidUseClosedJourney,
  120_000,
);

async function paidUseClosedJourney(): Promise<void> {
  const calls = installFakes(Promise.resolve(), 10_000);
  const { organisationId, owner, accountId } = await shop("p88-paid-use");
  const admin = await commerceClient("p88-paid-use-admin");
  await addOrganisationMember(organisationId, admin, "admin");
  await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  // Seed: earlier related Cases use of this month on Pantry's key, 50,000
  // tokens above the free use.
  await runInDurableObject(
    organisation,
    seedTokenUse.bind(null, organisationId, "earlier-paid", 23_859_523),
  );

  // The free use is used: the call stops before TypeSafe.
  const stopped = await preview(organisationId, owner.session, accountId);
  expect(await stopped.text()).toContain("allowance_reached");
  expect(calls).toEqual([]);
  const before = await features(organisationId, owner.session);
  expect(before.allowance?.reached).toBe(true);
  expect(before.paidUse).toMatchObject({ enabled: false, priced: false });

  // Denied: an admin who is not the owner.
  const refused = await controlFetch(
    organisationId,
    admin.session,
    "jev-features/paid-use",
    { enabled: true, spendingLimitMinor: 500 },
  );
  expect(refused.status).toBe(404);
  // Denied: the owner too, while paid use is closed.
  const closed = await controlFetch(
    organisationId,
    owner.session,
    "jev-features/paid-use",
    { enabled: true, spendingLimitMinor: 500 },
  );
  expect(closed.status).toBe(409);
  expect(await closed.text()).toContain("jev_paid_use_closed");

  // The next call stops too, and paid use stays off.
  const still = await preview(organisationId, owner.session, accountId, ["m2"]);
  expect(await still.text()).toContain("allowance_reached");
  expect(calls).toEqual([]);
  expect((await features(organisationId, owner.session)).paidUse.enabled).toBe(
    false,
  );
}

/** One settled Pantry-funded related Cases row with a token total, this month. */
function seedTokenUse(
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

async function noKeyJourney(): Promise<void> {
  const calls = installFakes();
  const { organisationId, owner, accountId } = await shop("p88-no-key");
  const operator = await commerceClient("p88-no-key-operator");
  await addOrganisationMember(organisationId, operator, "operator");

  // J1: no key of its own; Pantry's key funds Jev, and every switch starts off.
  const initial = await features(organisationId, owner.session);
  expect(initial).toMatchObject({
    funding: "pantry_platform",
    keyAvailable: true,
    mailClassification: {
      enabled: false,
      mailboxes: [{ integrationAccountId: accountId, covered: false }],
    },
    relatedCases: { enabled: false, mode: null },
    screenRelevance: { enabled: false },
  });
  expect((await preview(organisationId, owner.session, accountId)).status).toBe(
    409,
  );
  expect(calls).toEqual([]);

  const mailOn = await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  expect(mailOn.mailClassification).toMatchObject({
    enabled: true,
    mailboxes: [{ integrationAccountId: accountId, covered: true }],
  });
  const sorted = await preview(organisationId, owner.session, accountId);
  expect(sorted.status, await sorted.clone().text()).toBe(200);
  expect(await sorted.json()).toMatchObject({
    kind: "preview",
    classifications: [
      { messageId: "m1", ruleId: "rule_supplier", outcome: "matched" },
    ],
  });
  expect(calls).toEqual([{ key: PANTRY_KEY, purpose: "mail" }]);
  // No key of the Organisation exists, so no Vault key was read.
  expect(await typeSafeVaultSecrets(organisationId)).toBe(0);

  // J2: a non-admin reads the switches but cannot change one.
  expect((await features(organisationId, operator.session)).funding).toBe(
    "pantry_platform",
  );
  const refused = await post(organisationId, operator.session, {
    feature: "related_cases",
    enabled: true,
  });
  // The role check hides an admin route from a lower role.
  expect(refused.status).toBe(404);
  expect((await features(organisationId, owner.session)).relatedCases).toEqual({
    enabled: false,
    mode: null,
    sourceCount: 0,
  });

  // J2: the admin turns related Cases on and off; off leaves no Jev route for a new Case.
  const relatedOn = await change(organisationId, owner.session, {
    feature: "related_cases",
    enabled: true,
  });
  expect(relatedOn.relatedCases).toEqual({
    enabled: true,
    mode: "metadata_only",
    sourceCount: 1,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  expect(
    await organisation.readCaseContextDiscoverySourceReadiness({
      organisationId,
      source: "gmail",
      integrationAccountId: accountId,
    }),
  ).toMatchObject({ ok: true, value: { kind: "ready" } });
  const relatedOff = await change(organisationId, owner.session, {
    feature: "related_cases",
    enabled: false,
  });
  expect(relatedOff.relatedCases.enabled).toBe(false);
  expect(
    await organisation.readCaseContextDiscoverySourceReadiness({
      organisationId,
      source: "gmail",
      integrationAccountId: accountId,
    }),
  ).toEqual({ ok: true, value: { kind: "inactive", reason: "disabled" } });

  // Mail classification still works after related Cases is off.
  const stillSorted = await preview(organisationId, owner.session, accountId, [
    "m2",
  ]);
  expect(stillSorted.status, await stillSorted.clone().text()).toBe(200);
  expect(calls).toEqual([
    { key: PANTRY_KEY, purpose: "mail" },
    { key: PANTRY_KEY, purpose: "mail" },
  ]);

  // Mail off stops new calls at once.
  const mailOff = await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: false,
  });
  expect(mailOff.mailClassification.enabled).toBe(false);
  expect(
    (await preview(organisationId, owner.session, accountId, ["m3"])).status,
  ).toBe(409);
  expect(calls).toHaveLength(2);

  // The screen relevance switch has its own record.
  const screenOn = await change(organisationId, owner.session, {
    feature: "screen_relevance",
    enabled: true,
  });
  expect(screenOn.screenRelevance.enabled).toBe(true);
  expect(
    (
      await post(organisationId, operator.session, {
        feature: "screen_relevance",
        enabled: false,
      })
    ).status,
  ).toBe(404);
  expect(
    (await features(organisationId, owner.session)).screenRelevance.enabled,
  ).toBe(true);
}

async function ownKeyJourney(): Promise<void> {
  const calls = installFakes();
  const { organisationId, owner, accountId } = await shop("p88-own-key");
  await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  await change(organisationId, owner.session, {
    feature: "related_cases",
    enabled: true,
  });

  // The admin connects the Organisation's own key; the probe uses that key.
  const connected = await controlFetch(
    organisationId,
    owner.session,
    "integrations/typesafe",
    {
      operation: "connect",
      expectedRevision: 0,
      provider: "typesafe",
      apiKey: OWN_KEY,
    },
  );
  expect(connected.status, await connected.clone().text()).toBe(200);
  expect(calls).toEqual([{ key: OWN_KEY, purpose: "probe" }]);

  // Both switches stay on, now pinned to the Organisation's key.
  const view = await features(organisationId, owner.session);
  expect(view).toMatchObject({
    funding: "organisation_byo",
    keyAvailable: true,
    mailClassification: {
      enabled: true,
      mailboxes: [{ integrationAccountId: accountId, covered: true }],
    },
    relatedCases: { enabled: true, mode: "metadata_only" },
  });

  const sorted = await preview(organisationId, owner.session, accountId);
  expect(sorted.status, await sorted.clone().text()).toBe(200);
  // Every call used the Organisation's key; none used Pantry's key.
  expect(calls).toEqual([
    { key: OWN_KEY, purpose: "probe" },
    { key: OWN_KEY, purpose: "mail" },
  ]);
  expect(calls.some((call) => call.key === PANTRY_KEY)).toBe(false);

  // The admin removes the key: the switches move back to Pantry's key.
  const disconnected = await controlFetch(
    organisationId,
    owner.session,
    "integrations/typesafe",
    { operation: "disconnect", expectedRevision: 1 },
  );
  expect(disconnected.status, await disconnected.clone().text()).toBe(200);
  expect(await features(organisationId, owner.session)).toMatchObject({
    funding: "pantry_platform",
    mailClassification: { enabled: true },
    relatedCases: { enabled: true },
  });
  const back = await preview(organisationId, owner.session, accountId, ["m2"]);
  expect(back.status, await back.clone().text()).toBe(200);
  expect(calls.at(-1)).toEqual({ key: PANTRY_KEY, purpose: "mail" });
}

function installFakes(
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

async function shop(name: string): Promise<{
  organisationId: OrganisationId;
  owner: Client;
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
        requestHash: "plan-88-e2e",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "plan-88-e2e",
        causationId: crypto.randomUUID(),
        now,
      }),
    },
  });
  if (!created.ok) throw new Error(created.error.code);
  const organisationId = created.value.organisationId;
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'plan-88-e2e', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
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
      "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 1, ?, ?, 'plan-88-e2e')",
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
  owner: Client,
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
      accessToken: "plan-88-e2e-token",
      refreshToken: "plan-88-e2e-refresh",
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
      materializationReceiptId: "plan-88-e2e",
    },
    now,
  });
  if (!granted.ok) throw new Error(granted.error.code);
  return connected.account.integrationAccountId;
}

async function features(
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

async function change(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  body: unknown,
): Promise<JevFeaturesView> {
  const response = await post(organisationId, session, body);
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw)) throw new Error("Invalid Jev settings answer");
  return parseJevFeaturesView(raw.value);
}

function post(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  body: unknown,
): Promise<Response> {
  return controlFetch(organisationId, session, "jev-features", body);
}

function preview(
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

async function typeSafeVaultSecrets(
  organisationId: OrganisationId,
): Promise<number> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM vault_secret WHERE organisation_id = ? AND vault_handle LIKE '%:typesafe:%'",
    )
    .bind(organisationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
