import { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import { parseOrganisationId } from "../src/ids";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { createActorExecutionBarrierSchema } from "../src/actors/actor-execution-quiescence";
import { describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  resolveConnectorGmailAccess: vi.fn(),
}));

vi.mock("../src/actors/connector-email-evaluation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/actors/connector-email-evaluation")
  >()),
  resolveConnectorGmailAccess: accessMocks.resolveConnectorGmailAccess,
}));

import {
  digestEmailBody,
  digestEmailSnapshot,
  digestGmailReplyTarget,
  deriveGmailReplyTarget,
} from "../src/mail/reply-target";
import type { GmailMessageHeaders } from "../src/mail/gmail-adapter";
import {
  activateEmailRuntime,
  createConnectorEmailSchema,
  readEmailDraftOperation,
  recordEmailDraftOperation,
  type EmailIngressLimits,
} from "../src/actors/connector-email";
import {
  dispatchEmailReply,
  disposeEmailProposal,
  previewEmailProposal,
  runEmailProposalMaintenance,
} from "../src/actors/connector-email-proposal";
import {
  EMAIL_MAINTENANCE_INTERVAL_MS,
  EMAIL_RESOLVE_GRACE_MS,
  nextEmailMaintenanceAt,
} from "../src/actors/connector-email";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const NOW = 1_784_016_325_277;
const ORGANISATION = "organisation_email_proposal";
const ACCOUNT = "integration_gmail_proposal";
const ADDRESS = "shop@example.com";
const PROPOSAL = "proposal_case_gmail_x_t1_m2";
const THREAD = "t1";
const TRIGGER = "m2";

describe("email proposal machinery", emailProposalSuite);

function emailProposalSuite(): void {
  it("invalidates trusted-target edits and missing drafts", invalidationTest);
  it(
    "does not resend while sent-message cleanup is pending",
    cleanupPendingDispatchTest,
  );
  it("disposes rejected proposals with typed cleanup states", disposalTest);
  it(
    "marks the send indeterminate before the wire so a crash cannot resend",
    crashMarkerTest,
  );
  it(
    "sweeps expired, indeterminate, and cleanup states on the alarm",
    maintenanceTest,
  );
}

/**
 * The claim precedes the wire. If the process dies between messages.send and
 * the sent write, the draft must already read send_indeterminate so the next
 * attempt reconciles by Message-ID instead of blindly sending again.
 */
async function crashMarkerTest(): Promise<void> {
  const state = world();
  const harness = await setup(state);
  const dispatched = await dispatchEmailReply({
    sql: harness.sql,
    scope: harness.scope,
    env: harness.env,
    proposalId: PROPOSAL,
    approvedVersion: 1,
    approvedSnapshotDigest: harness.snapshotDigest,
    now: NOW + 30,
    fetcher: harness.fetcher,
  });
  expect(dispatched.ok).toBe(true);
  expect(state.stateAtSend).toBe("send_indeterminate");
  expect(readEmailDraftOperation(harness.sql, PROPOSAL, 1)?.state).toBe("sent");

  // A rejection Gmail issued before accepting definitely did not send, so the
  // claim reverts and the proposal stays approvable.
  const rejectedState = world({ deleteOutcome: "ok" });
  const rejectedHarness = await setup(rejectedState);
  const rejectingFetcher = (async (request: RequestInfo | URL) => {
    const url = new URL(new Request(request as Request).url);
    if (url.pathname.endsWith("/messages/send"))
      return new Response("no", { status: 401 });
    return gmailFetcher(rejectedState, rejectedHarness.sql)(request as Request);
  }) as typeof fetch;
  const rejected = await dispatchEmailReply({
    sql: rejectedHarness.sql,
    scope: rejectedHarness.scope,
    env: rejectedHarness.env,
    proposalId: PROPOSAL,
    approvedVersion: 1,
    approvedSnapshotDigest: rejectedHarness.snapshotDigest,
    now: NOW + 30,
    fetcher: rejectingFetcher,
  });
  expect(rejected).toEqual({
    ok: false,
    error: { code: "gmail_unauthorized" },
  });
  expect(readEmailDraftOperation(rejectedHarness.sql, PROPOSAL, 1)?.state).toBe(
    "awaiting_approval",
  );
}

const passThroughLock = <T>(
  _proposalId: string,
  task: () => Promise<T>,
): Promise<T> => task();

