import type { SingleDatabase } from "../src/database-handles";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { describe, expect, it } from "vitest";

import { handleControlRequest } from "../src/control-router";
import { issueControlSession, upsertUser } from "../src/data/control-plane";
import {
  projectEmailReplyProposal,
  readEmailReplyProposalProjection,
  registerEmailMailboxAccount,
} from "../src/data/email-mailbox";
import { projectEmailOperationalProposal } from "../src/data/email-operational";
import {
  createConnectedIntegration,
  setIntegrationAccountLifecycle,
  type ConnectedIntegrationSeed,
} from "../src/data/integration-account";
import type { IntegrationAccountId, OrganisationId } from "../src/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { requireVaultHandle } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
import { defaultDenyPolicy } from "../src/policy-snapshot";
import { createAccessGrant } from "../src/data/access-grants";
import { CAPABILITY_KEYS } from "../src/authorization/capability-catalogue";
import { GMAIL_FULL_MAILBOX_SCOPES } from "../src/mail/gmail-authorization";

const NOW = 1_784_016_325_277;
const ORIGIN = "https://pantry.example";
const PROPOSAL = "proposal_case_gmail_g_t9_m4";
const CASE_ID = "case_gmail_g_t9";
const THREAD = "t9";
const SNAPSHOT = "a".repeat(64);

describe("email reply control routes", emailReplyControlSuite);

function emailReplyControlSuite(): void {
  it(
    "refuses stale challenges before and stale snapshots at dispatch",
    staleTest,
  );
  it(
    "syncs invalidated previews and hides unknown proposals",
    invalidationTest,
  );
  it("lists the organisation reply queue without message content", queueTest);
  it(
    "requires explicit self-test ownership confirmation before validating send approval",
    selfTestApprovalTest,
  );
}

async function selfTestApprovalTest(): Promise<void> {
  const fixture = await createFixture("self-test-approval");
  const proposalId = "proposal_self_test_approval";
  expect(
    await projectEmailOperationalProposal({
      scope: await requireOrganisationExecutionScope(
        fixture.env,
        fixture.organisationId,
      ),
      integrationAccountId: fixture.integrationAccountId,
      proposalId,
      caseId: CASE_ID,
      target: { kind: "self_test", selfTestId: proposalId },
      currentVersion: 1,
      targetDigest: "1".repeat(64),
      subjectDigest: "2".repeat(64),
      bodyDigest: "3".repeat(64),
      snapshotDigest: SNAPSHOT,
      lifecycleKind: "awaiting_approval",
      providerMessageId: null,
      providerThreadId: null,
      indeterminateRfcMessageId: null,
      createdAt: NOW,
      now: NOW,
    }),
  ).toEqual({ ok: true, value: null });
  const approval = {
    version: 1,
    snapshotDigest: SNAPSHOT,
    challenge: "invalid-challenge",
  };
  const missing = await postSelfTestApproval(
    fixture,
    proposalId,
    "self-missing",
    approval,
  );
  expect(missing.status).toBe(422);
  const denied = await postSelfTestApproval(
    fixture,
    proposalId,
    "self-denied",
    { ...approval, selfTestOwnershipConfirmed: false },
  );
  expect(denied.status).toBe(422);
  const confirmed = await postSelfTestApproval(
    fixture,
    proposalId,
    "self-confirmed",
    { ...approval, selfTestOwnershipConfirmed: true },
  );
  expect(confirmed.status).toBe(409);
  await expect(confirmed.json()).resolves.toMatchObject({
    error: "email_reply_challenge_stale",
  });
  expect(fixture.connector.calls).toEqual([]);
  const preview = await handleControlRequest(
    new Request(
      `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/email-operational/${proposalId}`,
      { headers: sessionHeaders(fixture) },
    ),
    fixture.env,
  );
  expect(preview.status).toBe(200);
  const previewBody: unknown = await preview.json();
  if (
    typeof previewBody !== "object" ||
    previewBody === null ||
    !("challenge" in previewBody) ||
    typeof previewBody.challenge !== "string"
  ) {
    throw new Error("Missing approval challenge");
  }
  const confirmedApproval = {
    version: 1,
    snapshotDigest: SNAPSHOT,
    challenge: previewBody.challenge,
    selfTestOwnershipConfirmed: true,
  };
  const sent = await postSelfTestApproval(
    fixture,
    proposalId,
    "self-approved",
    confirmedApproval,
  );
  expect(sent.status).toBe(200);
  await expect(sent.json()).resolves.toMatchObject({
    kind: "sent",
    self_test_ownership_confirmed: true,
  });
  const replay = await postSelfTestApproval(
    fixture,
    proposalId,
    "self-approved",
    confirmedApproval,
  );
  expect(replay.status).toBe(200);
  expect(fixture.connector.calls.filter(isOperationalDispatch)).toHaveLength(1);
}

