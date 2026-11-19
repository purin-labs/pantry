import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { connectRealAccountPlatform } from "./real-account-platform-fixture";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/actors/actor-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actors/actor-router")>()),
  requireActiveOrganisationActorAtPlacement: vi.fn().mockResolvedValue({
    invalidateCaseContextCollectionVerification: vi
      .fn()
      .mockResolvedValue({ ok: true, value: null }),
  }),
}));

import { OrganisationDO } from "../src/actors/organisation";
import { activateOrganisationFixture } from "./fixtures/organisation-activation";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { parseVaultHandle } from "../src/credential-vault";
import { issueControlSession, upsertUser } from "../src/data/control-plane";
import {
  parseContactVerificationCommand,
  publishContactVerification,
  resolveVerifiedContactEndpoint,
  type ContactVerificationCommand,
} from "../src/data/contact-verification";
import {
  registerOperationalEmailContact,
  type OperationalEmailTarget,
} from "../src/data/email-operational";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
} from "../src/data/integration-account";
import { removeIntegrationAccount } from "../src/data/account-removal";
import { newControlMutationIdentity } from "../src/data/control-mutation";
import { bindCommerceMerchant } from "../src/data/commerce-merchant-binding";
import { handleContactVerification } from "../src/control/routes/contact-verification";
import {
  recordCaseContextCollectionSuggestion,
  type CaseContextCollectionScope,
} from "../src/case-context-discovery/relationships";
import { matchAgentControlRoute } from "../src/control/routes/agents";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import { TEST_INITIAL_ORGANISATION_PLACEMENT } from "./fixtures/organisation-placement";
import { d1Database } from "./sqlite-d1";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import type { Variant } from "@seams/type-utils";

describe("verified contact endpoint boundary", suite);