/**
 * The unattended half of the lifecycle. An expired proposal's draft leaves the
 * organisation's Gmail without anyone opening the preview; an ambiguous send is
 * reconciled to sent; a failed cleanup is retried — and a pass that cannot
 * progress retries on the interval instead of hot-looping the alarm.
 */
async function maintenanceTest(): Promise<void> {
  // Expired proposal: draft disposed, projection told.
  const expiredState = world();
  const expiredHarness = await setup(expiredState);
  const afterExpiry = NOW + 86_400_000 + 60_000;
  const expiredRun = await runEmailProposalMaintenance({
    scope: expiredHarness.scope,
    sql: expiredHarness.sql,
    env: expiredHarness.env,
    now: afterExpiry,
    fetcher: expiredHarness.fetcher,
    withProposalLock: passThroughLock,
  });
  expect(expiredRun).toMatchObject({ ran: true, disposedExpired: 1 });
  expect(expiredState.deleted).toBe(true);
  expect(readEmailDraftOperation(expiredHarness.sql, PROPOSAL, 1)?.state).toBe(
    "deleted",
  );
  expect(
    await expiredHarness.scope.database
      .prepare(
        "SELECT lifecycle_kind AS lifecycle FROM email_reply_proposal WHERE proposal_id = ?",
      )
      .bind(PROPOSAL)
      .first(),
  ).toEqual({ lifecycle: "expired" });
  expect(
    nextEmailMaintenanceAt(expiredHarness.sql, afterExpiry + 1),
  ).toBeNull();

  // Indeterminate send: reconciled to sent by its dispatch Message-ID.
  const staleState = world({ sendOutcome: "network_error" });
  const staleHarness = await setup(staleState);
  await dispatchEmailReply({
    sql: staleHarness.sql,
    scope: staleHarness.scope,
    env: staleHarness.env,
    proposalId: PROPOSAL,
    approvedVersion: 1,
    approvedSnapshotDigest: staleHarness.snapshotDigest,
    now: NOW,
    fetcher: staleHarness.fetcher,
  });
  staleState.foundByMessageId = {
    messageId: "found-by-sweep",
    threadId: THREAD,
  };
  const staleRun = await runEmailProposalMaintenance({
    scope: staleHarness.scope,
    sql: staleHarness.sql,
    env: staleHarness.env,
    now: NOW + 10 * 60_000,
    fetcher: staleHarness.fetcher,
    withProposalLock: passThroughLock,
  });
  expect(staleRun).toMatchObject({ ran: true, resolvedSent: 1 });
  expect(readEmailDraftOperation(staleHarness.sql, PROPOSAL, 1)?.state).toBe(
    "sent",
  );
  expect(staleState.sentCount).toBe(1);

  // A pass that cannot progress retries once after the grace, then hourly.
  const stuckState = world({ deleteOutcome: "unavailable" });
  const stuckHarness = await setup(stuckState);
  const stuckRun = await runEmailProposalMaintenance({
    scope: stuckHarness.scope,
    sql: stuckHarness.sql,
    env: stuckHarness.env,
    now: afterExpiry,
    fetcher: stuckHarness.fetcher,
    withProposalLock: passThroughLock,
  });
  expect(stuckRun).toMatchObject({ ran: true, unresolved: 1 });
  // The failed disposal left cleanup_pending stamped at the pass time, so the
  // next natural attempt is one grace later — still in the future, so no
  // interval floor applies yet.
  expect(nextEmailMaintenanceAt(stuckHarness.sql, afterExpiry + 1)).toBe(
    afterExpiry + EMAIL_RESOLVE_GRACE_MS,
  );
  // Once the natural time passes, the floor holds retries to one per
  // interval: a pass inside the window declines to run, one after it runs.
  expect(
    nextEmailMaintenanceAt(
      stuckHarness.sql,
      afterExpiry + EMAIL_RESOLVE_GRACE_MS + 1,
    ),
  ).toBe(afterExpiry + EMAIL_MAINTENANCE_INTERVAL_MS);
  const insideWindow = await runEmailProposalMaintenance({
    scope: stuckHarness.scope,
    sql: stuckHarness.sql,
    env: stuckHarness.env,
    now: afterExpiry + EMAIL_RESOLVE_GRACE_MS + 1,
    fetcher: stuckHarness.fetcher,
    withProposalLock: passThroughLock,
  });
  expect(insideWindow.ran).toBe(false);
  const afterInterval = await runEmailProposalMaintenance({
    scope: stuckHarness.scope,
    sql: stuckHarness.sql,
    env: stuckHarness.env,
    now: afterExpiry + EMAIL_MAINTENANCE_INTERVAL_MS + 1,
    fetcher: stuckHarness.fetcher,
    withProposalLock: passThroughLock,
  });
  expect(afterInterval).toMatchObject({ ran: true, unresolved: 1 });
  const secondRun = await runEmailProposalMaintenance({
    scope: stuckHarness.scope,
    sql: stuckHarness.sql,
    env: stuckHarness.env,
    now: afterExpiry + 60_000,
    fetcher: stuckHarness.fetcher,
    withProposalLock: passThroughLock,
  });
  expect(secondRun.ran).toBe(false);
}