function isOperationalDispatch(call: ActorCall): boolean {
  return call.method === "dispatchEmailOperational";
}

async function postSelfTestApproval(
  fixture: Fixture,
  proposalId: string,
  key: string,
  body: unknown,
): Promise<Response> {
  return handleControlRequest(
    new Request(
      `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/email-operational/${proposalId}/approve`,
      {
        method: "POST",
        headers: {
          ...sessionHeaders(fixture),
          "content-type": "application/json",
          origin: ORIGIN,
          "x-pantry-csrf": fixture.csrfToken,
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      },
    ),
    fixture.env,
  );
}

async function queueTest(): Promise<void> {
  const fixture = await createFixture("queue");
  const operational = await projectEmailOperationalProposal({
    scope: await requireOrganisationExecutionScope(
      fixture.env,
      fixture.organisationId,
    ),
    integrationAccountId: fixture.integrationAccountId,
    proposalId: "proposal_operational_queue",
    caseId: "case_operational_queue",
    target: {
      kind: "supplier_contact",
      supplierId: "supplier_queue",
      contactId: "primary_email",
      contactRevision: 2,
    },
    currentVersion: 1,
    targetDigest: "1".repeat(64),
    subjectDigest: "2".repeat(64),
    bodyDigest: "3".repeat(64),
    snapshotDigest: "4".repeat(64),
    lifecycleKind: "awaiting_approval",
    providerMessageId: null,
    providerThreadId: null,
    indeterminateRfcMessageId: null,
    createdAt: NOW + 3,
    now: NOW + 3,
  });
  expect(operational).toEqual({ ok: true, value: null });
  const listed = await handleControlRequest(
    new Request(
      `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/email-reviews`,
      { headers: sessionHeaders(fixture) },
    ),
    fixture.env,
  );
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const body = (await listed.json()) as {
    readonly reviews: readonly Record<string, unknown>[];
  };
  expect(body.reviews).toHaveLength(2);
  const reply = body.reviews.find((review) => review.kind === "gmail_reply");
  expect(reply).toMatchObject({
    kind: "gmail_reply",
    proposal_id: PROPOSAL,
    version: 1,
    lifecycle_kind: "awaiting_approval",
    backing: { kind: "gmail_draft", gmail_thread_id: THREAD },
  });
  // The queue stores no content. It names the mail of a waiting draft only
  // from a live Gmail read, which this test does not serve.
  expect(Object.keys(reply ?? {}).sort()).toEqual([
    "backing",
    "case_id",
    "created_at",
    "headline",
    "integration_account_id",
    "kind",
    "lifecycle_kind",
    "proposal_id",
    "updated_at",
    "version",
  ]);
  expect(reply?.headline).toBeNull();
  const newMessage = body.reviews.find(
    (review) => review.kind === "operational_new_message",
  );
  expect(newMessage).toMatchObject({
    kind: "operational_new_message",
    proposal_id: "proposal_operational_queue",
    backing: {
      kind: "encrypted_connector",
      target: {
        kind: "supplier_contact",
        supplierId: "supplier_queue",
        contactId: "primary_email",
        contactRevision: 2,
      },
      snapshot_digest: "4".repeat(64),
      indeterminate_rfc_message_id: null,
    },
  });
}

async function staleTest(): Promise<void> {
  const fixture = await createFixture("stale");
  const preview = await handleControlRequest(
    getPreviewRequest(fixture),
    fixture.env,
  );
  const previewBody = (await preview.json()) as {
    readonly proposal: {
      readonly version: number;
      readonly snapshot_digest: string;
    };
    readonly challenge: string;
  };

  const tampered = await postReply(fixture, "approve", "approve-stale-01", {
    version: previewBody.proposal.version,
    snapshotDigest: previewBody.proposal.snapshot_digest,
    challenge: "f".repeat(64),
  });
  expect(tampered.status).toBe(409);
  await expect(tampered.json()).resolves.toMatchObject({
    error: "email_reply_challenge_stale",
  });
  expect(
    fixture.connector.calls.some(
      (call) => call.method === "dispatchReviewedEmailReply",
    ),
  ).toBe(false);

  fixture.connector.dispatchOutcome = {
    kind: "stale_approval",
    currentSnapshotDigest: "b".repeat(64),
  };
  const stale = await postReply(fixture, "approve", "approve-stale-02", {
    version: previewBody.proposal.version,
    snapshotDigest: previewBody.proposal.snapshot_digest,
    challenge: previewBody.challenge,
  });
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    error: "email_reply_approval_stale",
  });
}