function suite(): void {
  it(
    "requires current contact, merchant and provider identity and makes revoke terminal for an old reference",
    verifiesAndRevokes,
  );
  it(
    "rejects changed contact revisions and inactive provider connections",
    checksCurrentIdentity,
  );
  it(
    "fails closed for an endpoint associated with two contacts",
    rejectsAmbiguity,
  );
  it(
    "converges concurrent command replay and rejects changed command contents",
    replaysCommands,
  );
  it(
    "authorizes only administrative CSRF-protected contact verification",
    controlsPublication,
  );
  it(
    "rejects forged lifecycle combinations and normalizes email endpoints",
    parsesCommands,
  );
  it(
    "erases endpoint evidence when the owning account is removed",
    erasesAccountEvidence,
  );
  it(
    "rechecks the exact verified contact before confirming an CaseContextCollection relationship",
    confirmsCaseContextCollectionRelationship,
  );
}

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(singleDatabaseSchema());
  const db = d1Database(sqlite);
  const now = Date.now();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "contact-admin",
      email: "admin@example.com",
      displayName: "Admin",
      emailVerified: true,
    },
    now,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Contact verification",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, now),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now,
  });
  const credential = parseVaultHandle(
    "vault:organisation:gmail:contactfixture:oauth:g1",
  );
  if (!credential.ok) throw new Error("invalid credential fixture");
  const connected = await createConnectedIntegration(db, {
    organisationId: organisation.organisationId,
    provider: "gmail",
    providerSubjectId: "contact-mailbox",
    environment: "development",
    authMode: "shared_satyr_app",
    authorizationProduct: "send_only",
    authority: {
      kind: "connection_credential",
      credentialRef: credential.value,
    },
    grantedScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    createdByUserId: owner.userId,
    providerAccountId: "contact-mailbox",
    accountKind: "sender",
    displayName: "Mailbox",
    capabilities: ["email.operational.propose"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now,
  });
  const bound = await bindCommerceMerchant({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    bindingId: "underclerk_binding_contacts",
    merchantId: "merchant_contacts",
    environment: "development",
    deliverySigningKeyId: "key_contact_fixture",
    deliverySigningPublicKey: new Uint8Array(32).fill(7),
    now,
  });
  if (!bound.ok) throw new Error(bound.error.code);
  const target: OperationalEmailTarget = {
    kind: "supplier_contact",
    supplierId: "supplier_flour",
    contactId: "contact_sales",
    contactRevision: 1,
  };
  const registered = await registerOperationalEmailContact({
    db,
    organisationId: organisation.organisationId,
    target,
    address: "sales@example.com",
    displayName: null,
    state: "active",
    relationshipState: "active",
    now,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return {
    db,
    sqlite,
    organisationId: organisation.organisationId,
    owner,
    target,
    connected,
    now,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function command(f: Fixture): Variant<ContactVerificationCommand, "verify"> {
  return {
    kind: "verify",
    commandId: "verify_1",
    verificationId: "verification_sales",
    expectedRevision: 0,
    integrationAccountId: f.connected.account.integrationAccountId,
    target: f.target,
    endpoint: { channel: "gmail", address: "sales@example.com" },
    evidenceRef: "operator_review:843",
  };
}

function publish(f: Fixture, next: ContactVerificationCommand = command(f)) {
  return publishContactVerification({
    db: f.db,
    organisationId: f.organisationId,
    actorId: f.owner.userId,
    command: next,
    now: f.now,
  });
}

function resolve(f: Fixture) {
  return resolveVerifiedContactEndpoint({
    db: f.db,
    organisationId: f.organisationId,
    verificationId: "verification_sales",
    expectedRevision: 1,
  });
}

async function verifiesAndRevokes(): Promise<void> {
  const f = await fixture();
  expect(await resolve(f)).toMatchObject({ ok: false });
  expect(
    await publish(f, {
      ...command(f),
      endpoint: { channel: "gmail", address: "attacker@example.com" },
    }),
  ).toMatchObject({ ok: false });
  expect(await publish(f)).toEqual({ ok: true, value: { revision: 1 } });
  expect(await resolve(f)).toMatchObject({
    ok: true,
    value: { merchantId: "merchant_contacts", target: f.target, revision: 1 },
  });
  await setIntegrationAccountLifecycle({
    db: f.db,
    organisationId: f.organisationId,
    integrationAccountId: f.connected.account.integrationAccountId,
    lifecycle: { kind: "revoked", revokedAt: f.now + 1 },
    now: f.now + 1,
  });
  expect(await resolve(f)).toMatchObject({ ok: false });
  expect(
    await publish(f, {
      kind: "revoke",
      commandId: "revoke_1",
      verificationId: "verification_sales",
      expectedRevision: 1,
    }),
  ).toEqual({ ok: true, value: { revision: 2 } });
  expect(await resolve(f)).toMatchObject({ ok: false });
  // A replay describes the prior decision; it never reinstates verification.
  expect(await publish(f)).toEqual({ ok: true, value: { revision: 1 } });
  expect(await resolve(f)).toMatchObject({ ok: false });
}

async function confirmsCaseContextCollectionRelationship(): Promise<void> {
  const f = await fixture();
  await expect(publish(f)).resolves.toEqual({
    ok: true,
    value: { revision: 1 },
  });
  const actorFixture = emptySqliteFixture();
  const sql = sqlStorage(actorFixture.storage);
  const env = platformEnv({
    DB: f.db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const actor = new OrganisationDO(
    {
      storage: {
        setAlarm: vi.fn().mockResolvedValue(undefined),
        deleteAlarm: vi.fn().mockResolvedValue(undefined),
        sql,
        transactionSync: actorFixture.storage.transactionSync.bind(
          actorFixture.storage,
        ),
      },
    } as unknown as DurableObjectState,
    env,
  );
  sql.exec(
    "INSERT INTO organisation_meta VALUES (?, 'CaseContextCollection confirmation', 'beta', 'active', 1)",
    f.organisationId,
  );
  await activateOrganisationFixture(actor, env, f.organisationId);
  const scope: CaseContextCollectionScope = {
    organisationId: f.organisationId,
    merchantId: "merchant_contacts",
    party: { kind: "supplier", id: "supplier_flour" },
    issueKind: "delivery_delay",
    issueInstance: "shipment_842_1",
  };
  expect(
    recordCaseContextCollectionSuggestion({
      sql,
      transaction: actorFixture.storage.transactionSync.bind(
        actorFixture.storage,
      ),
      organisationId: f.organisationId,
      commandId: "suggest_verified_contact",
      requestDigest: "a".repeat(64),
      caseContextCollectionId: "case_context_collection_verified_contact",
      relationshipId: "relationship_verified_contact",
      expectedRevision: 0,
      scope,
      sourceScope: scope,
      anchorSelection: {
        caseId: "case_supplier_anchor",
        source: "gmail",
        integrationAccountId: f.connected.account.integrationAccountId,
        reference: "gmail_message_anchor",
        sourceRevision: 1,
        verificationId: "verification_sales",
        verificationRevision: 1,
      },
      selection: {
        caseId: "case_supplier_delivery",
        source: "gmail",
        integrationAccountId: f.connected.account.integrationAccountId,
        reference: "gmail_message_one",
        sourceRevision: 1,
        verificationId: "verification_sales",
        verificationRevision: 1,
      },
      evaluationId: "evaluation_verified_contact",
      outcome: "same_issue",
      confidence: 1,
      expiresAt: f.now + 60_000,
      now: f.now,
    }),
  ).toMatchObject({ ok: true });
  const confirmation = {
    organisationId: f.organisationId,
    actorId: f.owner.userId,
    caseContextCollectionId: "case_context_collection_verified_contact",
    body: {
      commandId: "confirm_verified_contact",
      expectedRevision: 1,
      decision: {
        kind: "confirm",
        relationshipId: "relationship_verified_contact",
      },
    },
  };
  await expect(
    actor.reviewCaseContextCollectionRelationship(confirmation),
  ).resolves.toMatchObject({ ok: true, value: { revision: 2 } });
  await publish(f, {
    kind: "revoke",
    commandId: "revoke_after_confirmation",
    verificationId: "verification_sales",
    expectedRevision: 1,
  });
  await expect(
    actor.reviewCaseContextCollectionRelationship(confirmation),
  ).resolves.toEqual({
    ok: true,
    value: {
      caseContextCollectionId: "case_context_collection_verified_contact",
      revision: 2,
    },
  });
  expect(
    recordCaseContextCollectionSuggestion({
      sql,
      transaction: actorFixture.storage.transactionSync.bind(
        actorFixture.storage,
      ),
      organisationId: f.organisationId,
      commandId: "suggest_revoked_contact",
      requestDigest: "b".repeat(64),
      caseContextCollectionId: "case_context_collection_verified_contact",
      relationshipId: "relationship_revoked_contact",
      expectedRevision: 2,
      scope,
      sourceScope: scope,
      anchorSelection: {
        caseId: "case_supplier_anchor",
        source: "gmail",
        integrationAccountId: f.connected.account.integrationAccountId,
        reference: "gmail_message_anchor",
        sourceRevision: 1,
        verificationId: "verification_sales",
        verificationRevision: 1,
      },
      selection: {
        caseId: "case_supplier_followup",
        source: "gmail",
        integrationAccountId: f.connected.account.integrationAccountId,
        reference: "gmail_message_two",
        sourceRevision: 1,
        verificationId: "verification_sales",
        verificationRevision: 1,
      },
      evaluationId: "evaluation_revoked_contact",
      outcome: "same_issue",
      confidence: 1,
      expiresAt: f.now + 60_000,
      now: f.now,
    }),
  ).toMatchObject({ ok: true, value: { revision: 3 } });
  await expect(
    actor.reviewCaseContextCollectionRelationship({
      organisationId: f.organisationId,
      actorId: f.owner.userId,
      caseContextCollectionId: "case_context_collection_verified_contact",
      body: {
        commandId: "confirm_revoked_contact",
        expectedRevision: 3,
        decision: {
          kind: "confirm",
          relationshipId: "relationship_revoked_contact",
        },
      },
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "case_context_collection_relationship_unavailable" },
  });
  actorFixture.database.close();
  f.sqlite.close();
}

async function checksCurrentIdentity(): Promise<void> {
  const f = await fixture();
  await publish(f);
  await f.db
    .prepare(
      "UPDATE provider_connection SET lifecycle = 'revoked', revoked_at = ? WHERE provider_connection_id = ?",
    )
    .bind(f.now + 1, f.connected.connection.providerConnectionId)
    .run();
  expect(await resolve(f)).toMatchObject({ ok: false });
  const other = await fixture();
  await publish(other);
  await registerOperationalEmailContact({
    db: other.db,
    organisationId: other.organisationId,
    target: {
      kind: "supplier_contact",
      supplierId: "supplier_flour",
      contactId: "contact_sales",
      contactRevision: 2,
    },
    address: "sales@example.com",
    displayName: null,
    state: "active",
    relationshipState: "active",
    now: other.now + 1,
  });
  expect(await resolve(other)).toMatchObject({ ok: false });
}

async function rejectsAmbiguity(): Promise<void> {
  const f = await fixture();
  await publish(f);
  const target: OperationalEmailTarget = {
    kind: "customer_contact",
    customerId: "customer_other",
    contactId: "contact_other",
    contactRevision: 1,
  };
  await registerOperationalEmailContact({
    db: f.db,
    organisationId: f.organisationId,
    target,
    address: "sales@example.com",
    displayName: null,
    state: "active",
    relationshipState: "active",
    now: f.now,
  });
  expect(
    await publish(f, {
      ...command(f),
      commandId: "verify_2",
      verificationId: "verification_other",
      target,
    }),
  ).toMatchObject({ ok: true });
  expect(await resolve(f)).toMatchObject({ ok: false });
}

async function replaysCommands(): Promise<void> {
  const f = await fixture();
  const [first, second] = await Promise.all([publish(f), publish(f)]);
  expect(first).toEqual({ ok: true, value: { revision: 1 } });
  expect(second).toEqual(first);
  expect(
    await publish(f, { ...command(f), evidenceRef: "changed_proof" }),
  ).toEqual({ ok: false, error: { code: "contact_verification_conflict" } });
  expect(
    f.sqlite
      .prepare("SELECT COUNT(*) AS count FROM contact_endpoint_verification")
      .get(),
  ).toEqual({ count: 1 });
}

async function controlsPublication(): Promise<void> {
  const f = await fixture();
  const session = await issueControlSession({
    db: f.db,
    userId: f.owner.userId,
    now: f.now,
    ttlMs: 60_000,
  });
  const url = `https://satyr.example/v1/control/organisations/${f.organisationId}/contact-endpoint-verifications`;
  expect(matchAgentControlRoute(new URL(url).pathname)).toEqual({
    kind: "contactEndpointVerification",
    organisationIdRaw: f.organisationId,
  });
  const account = await connectRealAccountPlatform(
    {
      DB: f.db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      PANTRY_PUBLIC_ORIGIN: "https://satyr.example",
    } as UnitTestEnv,
    {
      organisationId: f.organisationId,
      owner: { user: f.owner, session: session.session },
      members: [],
    },
  );
  const env = account.env;
  const headers = {
    origin: "https://satyr.example",
    "content-type": "application/json",
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    "x-satyr-csrf": session.csrfToken,
  };
  const noCsrf = new Request(url, {
    method: "POST",
    headers: { origin: headers.origin, cookie: headers.cookie },
    body: JSON.stringify(command(f)),
  });
  expect(
    (await handleContactVerification(noCsrf, env, f.organisationId)).status,
  ).toBe(403);
  expect(await resolve(f)).toMatchObject({ ok: false });
  const good = new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(command(f)),
  });
  expect(
    (await handleContactVerification(good, env, f.organisationId)).status,
  ).toBe(200);
  const outsider = await upsertUser({
    db: f.db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "outsider",
      email: "outsider@example.com",
      displayName: "Outsider",
      emailVerified: true,
    },
    now: f.now,
  });
  const outsiderSession = await issueControlSession({
    db: f.db,
    userId: outsider.userId,
    now: f.now,
    ttlMs: 60_000,
  });
  const forbidden = new Request(url, {
    method: "POST",
    headers: {
      origin: headers.origin,
      cookie: `satyr_control_session=${outsiderSession.token}; satyr_control_csrf=${outsiderSession.csrfToken}`,
      "x-satyr-csrf": outsiderSession.csrfToken,
    },
    body: JSON.stringify({
      kind: "revoke",
      commandId: "revoke_1",
      verificationId: "verification_sales",
      expectedRevision: 1,
    }),
  });
  expect(
    (await handleContactVerification(forbidden, env, f.organisationId)).status,
  ).toBe(404);
  expect(await resolve(f)).toMatchObject({ ok: true });
}

function parsesCommands(): void {
  expect(
    parseContactVerificationCommand({
      kind: "revoke",
      commandId: "r",
      verificationId: "v",
      expectedRevision: 1,
      target: {},
    }),
  ).toBeNull();
  expect(
    parseContactVerificationCommand({
      kind: "verify",
      commandId: "v",
      verificationId: "v",
      expectedRevision: 0,
    }),
  ).toBeNull();
  expect(
    parseContactVerificationCommand({
      kind: "verify",
      commandId: "v",
      verificationId: "v",
      expectedRevision: 0,
      integrationAccountId: "integration_mailbox",
      target: {
        kind: "supplier_contact",
        supplierId: "s",
        contactId: "c",
        contactRevision: 1,
      },
      endpoint: { channel: "gmail", address: "SALES@example.com" },
      evidenceRef: "proof:1",
    }),
  ).toMatchObject({
    endpoint: { channel: "gmail", address: "sales@example.com" },
  });
}

async function erasesAccountEvidence(): Promise<void> {
  const f = await fixture();
  await publish(f);
  await setIntegrationAccountLifecycle({
    db: f.db,
    organisationId: f.organisationId,
    integrationAccountId: f.connected.account.integrationAccountId,
    lifecycle: {
      kind: "disabled",
      disabledByUserId: f.owner.userId,
      disabledAt: f.now + 1,
    },
    now: f.now + 1,
  });
  const state = await f.db
    .prepare(
      "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(f.organisationId)
    .first<{ configuration_version: number }>();
  if (state === null) throw new Error("missing fixture configuration");
  const removed = await removeIntegrationAccount({
    db: f.db,
    directory: f.db,
    organisationId: f.organisationId,
    integrationAccountId: f.connected.account.integrationAccountId,
    removedByUserId: f.owner.userId,
    mutation: {
      boundary: {
        kind: "configuration_versioned",
        idempotencyKey: "remove_contact_account",
        requestHash: "contact_account_hash",
        expectedConfigurationVersion: state.configuration_version,
      },
      scope: {
        userId: f.owner.userId,
        organisationScope: f.organisationId,
        route: `/v1/control/organisations/${f.organisationId}/accounts`,
        operation: "provider.account.remove",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "contact_admin_hash",
        causationId: "remove_contact_account",
        now: f.now + 2,
      }),
    },
    now: f.now + 2,
  });
  expect(removed).toMatchObject({ ok: true });
  expect(await resolve(f)).toMatchObject({ ok: false });
  expect(
    f.sqlite
      .prepare("SELECT COUNT(*) AS count FROM contact_endpoint_verification")
      .get(),
  ).toEqual({ count: 0 });
}