function sourceHeaders(): GmailMessageHeaders {
  return {
    messageIdHeader: "<origin@sender.example>",
    from: "Customer <customer@sender.example>",
    replyTo: null,
    subject: "Order status?",
    references: null,
    date: "Mon, 24 Aug 2026 10:00:00 +0000",
  };
}

type GmailWorld = {
  draftBody: string;
  draftTo: string;
  draftSubject: string;
  draftThreadId: string;
  draftPresent: boolean;
  draftHasAttachments: boolean;
  sendOutcome: "ok" | "network_error";
  stateAtSend: string | null;
  sentCount: number;
  deleteOutcome: "ok" | "unavailable" | "unauthorized";
  deleted: boolean;
  foundByMessageId: { messageId: string; threadId: string } | null;
};

function world(overrides: Partial<GmailWorld> = {}): GmailWorld {
  return {
    draftBody: "Your order ships Monday.",
    draftTo: "customer@sender.example",
    draftSubject: "Re: Order status?",
    draftThreadId: THREAD,
    draftPresent: true,
    draftHasAttachments: false,
    sendOutcome: "ok",
    stateAtSend: null,
    sentCount: 0,
    deleteOutcome: "ok",
    deleted: false,
    foundByMessageId: null,
    ...overrides,
  };
}

