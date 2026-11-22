import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import {
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, vi, type TestContext } from "vitest";
import { isRecord, assertNever } from "@purin-labs/std";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { ConnectorDO } from "../../src/actors/connector";
import {
  latestOperationalEmailProposal,
  readOperationalEmailDispatchId,
} from "../../src/actors/connector-email-operational";
import { resumeActorRelocation } from "@purin-labs/actor-runtime/actors/actor-relocation";
import { reconcileActorRelocationMailReceipt } from "../../src/actors/actor-relocation-mail";
import {
  parseVaultHandle,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import { createActiveConnectedIntegration } from "@purin-labs/connections/data/integration-account";
import {
  registerEmailSenderAccount,
  registerOperationalEmailContact,
  readEmailOperationalProposalProjection,
  type EmailProposalTarget,
} from "../../src/data/email-operational";
import {
  EMAIL_SELF_TEST_SUBJECT,
  EMAIL_SELF_TEST_BODY,
  registerEmailSelfTest,
} from "../../src/data/email-self-test";
import { GMAIL_SEND_ONLY_SCOPES } from "@purin-labs/connections/mail/gmail-authorization";
import {
  CAPABILITY_KEYS,
  capabilityDefinitionById,
} from "@purin-labs/authority/authorization/capability-catalogue";
import {
  parseConnectorId,
  type ConnectorId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
} from "./slack-journey-support";
import { network } from "./network";
import {
  admitControlTurnFixture,
  requireOrganisationExecutionScope,
} from "../organisation-execution-fixture";
import {
  issueControlSession,
  readActiveOrganisationMembershipRevision,
} from "@purin-labs/tenancy/data/control-plane";
import { buildControlAuthority } from "@purin-labs/authority/request-authority/index";
import type { SessionTurnExecution } from "@purin-labs/conversation/chat/turn-access";
import { selfTestCount } from "./gmail-mailbox-support";
import {
  exportedItemCount,
  readBarrier,
  startMove,
} from "./placement-move-support";

const PROPOSAL_ID = "proposal_p55_operational";
const BODY = "Please prepare the bakery delivery for Friday.";
const EDITED_BODY = "Please prepare the bakery delivery for Saturday.";
const TOKEN = "fixture-p55-operational-token";
const SENDER = "bakery@example.com";
const TARGET = {
  kind: "supplier_contact",
  supplierId: "supplier_p55_operational",
  contactId: "contact_p55_operational",
  contactRevision: 1,
} as const;

type Boundary =
  | "create"
  | "preflight"
  | "sent"
  | "ambiguous"
  | "rejection"
  | "expiry"
  | "revoke"
  | "reject";
type Fixture = {
  readonly execution: SessionTurnExecution;
  readonly connector: DurableObjectStub<ConnectorDO>;
  readonly identity: {
    readonly organisationId: typeof ORGANISATION_ID;
    readonly connectorId: ConnectorId;
  };
  readonly integrationAccountId: IntegrationAccountId;
  readonly now: number;
  readonly target: EmailProposalTarget;
  readonly subject: string;
  readonly body: string;
  readonly expiresAt: number;
};
type Pause = {
  readonly boundary: Boundary;
  phase: "armed" | "paused" | "released";
  readonly decrypt: SubtleCrypto["decrypt"];
  readonly encrypt: SubtleCrypto["encrypt"];
  providerAttempts: number;
  rfcMessageId: string | null;
};
let activePause: Pause | null = null;

it.for([
  "create",
  "preflight",
  "sent",
  "ambiguous",
  "rejection",
  "expiry",
  "revoke",
  "reject",
] as const)(
  "drains operational compose at %s and recovers on the evicted target",
  { timeout: 100_000 },
  operationalJourney,
);

/**
 * An edit of an operational email that started from an older version is
 * refused (Refactor 15, refactor 8). Two people edit the same draft: the
 * first edit makes version 2, and the second, which started from version 1,
 * gets a conflict, so it does not replace the first one.
 */
it("refuses an operational email edit that started from an older version", async (test) => {
  const fixture = await installFixture();
  required(
    await fixture.connector.createEmailOperationalProposal(
      createRequest(fixture),
    ),
  );
  const first = await fixture.connector.editEmailOperationalProposal({
    ...baseRequest(fixture),
    subject: "Delivery request",
    body: EDITED_BODY,
    expectedVersion: 1,
  });
  expect(first).toMatchObject({ ok: true, value: { version: 2 } });
  const second = await fixture.connector.editEmailOperationalProposal({
    ...baseRequest(fixture),
    subject: "Delivery request",
    body: "A second edit that started from the first version.",
    expectedVersion: 1,
  });
  expect(second).toMatchObject({
    ok: false,
    error: { code: "operational_email_proposal_stale" },
  });
  const preview = required(
    await fixture.connector.previewEmailOperationalProposal(
      baseRequest(fixture),
    ),
  );
  expect(preview).toMatchObject({
    kind: "current",
    preview: { version: 2, body: EDITED_BODY },
  });
  Object.assign(test.task.meta, {
    operationalEditVersion: { first: 2, secondRefused: true },
  });
});

async function operationalJourney(
  boundary: Boundary,
  { task }: TestContext,
): Promise<void> {
  const fixture = await installFixture(boundary);
  if (boundary === "create") {
    await fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'configuring', activation_receipt_id = NULL, activated_at = NULL WHERE organisation_id = ?",
      )
      .bind(ORGANISATION_ID)
      .run();
    expect(
      await fixture.connector.createEmailOperationalProposal(
        createRequest(fixture),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "connector_execution_authority_inactive" },
    });
    expect(await runInDurableObject(fixture.connector, readProposalCount)).toBe(
      0,
    );
    await fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'activation_p55_operational', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(fixture.now, ORGANISATION_ID)
      .run();
  }
  if (boundary !== "create")
    required(
      await fixture.connector.createEmailOperationalProposal(
        createRequest(fixture),
      ),
    );
  const approval = await approvalRequest(fixture, boundary);
  if (boundary === "expiry")
    await runInDurableObject(fixture.connector, expireFixture);
  const pause: Pause = {
    boundary,
    phase: "armed",
    decrypt: crypto.subtle.decrypt,
    encrypt: crypto.subtle.encrypt,
    providerAttempts: 0,
    rfcMessageId: null,
  };
  activePause = pause;
  crypto.subtle.decrypt = pauseDecryption;
  crypto.subtle.encrypt = pauseEncryption;
  const withSession = fixtureDatabase().withSession.bind(fixtureDatabase());
  const sessionSpy = vi
    .spyOn(fixtureDatabase(), "withSession")
    .mockImplementation(interceptSession.bind(null, pause, withSession));
  network.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      gmailResponse.bind(null, pause),
    ),
  );
  const reservedMove = isIssuedBoundary(boundary) ? await startMove() : null;
  const work = startWork(boundary, fixture, approval);
  let completion: Promise<unknown> | null = null;
  try {
    await expect
      .poll(pausePhase.bind(null, pause), { timeout: 10_000 })
      .toBe("paused");
    const relocationId = reservedMove ?? (await startMove());
    completion = resumeActorRelocation({ env, relocationId, now: Date.now() });
    await expect
      .poll(readBarrier.bind(null, fixture.connector), { timeout: 10_000 })
      .toBe(1);
    expect(await exportedItemCount(relocationId)).toBe(0);
    expect(pause.providerAttempts).toBe(isIssuedBoundary(boundary) ? 1 : 0);
    if (isIssuedBoundary(boundary)) {
      const issued = await runInDurableObject(fixture.connector, readProposal);
      expect(issued).toMatchObject({
        state: "send_indeterminate",
        contentAvailable: false,
        rfcMessageId: pause.rfcMessageId,
      });
    }
    pause.phase = "released";
    const sourceResult = await work;
    if (boundary !== "expiry")
      expect(sourceResult).toMatchObject({
        ok: false,
        error: { code: "connector_placement_conflict" },
      });
    if (boundary === "ambiguous") {
      expect(await completion).toMatchObject({
        ok: false,
        error: { code: "relocation_provider_work_unresolved" },
      });
      expect(await exportedItemCount(relocationId)).toBe(0);
      const issued = await runInDurableObject(fixture.connector, readProposal);
      if (issued.rfcMessageId === null)
        throw new Error("Missing issued message identity");
      const receipt = {
        kind: "operational" as const,
        connectorId: fixture.identity.connectorId,
        integrationAccountId: fixture.integrationAccountId,
        proposalId: PROPOSAL_ID,
        version: issued.version,
        snapshotDigest: issued.snapshotDigest,
        rfcMessageId: issued.rfcMessageId,
        providerMessageId: "message_p55_operational",
        providerThreadId: "thread_p55_operational",
      };
      expect(
        await reconcileActorRelocationMailReceipt({
          env,
          relocationId,
          receipt: { ...receipt, rfcMessageId: "wrong-message-id" },
          now: Date.now(),
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "relocation_receipt_rejected" },
      });
      expect(
        await reconcileActorRelocationMailReceipt({
          env,
          relocationId,
          receipt,
          now: Date.now(),
        }),
      ).toEqual({ ok: true, value: null });
      expect(
        await reconcileActorRelocationMailReceipt({
          env,
          relocationId,
          receipt,
          now: Date.now(),
        }),
      ).toEqual({ ok: true, value: null });
      expect(
        await reconcileActorRelocationMailReceipt({
          env,
          relocationId,
          receipt: { ...receipt, providerMessageId: "conflicting-message" },
          now: Date.now(),
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "relocation_receipt_rejected" },
      });
      completion = resumeActorRelocation({
        env,
        relocationId,
        now: Date.now(),
      });
    }
    expect(await completion).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    // No source continuation publishes metadata after placement admission closes.
    const frozenProjection = await projection();
    expect(frozenProjection?.lifecycleKind ?? null).toBe(
      boundary === "create" ? null : "awaiting_approval",
    );
    if (boundary === "expiry")
      expect(await selfTestCount(ORGANISATION_ID)).toBe(1);
    await evictDurableObject(fixture.connector);
    expect(
      await fixture.connector.previewEmailOperationalProposal(
        baseRequest(fixture),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "connector_placement_conflict" },
    });
    const target = required(
      await resolveActiveConnectorActor({
        env,
        namespace: env.CONNECTOR,
        organisationId: ORGANISATION_ID,
        connectorId: fixture.identity.connectorId,
        now: Date.now(),
      }),
    );
    expect(await runInDurableObject(target, readProposalCount)).toBe(
      boundary === "create" ? 0 : 1,
    );
    await evictDurableObject(target);
    if (boundary === "create")
      required(
        await target.createEmailOperationalProposal(createRequest(fixture)),
      );
    if (boundary === "expiry") {
      await fixtureDatabase()
        .prepare(
          "CREATE TRIGGER p55_operational_cleanup_failure BEFORE DELETE ON email_self_test BEGIN SELECT RAISE(ABORT, 'cleanup_failed'); END",
        )
        .run();
      await runDurableObjectAlarm(target);
      expect((await projection())?.lifecycleKind).toBe("awaiting_approval");
      expect(await selfTestCount(ORGANISATION_ID)).toBe(1);
      await fixtureDatabase()
        .prepare("DROP TRIGGER p55_operational_cleanup_failure")
        .run();
      await evictDurableObject(target);
    }
    await runDurableObjectAlarm(target);
    if (boundary === "expiry")
      expect(await selfTestCount(ORGANISATION_ID)).toBe(0);
    const restored = await runInDurableObject(target, readProposal);
    const terminal =
      boundary === "expiry"
        ? "expired"
        : boundary === "revoke"
          ? "revoked"
          : boundary === "reject"
            ? "rejected"
            : null;
    expect(restored.state).toBe(
      terminal ??
        (boundary === "sent" || boundary === "ambiguous"
          ? "sent"
          : "awaiting_approval"),
    );
    if (terminal !== null || boundary === "sent" || boundary === "ambiguous")
      expect(restored.contentAvailable).toBe(false);
    if (terminal !== null) {
      expect((await projection())?.lifecycleKind).toBe(terminal);
      expect(await target.dispatchEmailOperational(approval)).toMatchObject({
        ok: false,
        error: { code: "operational_email_proposal_immutable" },
      });
    } else if (boundary === "ambiguous") {
      expect(restored.rfcMessageId).toBe(pause.rfcMessageId);
      await fixtureDatabase()
        .prepare(
          "UPDATE email_sender_account SET observed_address = 'changed@example.com' WHERE organisation_id = ?",
        )
        .bind(ORGANISATION_ID)
        .run();
      expect(await target.dispatchEmailOperational(approval)).toMatchObject({
        ok: true,
        value: { kind: "sent", providerMessageId: "message_p55_operational" },
      });
      expect((await projection())?.lifecycleKind).toBe("sent");
    } else {
      const preview = await target.previewEmailOperationalProposal(
        baseRequest(fixture),
      );
      if (boundary === "sent") {
        expect(preview).toMatchObject({
          ok: true,
          value: { kind: "content_unavailable" },
        });
      } else {
        expect(preview).toMatchObject({
          ok: true,
          value: {
            kind: "current",
            preview: { body: BODY },
          },
        });
      }
      const targetApproval =
        boundary === "sent" ? approval : await currentApproval(target, fixture);
      const sent = await target.dispatchEmailOperational(targetApproval);
      expect(sent, JSON.stringify(sent)).toMatchObject({
        ok: true,
        value: {
          kind: "sent",
          providerMessageId: "message_p55_operational",
          providerThreadId: "thread_p55_operational",
        },
      });
      expect((await projection())?.lifecycleKind).toBe("sent");
    }
    await evictDurableObject(target);
    await runDurableObjectAlarm(target);
    if (terminal === null) {
      const replayApproval =
        boundary === "ambiguous" || boundary === "sent"
          ? approval
          : await currentApprovalForReceipt(target, fixture);
      const replay = await target.dispatchEmailOperational(replayApproval);
      expect(replay).toMatchObject({
        ok: true,
        value: {
          kind: "sent",
        },
      });
    }
    expect(pause.providerAttempts).toBe(
      terminal !== null ? 0 : boundary === "rejection" ? 2 : 1,
    );
    const final = await runInDurableObject(target, readProposal);
    expect(final.contentAvailable).toBe(false);
    Object.assign(task.meta, {
      operationalMailPlacement: {
        boundary,
        exportedItemsWhilePaused: 0,
        sourceOutputWithheld: boundary !== "expiry",
        sourceProjectionWithheld: true,
        providerAttempts: pause.providerAttempts,
        retainedDispatchIdentity: final.rfcMessageId,
        recoveredState: final.state,
        projectionState: (await projection())?.lifecycleKind,
        contentPurged: !final.contentAvailable,
        selfTestCleanupRecovered: boundary === "expiry",
      },
    });
  } finally {
    pause.phase = "released";
    crypto.subtle.decrypt = pause.decrypt;
    crypto.subtle.encrypt = pause.encrypt;
    sessionSpy.mockRestore();
    activePause = null;
    await Promise.allSettled(completion === null ? [work] : [work, completion]);
  }
}