async function invalidationTest(): Promise<void> {
  const fixture = await createFixture("invalidate");
  fixture.connector.previewOutcome = {
    kind: "invalidated",
    reason: "target_changed",
  };
  const preview = await handleControlRequest(
    getPreviewRequest(fixture),
    fixture.env,
  );
  expect(preview.status).toBe(200);
  await expect(preview.json()).resolves.toMatchObject({
    kind: "invalidated",
    reason: "target_changed",
  });
  const transition = fixture.caseActor.calls.find(
    (call) => call.method === "transitionEmailProposal",
  );
  expect(transition?.input).toMatchObject({
    lifecycle: { kind: "invalidated", reason: "target_changed" },
  });
  const projection = await readEmailReplyProposalProjection({
    db: fixture.db,
    organisationId: fixture.organisationId,
    proposalId: PROPOSAL,
  });
  expect(projection).toMatchObject({ lifecycleKind: "invalidated" });

  const unknown = await handleControlRequest(
    new Request(
      `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/email-replies/proposal_absent_missing`,
      { headers: sessionHeaders(fixture) },
    ),
    fixture.env,
  );
  expect(unknown.status).toBe(404);
}

type ActorCall = {
  readonly method: string;
  readonly input: Record<string, unknown>;
};

type FakeConnector = {
  readonly calls: ActorCall[];
  previewOutcome:
    | { readonly kind: "invalidated"; readonly reason: string }
    | { readonly kind: "proposal_missing" }
    | { readonly kind: "expired" }
    | null;
  previewVersion: number;
  previewSnapshotDigest: string;
  previewBodyEdited: boolean;
  dispatchOutcome: Record<string, unknown>;
  disposeOutcome: Record<string, unknown>;
  resolveOutcome: Record<string, unknown>;
};

type FakeCaseActor = { readonly calls: ActorCall[] };

type Fixture = {
  readonly env: UnitTestEnv;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly userId: UserId;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly connector: FakeConnector;
  readonly caseActor: FakeCaseActor;
};

function fakeConnectorNamespace(connector: FakeConnector): unknown {
  const stub = {
    async previewEmailOperationalProposal(input: Record<string, unknown>) {
      connector.calls.push({
        method: "previewEmailOperationalProposal",
        input,
      });
      return {
        ok: true,
        value: {
          kind: "current",
          preview: {
            proposalId: input.proposalId,
            version: 1,
            caseId: CASE_ID,
            integrationAccountId: input.integrationAccountId,
            target: { kind: "self_test", selfTestId: input.proposalId },
            sender: "sender@example.com",
            recipient: "owner@example.com",
            recipientDisplayName: null,
            subject: "Pantry Gmail canary",
            body: "This is a synthetic test of Pantry's email drafting and approval workflow. No action is required.",
            targetDigest: "1".repeat(64),
            snapshotDigest: SNAPSHOT,
            expiresAt: Date.now() + 60_000,
          },
        },
      };
    },
    async dispatchEmailOperational(input: Record<string, unknown>) {
      connector.calls.push({ method: "dispatchEmailOperational", input });
      return {
        ok: true,
        value: {
          kind: "sent",
          providerMessageId: "self-test-sent",
          providerThreadId: "self-test-thread",
          version: 1,
          snapshotDigest: SNAPSHOT,
        },
      };
    },
    async activate() {
      return { ok: true, value: { stateVersion: 1 } };
    },
    async previewEmailProposal(input: Record<string, unknown>) {
      connector.calls.push({ method: "previewEmailProposal", input });
      if (connector.previewOutcome !== null) {
        return { ok: true, value: connector.previewOutcome };
      }
      return {
        ok: true,
        value: {
          kind: "current",
          preview: {
            proposalId: PROPOSAL,
            baseVersion: 1,
            currentVersion: connector.previewVersion,
            bodyEdited: connector.previewBodyEdited,
            to: "customer@sender.example",
            subject: "Re: Order status?",
            threadId: THREAD,
            body: "Your order ships Monday.",
            targetDigest: "9".repeat(64),
            bodyDigest: "8".repeat(64),
            snapshotDigest: connector.previewSnapshotDigest,
            expiresAt: NOW + 86_400_000,
            state: "awaiting_approval",
            memory: [],
            sources: [],
          },
        },
      };
    },
    async authorizeEmailProposalDelivery() {
      return { ok: true, value: null };
    },
    async dispatchReviewedEmailReply(input: Record<string, unknown>) {
      connector.calls.push({ method: "dispatchReviewedEmailReply", input });
      return { ok: true, value: connector.dispatchOutcome };
    },
    async disposeEmailProposal(input: Record<string, unknown>) {
      connector.calls.push({ method: "disposeEmailProposal", input });
      return { ok: true, value: connector.disposeOutcome };
    },
    async resolveEmailProposal(input: Record<string, unknown>) {
      connector.calls.push({ method: "resolveEmailProposal", input });
      return { ok: true, value: connector.resolveOutcome };
    },
  };
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return namespace;
}