function gmailFetcher(
  state: GmailWorld,
  sql?: ReturnType<typeof sqlStorage>,
): typeof fetch {
  return (async (request: RequestInfo | URL) => {
    const normalized = new Request(request as Request);
    const url = new URL(normalized.url);
    if (url.pathname.endsWith("/messages/send")) {
      state.sentCount += 1;
      if (sql !== undefined) {
        state.stateAtSend =
          readEmailDraftOperation(sql, PROPOSAL, 1)?.state ?? null;
      }
      if (state.sendOutcome === "network_error") {
        return new Response("boom", { status: 503 });
      }
      return Response.json({ id: "sent-msg-1", threadId: THREAD });
    }
    if (url.pathname.includes("/drafts/") && normalized.method === "DELETE") {
      if (state.deleteOutcome === "unavailable")
        return new Response("later", { status: 503 });
      if (state.deleteOutcome === "unauthorized")
        return new Response("no", { status: 401 });
      state.deleted = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname.includes("/drafts/")) {
      if (!state.draftPresent) return new Response("gone", { status: 404 });
      return Response.json({
        id: "draft-1",
        message: {
          id: "draft-msg-1",
          threadId: state.draftThreadId,
          payload: {
            mimeType: "multipart/alternative",
            headers: [
              { name: "To", value: state.draftTo },
              { name: "Subject", value: state.draftSubject },
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: {
                  data: btoa(state.draftBody)
                    .replaceAll("+", "-")
                    .replaceAll("/", "_"),
                },
              },
              ...(state.draftHasAttachments
                ? [
                    {
                      mimeType: "application/pdf",
                      filename: "contract.pdf",
                      body: { attachmentId: "a1", size: 100 },
                    },
                  ]
                : []),
            ],
          },
        },
      });
    }
    if (url.pathname.endsWith(`/messages/${TRIGGER}`)) {
      return Response.json({
        id: TRIGGER,
        threadId: THREAD,
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Customer <customer@sender.example>" },
            { name: "Subject", value: "Order status?" },
            { name: "Message-ID", value: "<origin@sender.example>" },
            { name: "Date", value: "Mon, 24 Aug 2026 10:00:00 +0000" },
          ],
          body: {
            data: btoa("original question")
              .replaceAll("+", "-")
              .replaceAll("/", "_"),
          },
        },
      });
    }
    if (url.pathname.endsWith("/messages") && url.searchParams.has("q")) {
      return Response.json(
        state.foundByMessageId === null
          ? {}
          : {
              messages: [
                {
                  id: state.foundByMessageId.messageId,
                  threadId: state.foundByMessageId.threadId,
                },
              ],
            },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function limits(): EmailIngressLimits {
  return {
    maxActiveCases: 5,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 100_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
    debounce: { kind: "push_triggered", coalesceSeconds: 30 },
  };
}

async function setup(state: GmailWorld): Promise<{
  readonly sql: ReturnType<typeof sqlStorage>;
  readonly env: UnitTestEnv;
  readonly scope: OrganisationExecutionScope;
  readonly fetcher: typeof fetch;
  readonly snapshotDigest: string;
}> {
  accessMocks.resolveConnectorGmailAccess.mockResolvedValue({
    ok: true,
    value: "token",
  });
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createConnectorEmailSchema(sql);
  activateEmailRuntime(sql, {
    organisationId: ORGANISATION,
    integrationAccountId: ACCOUNT,
    policyVersion: 1,
    limits: limits(),
    activationFloor: "1000",
    watchExpiresAt: NOW + 86_400_000,
    now: NOW - 3_600_000,
  });
  const target = deriveGmailReplyTarget({
    accountAddress: ADDRESS,
    sourceMessageId: TRIGGER,
    threadId: THREAD,
    headers: sourceHeaders(),
    policyVersion: 1,
    expiresAt: NOW + 86_400_000,
  });
  if (!target.ok) throw new Error(target.error.code);
  const targetDigest = await digestGmailReplyTarget(target.value);
  const bodyDigest = await digestEmailBody("Your order ships Monday.");
  const snapshotDigest = await digestEmailSnapshot({
    targetDigest,
    bodyDigest,
    proposalId: PROPOSAL,
    version: 1,
  });
  recordEmailDraftOperation(sql, {
    proposalId: PROPOSAL,
    version: 1,
    caseId: "case_gmail_x_t1",
    threadId: THREAD,
    draftId: "draft-1",
    draftMessageId: "draft-msg-1",
    triggeringMessageId: TRIGGER,
    targetDigest,
    bodyDigest,
    snapshotDigest,
    policyVersion: 1,
    expiresAt: NOW + 86_400_000,
    now: NOW,
  });
  createActorExecutionBarrierSchema(sql);
  const db = createMigratedDatabase();
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'email-proposal', 'Email proposal', 0)",
    )
    .bind(ORGANISATION)
    .run();
  await db
    .prepare(
      "INSERT INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at) VALUES ('user_mail_proposal', 'fixture', 'proposal', 'owner@example.test', 'Owner', 1, 0, 0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO provider_connection (provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation, credential_ref, lifecycle, granted_scopes, created_by_user_id, created_at, updated_at) VALUES ('connection_mail_proposal', ?, 'gmail', 'shared_satyr_app', 'connection_credential', 1, 'vault:fixture', 'active', '[]', 'user_mail_proposal', 0, 0)",
    )
    .bind(ORGANISATION)
    .run();
  await db
    .prepare(
      "INSERT INTO integration_account (integration_account_id, organisation_id, provider_connection_id, provider, provider_account_id, account_kind, display_name, lifecycle, capability_set, audience_policy, retention_policy, created_at, updated_at) VALUES (?, ?, 'connection_mail_proposal', 'gmail', 'proposal', 'mailbox', 'Proposal', 'active', '[]', '{}', '{}', 0, 0)",
    )
    .bind(ACCOUNT, ORGANISATION)
    .run();
  await db
    .prepare(
      "INSERT INTO email_mailbox_account (integration_account_id, organisation_id, environment, google_subject, observed_address, address_observed_at) VALUES (?, ?, 'development', 'proposal', ?, 0)",
    )
    .bind(ACCOUNT, ORGANISATION, ADDRESS)
    .run();
  const organisation = parseOrganisationId(ORGANISATION);
  if (!organisation.ok) throw new Error(organisation.error.code);
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisation.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 0,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const env = platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const scope = await requireOrganisationExecutionScope(
    env,
    organisation.value,
  );
  return {
    sql,
    env,
    scope,
    fetcher: gmailFetcher(state, sql),
    snapshotDigest,
  };
}