function isIssuedBoundary(boundary: Boundary): boolean {
  return (
    boundary === "sent" || boundary === "ambiguous" || boundary === "rejection"
  );
}
function startWork(
  boundary: Boundary,
  fixture: Fixture,
  approval: Awaited<ReturnType<typeof currentApproval>>,
) {
  switch (boundary) {
    case "create":
      return fixture.connector.createEmailOperationalProposal(
        createRequest(fixture),
      );
    case "preflight":
    case "sent":
    case "ambiguous":
    case "rejection":
      return fixture.connector.dispatchEmailOperational(approval);
    case "expiry":
      return runDurableObjectAlarm(fixture.connector);
    case "revoke":
      return fixture.connector.revokeEmailOperationalProposals({
        identity: fixture.identity,
        integrationAccountId: fixture.integrationAccountId,
        now: fixture.now,
      });
    case "reject":
      return fixture.connector.rejectEmailOperational(approval);
    default:
      return assertNever(boundary);
  }
}
function baseRequest(fixture: Fixture) {
  return {
    identity: fixture.identity,
    integrationAccountId: fixture.integrationAccountId,
    proposalId: PROPOSAL_ID,
    now: fixture.now,
  };
}
function createRequest(fixture: Fixture) {
  return {
    ...baseRequest(fixture),
    execution: fixture.execution,
    caseId: "case_p55_operational",
    target: fixture.target,
    subject: fixture.subject,
    body: fixture.body,
    policyVersion: capabilityDefinitionById(
      CAPABILITY_KEYS.emailOperationalPropose,
    ).capabilityVersion,
    expiresAt: fixture.expiresAt,
  };
}
async function approvalRequest(fixture: Fixture, boundary: Boundary) {
  if (boundary === "create")
    return {
      ...baseRequest(fixture),
      approvedVersion: 1,
      approvedSnapshotDigest: "0".repeat(64),
    };
  return currentApproval(fixture.connector, fixture);
}
async function currentApproval(
  connector: DurableObjectStub<ConnectorDO>,
  fixture: Fixture,
) {
  const preview = required(
    await connector.previewEmailOperationalProposal(baseRequest(fixture)),
  );
  if (preview.kind !== "current") throw new Error(JSON.stringify(preview));
  return {
    ...baseRequest(fixture),
    approvedVersion: preview.preview.version,
    approvedSnapshotDigest: preview.preview.snapshotDigest,
  };
}
async function currentApprovalForReceipt(
  connector: DurableObjectStub<ConnectorDO>,
  fixture: Fixture,
) {
  const record = await runInDurableObject(connector, readProposal);
  return {
    ...baseRequest(fixture),
    approvedVersion: record.version,
    approvedSnapshotDigest: record.snapshotDigest,
  };
}