function fakeCaseNamespace(caseActor: FakeCaseActor): unknown {
  const stub = {
    async activate() {
      return { ok: true, value: { stateVersion: 1 } };
    },
    async transitionEmailProposal(input: Record<string, unknown>) {
      caseActor.calls.push({ method: "transitionEmailProposal", input });
      return { ok: true, value: null };
    },
    async readEmailProposals() {
      caseActor.calls.push({ method: "readEmailProposals", input: {} });
      return {
        ok: true,
        value: [
          {
            proposalId: PROPOSAL,
            version: 1,
            caseId: CASE_ID,
            threadId: THREAD,
            providerDraftId: "draft-1",
            providerDraftMessageId: "draft-msg-1",
            triggeringProviderMessageId: "m4",
            mailboxBindingId: "mailbox_binding_1",
            bindingRevision: 1,
            policyVersion: 1,
            targetDigest: "9".repeat(64),
            bodyDigest: "8".repeat(64),
            snapshotDigest: SNAPSHOT,
            createdAt: NOW,
            expiresAt: NOW + 86_400_000,
            lifecycle: { kind: "awaiting_approval" },
          },
        ],
      };
    },
    async acceptEmailProposal(input: Record<string, unknown>) {
      caseActor.calls.push({ method: "acceptEmailProposal", input });
      return { ok: true, value: null };
    },
  };
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return namespace;
}

/** These route fixtures have no shared draft. Its editing rules run in E2E. */
class EmptyMailDraftNamespace {
  idFromName(name: string) {
    return { name };
  }

  get() {
    return this;
  }

  jurisdiction() {
    return this;
  }

  async activate() {
    return { ok: true, value: { stateVersion: 1 } };
  }

  async mailReplyDraftApproval() {
    return { ok: false, error: { code: "organisation_not_initialized" } };
  }

  async closeMailReplyDraft() {
    return { ok: true, value: null };
  }
}