async function invalidationTest(): Promise<void> {
  const state = world({ draftTo: "attacker@evil.example" });
  const harness = await setup(state);
  const preview = await previewEmailProposal({
    sql: harness.sql,
    scope: harness.scope,
    env: harness.env,
    proposalId: PROPOSAL,
    now: NOW + 10,
    fetcher: harness.fetcher,
  });
  expect(
    preview.ok &&
      preview.value.kind === "invalidated" &&
      preview.value.reason === "target_changed",
  ).toBe(true);
  expect(readEmailDraftOperation(harness.sql, PROPOSAL, 1)?.state).toBe(
    "invalidated",
  );

  const missingState = world({ draftPresent: false });
  const missingHarness = await setup(missingState);
  const missing = await previewEmailProposal({
    sql: missingHarness.sql,
    scope: missingHarness.scope,
    env: missingHarness.env,
    proposalId: PROPOSAL,
    now: NOW + 10,
    fetcher: missingHarness.fetcher,
  });
  expect(missing.ok && missing.value.kind === "proposal_missing").toBe(true);

  const attachedState = world({ draftHasAttachments: true });
  const attachedHarness = await setup(attachedState);
  const attached = await previewEmailProposal({
    sql: attachedHarness.sql,
    scope: attachedHarness.scope,
    env: attachedHarness.env,
    proposalId: PROPOSAL,
    now: NOW + 10,
    fetcher: attachedHarness.fetcher,
  });
  expect(
    attached.ok &&
      attached.value.kind === "invalidated" &&
      attached.value.reason === "unsupported_content",
  ).toBe(true);
}

async function cleanupPendingDispatchTest(): Promise<void> {
  const state = world({ deleteOutcome: "unavailable" });
  const harness = await setup(state);
  const first = await dispatchEmailReply({
    sql: harness.sql,
    scope: harness.scope,
    env: harness.env,
    proposalId: PROPOSAL,
    approvedVersion: 1,
    approvedSnapshotDigest: harness.snapshotDigest,
    now: NOW + 30,
    fetcher: harness.fetcher,
  });

  expect(first).toMatchObject({
    ok: true,
    value: { kind: "sent", providerMessageId: "sent-msg-1" },
  });
  expect(readEmailDraftOperation(harness.sql, PROPOSAL, 1)?.state).toBe(
    "cleanup_pending",
  );
  const second = await dispatchEmailReply({
    sql: harness.sql,
    scope: harness.scope,
    env: harness.env,
    proposalId: PROPOSAL,
    approvedVersion: 1,
    approvedSnapshotDigest: harness.snapshotDigest,
    now: NOW + 40,
    fetcher: harness.fetcher,
  });
  expect(second).toMatchObject({
    ok: true,
    value: { kind: "sent", providerMessageId: "sent-msg-1" },
  });
  expect(state.sentCount).toBe(1);
}

async function disposalTest(): Promise<void> {
  const retryable = world({ deleteOutcome: "unavailable" });
  const retryableHarness = await setup(retryable);
  const pending = await disposeEmailProposal({
    sql: retryableHarness.sql,
    scope: retryableHarness.scope,
    env: retryableHarness.env,
    proposalId: PROPOSAL,
    now: NOW + 30,
    fetcher: retryableHarness.fetcher,
  });
  expect(pending.ok && pending.value.kind === "cleanup_pending").toBe(true);
  expect(
    readEmailDraftOperation(retryableHarness.sql, PROPOSAL, 1)?.state,
  ).toBe("cleanup_pending");

  const permanent = world({ deleteOutcome: "unauthorized" });
  const permanentHarness = await setup(permanent);
  const unreachable = await disposeEmailProposal({
    sql: permanentHarness.sql,
    scope: permanentHarness.scope,
    env: permanentHarness.env,
    proposalId: PROPOSAL,
    now: NOW + 30,
    fetcher: permanentHarness.fetcher,
  });
  expect(
    unreachable.ok && unreachable.value.kind === "cleanup_unreachable",
  ).toBe(true);

  const clean = world();
  const cleanHarness = await setup(clean);
  const deleted = await disposeEmailProposal({
    sql: cleanHarness.sql,
    scope: cleanHarness.scope,
    env: cleanHarness.env,
    proposalId: PROPOSAL,
    now: NOW + 30,
    fetcher: cleanHarness.fetcher,
  });
  expect(deleted.ok && deleted.value.kind === "deleted").toBe(true);
  expect(readEmailDraftOperation(cleanHarness.sql, PROPOSAL, 1)?.state).toBe(
    "deleted",
  );
}