async function pauseDecryption(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["decrypt"]>[0],
  key: Parameters<SubtleCrypto["decrypt"]>[1],
  data: Parameters<SubtleCrypto["decrypt"]>[2],
): Promise<ArrayBuffer> {
  const pause = activePause;
  if (pause === null) throw new Error("Missing operational pause");
  const opened = await pause.decrypt.call(this, algorithm, key, data);
  const text = new TextDecoder().decode(opened);
  if (
    pause.phase === "armed" &&
    pause.boundary === "preflight" &&
    text.includes(TOKEN)
  )
    await pauseWork(pause);
  return opened;
}
async function pauseEncryption(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["encrypt"]>[0],
  key: Parameters<SubtleCrypto["encrypt"]>[1],
  data: Parameters<SubtleCrypto["encrypt"]>[2],
): Promise<ArrayBuffer> {
  const pause = activePause;
  if (pause === null) throw new Error("Missing operational pause");
  const sealed = await pause.encrypt.call(this, algorithm, key, data);
  const text = new TextDecoder().decode(data);
  if (
    pause.phase === "armed" &&
    pause.boundary === "create" &&
    text.includes(BODY)
  )
    await pauseWork(pause);
  return sealed;
}
function interceptSession(
  pause: Pause,
  withSession: OrganisationDatabase["withSession"],
  constraint?: D1SessionBookmark | D1SessionConstraint,
): OrganisationDatabaseSession {
  const session = withSession(constraint);
  if (
    pause.phase === "armed" &&
    (pause.boundary === "expiry" ||
      pause.boundary === "revoke" ||
      pause.boundary === "reject")
  )
    vi.spyOn(session, "batch").mockImplementationOnce(
      pauseBatch.bind(null, pause, session.batch.bind(session)),
    );
  return session;
}
async function pauseBatch<T>(
  pause: Pause,
  batch: D1DatabaseSession["batch"],
  statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  if (pause.phase === "armed") await pauseWork(pause);
  return batch<T>(statements);
}
async function pauseWork(pause: Pause): Promise<void> {
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
}
async function gmailResponse(
  pause: Pause,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  const body: unknown = await request.json();
  if (!isRecord(body) || typeof body.raw !== "string")
    throw new Error("Missing immutable MIME");
  const mime = atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"));
  expect(mime).toContain(`From: ${SENDER}`);
  expect(mime).toContain("To: supplier@example.com");
  const encodedBody = mime.split("\r\n\r\n")[1];
  if (encodedBody === undefined) throw new Error("Missing MIME body");
  expect(atob(encodedBody)).toBe(BODY);
  const rfcMessageId = mime.match(/Message-ID: ([^\r\n]+)/i)?.[1];
  if (rfcMessageId === undefined) throw new Error("Missing dispatch identity");
  pause.rfcMessageId = rfcMessageId;
  pause.providerAttempts += 1;
  if (isIssuedBoundary(pause.boundary) && pause.phase === "armed")
    await pauseWork(pause);
  if (pause.boundary === "ambiguous")
    return new HttpResponse(null, { status: 503 });
  if (pause.boundary === "rejection" && pause.providerAttempts === 1)
    return new HttpResponse(null, { status: 400 });
  return HttpResponse.json({
    id: "message_p55_operational",
    threadId: "thread_p55_operational",
  });
}
function pausePhase(pause: Pause): Pause["phase"] {
  return pause.phase;
}
function expireFixture(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec(
    "UPDATE connector_email_operational_proposal SET expires_at = ? WHERE proposal_id = ?",
    Date.now() - 1,
    PROPOSAL_ID,
  );
}
function readProposalCount(_actor: unknown, state: DurableObjectState): number {
  return state.storage.sql
    .exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM connector_email_operational_proposal WHERE proposal_id = ?",
      PROPOSAL_ID,
    )
    .one().total;
}
function readProposal(_actor: unknown, state: DurableObjectState) {
  const record = latestOperationalEmailProposal(state.storage.sql, PROPOSAL_ID);
  if (record === null) throw new Error("Missing recovered proposal");
  return {
    state: record.state,
    version: record.version,
    snapshotDigest: record.snapshotDigest,
    contentAvailable: record.ciphertextB64 !== null || record.nonceB64 !== null,
    rfcMessageId: readOperationalEmailDispatchId(state.storage.sql, record),
  };
}
function projection() {
  return readEmailOperationalProposalProjection({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    proposalId: PROPOSAL_ID,
  });
}
function required<Value>(
  result: { ok: true; value: Value } | { ok: false; error: unknown },
): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function installFixture(boundary?: Boundary): Promise<Fixture> {
  await installSlackActorFixture();
  await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const now = Date.now();
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'activation_p55_operational', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    )
    .bind(now, now, ORGANISATION_ID)
    .run();
  const handle = required(parseVaultHandle("vault:p55-operational:gmail"));
  required(
    await storeVaultSecret({
      db: fixtureDatabase(),
      keys: env,
      organisationId: ORGANISATION_ID,
      handle,
      secret: {
        kind: "oauth_tokens",
        accessToken: TOKEN,
        refreshToken: "fixture-p55-operational-refresh",
        expiry: { kind: "expires", expiresAt: now + 3_600_000 },
      },
      now,
    }),
  );
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "gmail",
    authorizationProduct: "send_only",
    providerSubjectId: "google_p55_operational",
    environment: "development",
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef: handle },
    grantedScopes: GMAIL_SEND_ONLY_SCOPES,
    createdByUserId: required(
      parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab"),
    ),
    providerAccountId: "gmail_p55_operational",
    accountKind: "mailbox",
    displayName: "Bakery operational mail",
    capabilities: [CAPABILITY_KEYS.emailOperationalPropose],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const integrationAccountId = connected.account.integrationAccountId;
  required(
    await registerEmailSenderAccount({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      integrationAccountId,
      environment: "development",
      googleSubject: "google_p55_operational",
      observedAddress: SENDER,
      now,
    }),
  );
  required(
    await registerOperationalEmailContact({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      target: TARGET,
      address: "supplier@example.com",
      displayName: "Bakery supplier",
      state: "active",
      relationshipState: "active",
      now,
    }),
  );
  const identity: Fixture["identity"] = {
    organisationId: ORGANISATION_ID,
    connectorId: required(
      parseConnectorId(`connector_email_${integrationAccountId}`),
    ),
  };
  const connector = required(
    await resolveActiveConnectorActor({
      env,
      namespace: env.CONNECTOR,
      organisationId: ORGANISATION_ID,
      connectorId: identity.connectorId,
      now,
    }),
  );
  const userId = required(
    parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab"),
  );
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
  });
  if (membershipRevision === null)
    throw new Error("Missing fixture membership");
  const session = await issueControlSession({
    db: env.DB,
    userId,
    now,
    ttlMs: 1_800_000,
  });
  const execution = await admitControlTurnFixture(
    env,
    buildControlAuthority({
      organisationId: ORGANISATION_ID,
      userId,
      membershipRevision,
      requesterPersonId: "person_e2e-slack-actor",
      role: "operator",
    }).requestAuthority,
    session.session.controlSessionId,
  );
  const expiresAt = now + (boundary === "expiry" ? 900_000 : 3_600_000);
  const target =
    boundary === "expiry"
      ? required(
          await registerEmailSelfTest({
            scope: await requireOrganisationExecutionScope(
              env,
              ORGANISATION_ID,
            ),
            globalDatabase: env.DB,
            execution,
            integrationAccountId,
            proposalId: PROPOSAL_ID,
            caseId: "case_p55_operational",
            request: { kind: "self_test", address: SENDER },
            expiresAt,
            now,
          }),
        )
      : TARGET;
  return {
    execution,
    connector,
    identity,
    integrationAccountId,
    now,
    target,
    subject:
      boundary === "expiry" ? EMAIL_SELF_TEST_SUBJECT : "Delivery request",
    body: boundary === "expiry" ? EMAIL_SELF_TEST_BODY : BODY,
    expiresAt,
  };
}