async function createFixture(slug: string): Promise<Fixture> {
  const db = createMigratedDatabase();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `${slug}-owner`,
      email: `${slug}@example.com`,
      displayName: `${slug} owner`,
      emailVerified: true,
    },
    now: NOW,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: `Email Reply ${slug}`,
    environment: "development",
    mutation: organisationBootstrapMutation(owner, NOW),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  await db
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'email-review-fixture', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    )
    .bind(NOW, NOW, organisation.organisationId)
    .run();
  const connected = await createConnectedIntegration(
    db,
    gmailSeed(
      organisation.organisationId,
      owner.userId,
      `R-${slug.toUpperCase()}`,
      NOW + 1,
    ),
  );
  await setIntegrationAccountLifecycle({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    lifecycle: { kind: "active" },
    now: NOW + 2,
  });
  const registered = await registerEmailMailboxAccount({
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    environment: "development",
    googleSubject: `google-sub-${slug}`,
    observedAddress: `owner-${slug}@example.com`,
    now: NOW + 3,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  const policy = defaultDenyPolicy({ now: NOW });
  policy.version = 1;
  policy.authz.allowedTools = [CAPABILITY_KEYS.emailMailboxRead];
  await db
    .prepare(
      "INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by) VALUES (?, 1, ?, ?, 'email-review-fixture')",
    )
    .bind(organisation.organisationId, JSON.stringify(policy), NOW)
    .run();
  const grant = await createAccessGrant({
    db,
    organisationId: organisation.organisationId,
    grantId: `grant_review_${slug}`,
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
      materializationReceiptId: "email-review-fixture",
    },
    now: NOW,
  });
  if (!grant.ok) throw new Error(grant.error.code);
  const projected = await projectEmailReplyProposal({
    scope: await requireOrganisationExecutionScope(
      platformEnv({
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      }),
      organisation.organisationId,
    ),
    integrationAccountId: connected.account.integrationAccountId,
    proposalId: PROPOSAL,
    caseId: CASE_ID,
    gmailThreadId: THREAD,
    currentVersion: 1,
    lifecycleKind: "awaiting_approval",
    now: NOW + 4,
  });
  if (!projected.ok) throw new Error(projected.error.code);
  const issued = await issueControlSession({
    db,
    userId: owner.userId,
    now: Date.now(),
    ttlMs: 3_600_000,
  });
  const connector: FakeConnector = {
    calls: [],
    previewOutcome: null,
    previewVersion: 1,
    previewSnapshotDigest: SNAPSHOT,
    previewBodyEdited: false,
    dispatchOutcome: {
      kind: "sent",
      providerMessageId: "sent-msg-1",
      version: 1,
      bodyDigest: "8".repeat(64),
      snapshotDigest: SNAPSHOT,
    },
    disposeOutcome: { kind: "deleted" },
    resolveOutcome: { kind: "no_action" },
  };
  const caseActor: FakeCaseActor = { calls: [] };
  const testEnv = platformEnv({
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DB: db,
    PANTRY_PUBLIC_ORIGIN: ORIGIN,
    SESSION_TOKEN_SECRET: "test-approval-hmac-secret",
    CONNECTOR: fakeConnectorNamespace(connector),
    CASE: fakeCaseNamespace(caseActor),
    ORGANISATION: new EmptyMailDraftNamespace(),
  });
  return {
    env: testEnv,
    db,
    organisationId: organisation.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    userId: owner.userId,
    sessionToken: issued.token,
    csrfToken: issued.csrfToken,
    connector,
    caseActor,
  };
}

async function postReply(
  fixture: Fixture,
  action: "approve" | "reject" | "resolve",
  idempotencyKey: string,
  body: unknown,
): Promise<Response> {
  return handleControlRequest(
    new Request(
      `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/email-replies/${PROPOSAL}/${action}`,
      {
        method: "POST",
        headers: {
          ...sessionHeaders(fixture),
          "content-type": "application/json",
          origin: ORIGIN,
          "x-pantry-csrf": fixture.csrfToken,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    ),
    fixture.env,
  );
}

function getPreviewRequest(fixture: Fixture): Request {
  return new Request(
    `${ORIGIN}/v1/control/organisations/${fixture.organisationId}/email-replies/${PROPOSAL}`,
    { headers: sessionHeaders(fixture) },
  );
}

function sessionHeaders(fixture: Fixture): Record<string, string> {
  return {
    cookie: `pantry_session=${fixture.sessionToken}; pantry_csrf=${fixture.csrfToken}`,
  };
}

function gmailSeed(
  organisationId: OrganisationId,
  userId: UserId,
  providerAccountId: string,
  now: number,
): ConnectedIntegrationSeed {
  return {
    organisationId,
    provider: "gmail",
    providerSubjectId: providerAccountId,
    environment: "development",
    authMode: "shared_pantry_app",
    authority: {
      kind: "connection_credential",
      credentialRef: requireVaultHandle(
        `vault:organisation:gmail:${providerAccountId.toLowerCase()}:oauth:g1`,
      ),
    },
    grantedScopes: GMAIL_FULL_MAILBOX_SCOPES,
    createdByUserId: userId,
    providerAccountId,
    accountKind: "mailbox",
    displayName: providerAccountId,
    capabilities: [CAPABILITY_KEYS.emailMailboxRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  };
}
