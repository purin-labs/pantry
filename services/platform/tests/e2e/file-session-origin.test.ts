import { runFileContextReconciliation } from "../../src/context/files/reconciliation";
import { fixtureDatabase } from "./organisation-database";
import type { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { network } from "./network";
import {
  installSlackActorFixture,
  createRequiredGrant,
  openRouterToolCall,
  openRouterText,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import {
  parseSessionId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import {
  requireActiveOrganisationActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import {
  applyFileProjectionCommand,
  createFileProjectionCommand,
  replaceFileGrantAdmissions,
} from "../../src/context/files";
import {
  initializeFileGrantSync,
  claimFileGrantReconciliation,
  settleFileGrantReady,
  commitFileCursorAndOutbox,
  commitFileGrantReconciliation,
  commitFileGrantUnavailable,
  markFileProjectionOutboxDelivered,
  reserveFileExtractionBudget,
  scheduleFileReconciliationHint,
  upsertFileResourceSource,
} from "../../src/context/files/persistence";
import type {
  FileProjectionSourceReader,
  FileProjectionMetadata,
} from "../../src/context/files/projection";
import type { CanonicalFileReference } from "../../src/context/files/tools";
import { encodeContextVisibility } from "../../src/authorization/access-grants/visibility";

const TOKEN = "file-session-origin-fixture-token";
const REFRESHED_TOKEN = "file-session-origin-refreshed-token";
const FILE_ID = "p55-supplier-file";
const PROVIDER_TEXT = "P55 protected supplier delivery schedule.";
const SOURCE_NAME = "P55 supplier schedule.txt";
const GRANT_ID = "grant_p55_file_source";
const PROVIDER_REVISION = {
  kind: "gdrive",
  version: "1",
  modifiedTime: "2026-10-01T00:00:00.000Z",
  headRevisionId: "revision1",
} as const;
const METADATA: FileProjectionMetadata = {
  displayName: SOURCE_NAME,
  displayPath: SOURCE_NAME,
  deepLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
  mediaType: "text/plain",
  sourceBytes: new TextEncoder().encode(PROVIDER_TEXT).length,
  providerRevision: PROVIDER_REVISION,
  extraction: { kind: "text" },
};
type Boundary = "credential_commit" | "response" | "binding_commit";
type Journey = {
  readonly boundary: Boundary;
  readonly reference: CanonicalFileReference;
  readonly encrypt: SubtleCrypto["encrypt"];
  readonly digest: SubtleCrypto["digest"];
  phase: "armed" | "paused" | "released";
  providerRequests: number;
  bodyReads: number;
  modelRequests: number;
  toolIssued: boolean;
  discoveries: number;
  observationDigest: string;
  observationSetDigest: string;
};
let activeJourney: Journey | null = null;

type ReconciliationJourney = {
  readonly scope: OrganisationExecutionScope;
  freezeResponse: boolean;
  providerRequests: number;
};

it(
  "recovers scheduled file reconciliation after a provider response crosses freeze",
  { timeout: 45_000 },
  fileScheduledReconciliationJourney,
);

async function fileScheduledReconciliationJourney({
  task,
}: TestContext): Promise<void> {
  const { reference } = await fixture();
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const now = Date.now();
  const journey: ReconciliationJourney = {
    scope,
    freezeResponse: true,
    providerRequests: 0,
  };
  const scheduledEnv = {
    ...env,
    GDRIVE_OAUTH_CLIENT_ID: "p55-file-client",
    GDRIVE_OAUTH_CLIENT_SECRET: "p55-file-secret",
  };
  network.use(
    http.post(
      "https://oauth2.googleapis.com/token",
      scheduledFileToken.bind(null, journey),
    ),
    http.get(
      "https://www.googleapis.com/drive/v3/about",
      scheduledFileIdentity.bind(null, journey),
    ),
    http.get(
      "https://www.googleapis.com/drive/v3/changes/startPageToken",
      scheduledFileCursor.bind(null, journey),
    ),
    http.get(
      `https://www.googleapis.com/drive/v3/files/${FILE_ID}`,
      scheduledFileMetadata.bind(null, journey),
    ),
  );
  const original = await fileReconciliationSnapshot(
    reference.integrationAccountId,
  );
  await runFileContextReconciliation(scheduledEnv, now);
  expect(journey.providerRequests).toBe(4);
  expect(
    await fileReconciliationSnapshot(reference.integrationAccountId),
  ).toEqual(original);
  const frozenSync = await fileHintSnapshot(reference.integrationAccountId);
  expect(frozenSync).toMatchObject([{ state: "reconciling" }]);
  await runFileContextReconciliation(scheduledEnv, now + 120_001);
  expect(journey.providerRequests).toBe(4);
  expect(await fileHintSnapshot(reference.integrationAccountId)).toEqual(
    frozenSync,
  );
  for (const database of [env.DB, fixtureDatabase()])
    await database
      .prepare(
        "UPDATE organisation_placement SET status = 'active', frozen_at = NULL WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ?",
      )
      .bind(ORGANISATION_ID, scope.placement.placementEpoch, scope.fenceToken)
      .run();
  journey.freezeResponse = false;
  await runFileContextReconciliation(scheduledEnv, now + 120_002);
  expect(journey.providerRequests).toBe(8);
  expect(await fileHintSnapshot(reference.integrationAccountId)).toMatchObject([
    { state: "ready", lease_id: null },
  ]);
  const outbox = await fixtureDatabase()
    .prepare(
      "SELECT delivered_at FROM file_projection_outbox WHERE organisation_id = ? AND integration_account_id = ?",
    )
    .bind(ORGANISATION_ID, reference.integrationAccountId)
    .all();
  expect(outbox.results).toEqual([{ delivered_at: now + 120_002 }]);
  const completed = await fileReconciliationSnapshot(
    reference.integrationAccountId,
  );
  await runFileContextReconciliation(scheduledEnv, now + 120_003);
  expect(journey.providerRequests).toBe(8);
  expect(
    await fileReconciliationSnapshot(reference.integrationAccountId),
  ).toEqual(completed);
  Object.assign(task.meta, {
    fileReconciliationAcceptance: {
      frozenProviderRequests: 0,
      frozenSourceWrites: 0,
      retainedLease: true,
      resumedDeliveries: 1,
      duplicateProviderRequests: 0,
    },
  });
}

function scheduledFileToken(journey: ReconciliationJourney): Response {
  journey.providerRequests++;
  return HttpResponse.json({
    access_token: REFRESHED_TOKEN,
    expires_in: 3600,
    token_type: "Bearer",
  });
}

function scheduledFileIdentity(journey: ReconciliationJourney): Response {
  journey.providerRequests++;
  return HttpResponse.json({
    user: {
      permissionId: "p55-drive-owner",
      emailAddress: "owner@example.com",
      displayName: "Owner",
    },
  });
}

function scheduledFileCursor(journey: ReconciliationJourney): Response {
  journey.providerRequests++;
  return HttpResponse.json({ startPageToken: "p55-reconciliation-cursor" });
}

async function scheduledFileMetadata(
  journey: ReconciliationJourney,
): Promise<Response> {
  journey.providerRequests++;
  if (journey.freezeResponse) {
    for (const database of [env.DB, fixtureDatabase()])
      await database
        .prepare(
          "UPDATE organisation_placement SET status = 'frozen', frozen_at = ? WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ?",
        )
        .bind(
          Date.now(),
          ORGANISATION_ID,
          journey.scope.placement.placementEpoch,
          journey.scope.fenceToken,
        )
        .run();
  }
  return HttpResponse.json({
    id: FILE_ID,
    name: SOURCE_NAME,
    mimeType: "text/plain",
    size: String(METADATA.sourceBytes),
    version: PROVIDER_REVISION.version,
    modifiedTime: PROVIDER_REVISION.modifiedTime,
    headRevisionId: PROVIDER_REVISION.headRevisionId,
    trashed: false,
    webViewLink: METADATA.deepLink,
    parents: [],
  });
}

type ProjectionFreezeJourney = {
  readonly digest: SubtleCrypto["digest"];
  phase: "armed" | "paused" | "released";
  metadataReads: number;
  contentReads: number;
};

it(
  "withholds a prepared file projection across freeze and resumes an admitted retry",
  { timeout: 45_000 },
  fileProjectionFreezeJourney,
);

async function fileProjectionFreezeJourney({
  task,
}: TestContext): Promise<void> {
  const { reference } = await fixture();
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const now = Date.now();
  await initializeFileGrantSync({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: GRANT_ID,
    grantRevision: 1,
    integrationAccountId: reference.integrationAccountId,
    nextRunAt: now,
    now,
  });
  await fixtureDatabase()
    .prepare(
      `UPDATE file_resource_source
        SET source_sequence = 2, content_state = 'pending', content_digest = NULL,
            segment_count = NULL, metadata_only_reason = NULL
      WHERE organisation_id = ? AND integration_account_id = ? AND provider_file_id = ?`,
    )
    .bind(ORGANISATION_ID, reference.integrationAccountId, FILE_ID)
    .run();
  const command = createFileProjectionCommand({
    organisationId: ORGANISATION_ID,
    grantId: GRANT_ID,
    grantRevision: 1,
    integrationAccountId: reference.integrationAccountId,
    provider: "google_drive",
    providerFileId: FILE_ID,
    sourceSequence: 2,
    providerRevision: PROVIDER_REVISION,
    visibilityKey: "person:person_e2e-slack-actor",
  });
  expect(
    await claimFileGrantReconciliation({
      scope,
      grantId: GRANT_ID,
      leaseId: "projection-freeze-lease",
      startedAt: now,
      leaseExpiresAt: now + 60_000,
    }),
  ).toBe(true);
  const cursorWrite = {
    scope,
    integrationAccountId: reference.integrationAccountId,
    scopeKey: `gdrive_file:${FILE_ID}`,
    cursor: { kind: "gdrive", pageToken: "before-freeze" } as const,
    commands: [{ outboxId: "projection-freeze-outbox", command }],
    now,
  };
  expect(await commitFileCursorAndOutbox(cursorWrite)).toBe(true);
  const reconciliationBeforeFreeze = await fileReconciliationSnapshot(
    reference.integrationAccountId,
  );
  const journey: ProjectionFreezeJourney = {
    digest: crypto.subtle.digest,
    phase: "armed",
    metadataReads: 0,
    contentReads: 0,
  };
  const sourceReader = new ProjectionFreezeReader(journey);
  const previousProjection = await fileProjectionSnapshot(
    reference.integrationAccountId,
  );
  crypto.subtle.digest = pauseProjectionCommit.bind(null, journey);
  const pending = applyFileProjectionCommand({
    scope,
    command,
    sourceReader,
    now,
  });
  try {
    await expect
      .poll(projectionFreezePhase.bind(null, journey), { timeout: 15_000 })
      .toBe("paused");
    const budgetBeforeFreeze = await fileBudgetSnapshot(
      reference.integrationAccountId,
    );
    const hintBeforeFreeze = await fileHintSnapshot(
      reference.integrationAccountId,
    );
    for (const database of [env.DB, fixtureDatabase()])
      await database
        .prepare(
          `UPDATE organisation_placement SET status = 'frozen', frozen_at = ?
          WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'active'`,
        )
        .bind(
          now,
          ORGANISATION_ID,
          scope.placement.placementEpoch,
          scope.fenceToken,
        )
        .run();
    journey.phase = "released";
    expect(await pending).toEqual({
      kind: "retry",
      reason: "file_projection_authority_changed",
    });
    expect(
      await fileProjectionSnapshot(reference.integrationAccountId),
    ).toEqual(previousProjection);
    expect(
      await reserveFileExtractionBudget({
        scope,
        integrationAccountId: reference.integrationAccountId,
        utcDay: new Date(now).toISOString().slice(0, 10),
        sourceBytes: METADATA.sourceBytes,
        now: now + 1,
      }),
    ).toEqual({ kind: "inactive" });
    expect(
      await scheduleFileReconciliationHint({
        scope,
        integrationAccountId: reference.integrationAccountId,
        nextRunAt: now + 1,
      }),
    ).toBe(0);
    expect(await fileBudgetSnapshot(reference.integrationAccountId)).toEqual(
      budgetBeforeFreeze,
    );
    expect(await fileHintSnapshot(reference.integrationAccountId)).toEqual(
      hintBeforeFreeze,
    );
    expect(
      await applyFileProjectionCommand({
        scope,
        command,
        sourceReader,
        now: now + 2,
      }),
    ).toEqual({
      kind: "retry",
      reason: "organisation_execution_authority_inactive",
    });
    expect(
      await claimFileGrantReconciliation({
        scope,
        grantId: GRANT_ID,
        leaseId: "frozen-lease",
        startedAt: now + 60_001,
        leaseExpiresAt: now + 120_000,
      }),
    ).toBe(false);
    expect(
      await settleFileGrantReady({
        scope,
        grantId: GRANT_ID,
        leaseId: "projection-freeze-lease",
        reconciledAt: now + 1,
        nextRunAt: now + 60_000,
      }),
    ).toBe(false);
    expect(
      await commitFileCursorAndOutbox({
        ...cursorWrite,
        cursor: { kind: "gdrive", pageToken: "after-freeze" },
      }),
    ).toBe(false);
    expect(
      await commitFileGrantReconciliation({
        ...cursorWrite,
        grantId: GRANT_ID,
        grantRevision: 1,
        admissions: [],
      }),
    ).toBe(false);
    await commitFileGrantUnavailable({
      scope,
      grantId: GRANT_ID,
      integrationAccountId: reference.integrationAccountId,
      now,
    });
    expect(
      await markFileProjectionOutboxDelivered({
        scope,
        outboxId: "projection-freeze-outbox",
        deliveredAt: now + 1,
      }),
    ).toBe(false);
    expect(
      await upsertFileResourceSource({
        scope,
        metadata: {
          ...reference,
          providerRevision: PROVIDER_REVISION,
          displayName: "frozen replacement",
          displayPath: SOURCE_NAME,
          mediaType: "text/plain",
          deepLink: METADATA.deepLink,
          observedAt: now + 1,
        },
        now: now + 1,
      }),
    ).toEqual({
      ok: false,
      error: { code: "organisation_execution_authority_inactive" },
    });
    expect(
      await fileReconciliationSnapshot(reference.integrationAccountId),
    ).toEqual(reconciliationBeforeFreeze);
    expect(await fileHintSnapshot(reference.integrationAccountId)).toEqual(
      hintBeforeFreeze,
    );
    expect(
      await fileProjectionSnapshot(reference.integrationAccountId),
    ).toEqual(previousProjection);
    expect(journey.metadataReads).toBe(1);
    expect(journey.contentReads).toBe(1);
    for (const database of [env.DB, fixtureDatabase()])
      await database
        .prepare(
          `UPDATE organisation_placement SET status = 'active', frozen_at = NULL
          WHERE organisation_id = ? AND placement_epoch = ? AND fence_token = ? AND status = 'frozen'`,
        )
        .bind(ORGANISATION_ID, scope.placement.placementEpoch, scope.fenceToken)
        .run();
    const resumed = await requireOrganisationExecutionScope(
      env,
      ORGANISATION_ID,
    );
    expect(
      await applyFileProjectionCommand({
        scope: resumed,
        command,
        sourceReader,
        now: now + 3,
      }),
    ).toEqual({
      kind: "applied",
      segmentCount: 1,
    });
    expect(
      await applyFileProjectionCommand({
        scope: resumed,
        command,
        sourceReader,
        now: now + 4,
      }),
    ).toEqual({
      kind: "duplicate",
      segmentCount: 1,
    });
    expect(journey.metadataReads).toBe(2);
    expect(journey.contentReads).toBe(2);
    expect(
      await markFileProjectionOutboxDelivered({
        scope: resumed,
        outboxId: "projection-freeze-outbox",
        deliveredAt: now + 4,
      }),
    ).toBe(true);
    expect(
      await markFileProjectionOutboxDelivered({
        scope: resumed,
        outboxId: "projection-freeze-outbox",
        deliveredAt: now + 5,
      }),
    ).toBe(false);
    expect(
      await settleFileGrantReady({
        scope: resumed,
        grantId: GRANT_ID,
        leaseId: "projection-freeze-lease",
        reconciledAt: now + 5,
        nextRunAt: now + 60_000,
      }),
    ).toBe(true);
    Object.assign(task.meta, {
      filePlacementAcceptance: {
        preparedProjectionWithheld: true,
        frozenBudgetWrites: 0,
        frozenReconciliationWrites: 0,
        frozenCursorAndOutboxWrites: 0,
        resumedOutboxReceipts: 1,
        frozenProviderReads: 0,
        resumedSegmentCount: 1,
        duplicateProviderReads: 0,
      },
    });
  } finally {
    journey.phase = "released";
    crypto.subtle.digest = journey.digest;
    await pending;
  }
}

class ProjectionFreezeReader implements FileProjectionSourceReader {
  constructor(private readonly journey: ProjectionFreezeJourney) {}

  async readMetadata(): ReturnType<FileProjectionSourceReader["readMetadata"]> {
    this.journey.metadataReads += 1;
    return { ok: true, value: METADATA };
  }

  async readTextContent(): ReturnType<
    FileProjectionSourceReader["readTextContent"]
  > {
    this.journey.contentReads += 1;
    return { ok: true, value: new TextEncoder().encode(PROVIDER_TEXT) };
  }
}

function projectionFreezePhase(
  journey: ProjectionFreezeJourney,
): ProjectionFreezeJourney["phase"] {
  return journey.phase;
}

async function pauseProjectionCommit(
  journey: ProjectionFreezeJourney,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const result = await journey.digest.call(crypto.subtle, algorithm, data);
  if (
    journey.phase === "armed" &&
    new TextDecoder().decode(data) === PROVIDER_TEXT
  ) {
    journey.phase = "paused";
    while (journey.phase === "paused") await scheduler.wait(5);
  }
  return result;
}

async function fileProjectionSnapshot(
  integrationAccountId: IntegrationAccountId,
) {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT source_revision, lifecycle, content_digest, bounded_text
       FROM context_projection WHERE organisation_id = ? AND source_kind = 'file_segment'
        AND json_extract(source_json, '$.integrationAccountId') = ? ORDER BY source_key`,
    )
    .bind(ORGANISATION_ID, integrationAccountId)
    .all();
  return rows.results;
}

async function fileBudgetSnapshot(integrationAccountId: IntegrationAccountId) {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT utc_day, admitted_source_bytes, maximum_source_bytes, updated_at
       FROM file_extraction_budget WHERE organisation_id = ? AND integration_account_id = ? ORDER BY utc_day`,
    )
    .bind(ORGANISATION_ID, integrationAccountId)
    .all();
  return rows.results;
}

async function fileReconciliationSnapshot(
  integrationAccountId: IntegrationAccountId,
) {
  const results = await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "SELECT * FROM file_resource_source WHERE organisation_id = ? AND integration_account_id = ? ORDER BY provider_file_id",
      )
      .bind(ORGANISATION_ID, integrationAccountId),
    fixtureDatabase()
      .prepare(
        "SELECT * FROM file_grant_admission WHERE organisation_id = ? AND integration_account_id = ? ORDER BY grant_id, provider_file_id",
      )
      .bind(ORGANISATION_ID, integrationAccountId),
    fixtureDatabase()
      .prepare(
        "SELECT * FROM file_provider_cursor WHERE organisation_id = ? AND integration_account_id = ? ORDER BY scope_key",
      )
      .bind(ORGANISATION_ID, integrationAccountId),
    fixtureDatabase()
      .prepare(
        "SELECT * FROM file_projection_outbox WHERE organisation_id = ? AND integration_account_id = ? ORDER BY outbox_id",
      )
      .bind(ORGANISATION_ID, integrationAccountId),
  ]);
  return results.map(fileRows);
}

function fileRows(result: D1Result) {
  return result.results;
}

async function fileHintSnapshot(integrationAccountId: IntegrationAccountId) {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT state, lease_id, lease_expires_at, started_at, next_run_at, updated_at
       FROM file_grant_sync WHERE organisation_id = ? AND integration_account_id = ? ORDER BY grant_id`,
    )
    .bind(ORGANISATION_ID, integrationAccountId)
    .all();
  return rows.results;
}

it.for(["credential_commit", "response", "binding_commit"] as const)(
  "fences file %s, preserves origin after eviction and admits a fresh command",
  { timeout: 45_000 },
  fileOriginJourney,
);

async function fileOriginJourney(
  boundary: Boundary,
  { task }: TestContext,
): Promise<void> {
  const { reference, session, fresh } = await fixture();
  const journey: Journey = {
    boundary,
    reference,
    encrypt: crypto.subtle.encrypt,
    digest: crypto.subtle.digest,
    phase: "armed",
    providerRequests: 0,
    bodyReads: 0,
    modelRequests: 0,
    toolIssued: false,
    discoveries: 0,
    observationDigest: "",
    observationSetDigest: "",
  };
  activeJourney = journey;
  crypto.subtle.encrypt = pauseCredentialCommit;
  crypto.subtle.digest = pauseObservation;
  const initialSecret = await savedCredential();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      respondToModel.bind(null, journey),
    ),
    http.post(
      "https://oauth2.googleapis.com/token",
      refreshCredential.bind(null, journey),
    ),
    http.get(
      "https://www.googleapis.com/drive/v3/about",
      readIdentity.bind(null, journey),
    ),
    http.get(
      `https://www.googleapis.com/drive/v3/files/${FILE_ID}`,
      readProviderFile.bind(null, journey),
    ),
  );
  const key = `p55_file_${boundary}`;
  const pending = dispatch(session, key);
  try {
    await expect
      .poll(currentPhase.bind(null, journey), { timeout: 15_000 })
      .toBe("paused");
    const actor = await sessionActor(session);
    const admittedRequests = journey.modelRequests;
    const issuedRequests = journey.providerRequests;
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    journey.phase = "released";
    const denied = await pending;
    expect(denied.status, await denied.clone().text()).toBe(503);
    expect(await denied.text()).not.toContain(PROVIDER_TEXT);
    expect(journey.modelRequests).toBe(admittedRequests);
    expect(journey.providerRequests).toBe(issuedRequests);
    expect(issuedRequests).toBe(
      boundary === "credential_commit" ? 2 : boundary === "response" ? 5 : 0,
    );
    if (boundary === "credential_commit")
      expect(await savedCredential()).toEqual(initialSecret);
    const retained = await runInDurableObject(
      actor,
      retainedFileState.bind(null, reference.integrationAccountId),
    );
    expect(retained.providerObservations).toBe(0);
    expect(retained.history).not.toContain(PROVIDER_TEXT);
    expect(retained.history).not.toContain(SOURCE_NAME);
    await evictDurableObject(actor);
    expect(
      await runInDurableObject(
        actor,
        retainedFileState.bind(null, reference.integrationAccountId),
      ),
    ).toEqual(retained);
    expect((await dispatch(fresh, key)).status).toBe(503);
    expect(journey.providerRequests).toBe(issuedRequests);
    journey.toolIssued = false;
    const allowed = await dispatch(fresh, `${key}_fresh`);
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    await allowed.arrayBuffer();
    const freshActor = await sessionActor(fresh);
    const accepted = await runInDurableObject(
      freshActor,
      retainedFileState.bind(null, reference.integrationAccountId),
    );
    expect(accepted.providerObservations).toBe(1);
    expect(accepted.history).toContain(PROVIDER_TEXT);
    expect(journey.bodyReads).toBe(
      boundary === "binding_commit" ? 0 : boundary === "response" ? 2 : 1,
    );
    Object.assign(task.meta, {
      fileOriginAcceptance: {
        boundary,
        issuedRequestsBeforeRevocation: issuedRequests,
        requestsAfterRevocation: 0,
        revokedObservations: 0,
        credentialCommitWithheld: boundary === "credential_commit",
        historyWithheld: true,
        evictedStateRetained: true,
        duplicateProviderRequests: 0,
        authorizedFreshObservations: accepted.providerObservations,
      },
    });
  } finally {
    journey.phase = "released";
    crypto.subtle.encrypt = journey.encrypt;
    crypto.subtle.digest = journey.digest;
    activeJourney = null;
    await pending;
  }
}
function currentPhase(journey: Journey) {
  return journey.phase;
}
async function waitForRelease(journey: Journey): Promise<void> {
  journey.phase = "paused";
  while (journey.phase === "paused") await scheduler.wait(5);
}
async function pauseCredentialCommit(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["encrypt"]>[0],
  key: Parameters<SubtleCrypto["encrypt"]>[1],
  data: Parameters<SubtleCrypto["encrypt"]>[2],
): Promise<ArrayBuffer> {
  const journey = activeJourney;
  if (journey === null) throw new Error("Missing file journey");
  const result = await journey.encrypt.call(this, algorithm, key, data);
  if (
    journey.phase === "armed" &&
    journey.boundary === "credential_commit" &&
    new TextDecoder().decode(data).includes(REFRESHED_TOKEN)
  )
    await waitForRelease(journey);
  return result;
}
async function pauseObservation(
  this: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: Parameters<SubtleCrypto["digest"]>[1],
): Promise<ArrayBuffer> {
  const journey = activeJourney;
  if (journey === null) throw new Error("Missing file journey");
  const result = await journey.digest.call(this, algorithm, data);
  if (journey.phase !== "armed" || journey.boundary !== "binding_commit")
    return result;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return result;
  }
  const evidence =
    isRecord(raw) &&
    isRecord(raw.source) &&
    raw.source.kind === "integration_resource" &&
    raw.source.integrationAccountId ===
      journey.reference.integrationAccountId &&
    typeof raw.contentDigest === "string";
  if (evidence && journey.boundary === "binding_commit")
    journey.observationDigest = Array.from(
      new Uint8Array(result),
      hexByte,
    ).join("");
  if (
    journey.boundary === "binding_commit" &&
    journey.observationDigest.length > 0 &&
    Array.isArray(raw) &&
    raw.includes(journey.observationDigest)
  )
    journey.observationSetDigest = Array.from(
      new Uint8Array(result),
      hexByte,
    ).join("");
  if (
    journey.boundary === "binding_commit" &&
    journey.observationDigest.length > 0 &&
    isRecord(raw) &&
    journey.observationSetDigest.length > 0 &&
    raw.observationSetDigest === journey.observationSetDigest
  )
    await waitForRelease(journey);
  return result;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}
async function respondToModel(
  journey: Journey,
  request: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  journey.modelRequests++;
  const raw: unknown = await request.request.json();
  if (!isRecord(raw) || !Array.isArray(raw.tools))
    throw new Error("Missing file tools");
  // Configure only the native Actor's provider fixture. Authority and persistence stay real.
  const origin = await fixtureDatabase()
    .prepare(
      "SELECT control_session_id FROM session_turn_access WHERE organisation_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(ORGANISATION_ID)
    .first<{ control_session_id: string }>();
  if (origin === null) throw new Error("Missing file origin");
  const actor = await sessionActorByOrigin(origin.control_session_id);
  await runInDurableObject(actor, installProviderConfiguration);
  if (journey.toolIssued)
    return openRouterText(
      JSON.stringify({ kind: "reply", text: "File request completed." }),
      "p55_file_done",
    );
  const name =
    journey.boundary === "binding_commit" ? "file_search" : "file_read";
  if (!raw.tools.some(toolHasName.bind(null, name))) {
    if (++journey.discoveries > 8)
      throw new Error("File discovery did not complete");
    return openRouterToolCall(
      "tool_search",
      { query: name, limit: 1 },
      `discover_file_${journey.discoveries}`,
    );
  }
  journey.toolIssued = true;
  return openRouterToolCall(
    name,
    name === "file_read"
      ? { reference: journey.reference, startSegment: 0 }
      : { query: "protected supplier delivery schedule", limit: 5 },
    "p55_file_read",
  );
}
function toolHasName(name: string, raw: unknown): boolean {
  return isRecord(raw) && isRecord(raw.function) && raw.function.name === name;
}
function installProviderConfiguration(actor: object): void {
  const bindings = Reflect.get(actor, "env");
  if (!isRecord(bindings)) throw new Error("Missing Actor bindings");
  Object.defineProperty(bindings, "GDRIVE_OAUTH_CLIENT_ID", {
    configurable: true,
    value: "p55-file-client",
  });
  Object.defineProperty(bindings, "GDRIVE_OAUTH_CLIENT_SECRET", {
    configurable: true,
    value: "p55-file-secret",
  });
}
async function refreshCredential(journey: Journey): Promise<Response> {
  journey.providerRequests++;
  return HttpResponse.json({
    access_token: REFRESHED_TOKEN,
    expires_in: 3600,
    token_type: "Bearer",
  });
}
async function readIdentity(journey: Journey): Promise<Response> {
  journey.providerRequests++;
  return HttpResponse.json({
    user: {
      permissionId: "p55-drive-owner",
      emailAddress: "owner@example.com",
      displayName: "Owner",
    },
  });
}
async function readProviderFile(
  journey: Journey,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  journey.providerRequests++;
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${REFRESHED_TOKEN}`,
  );
  if (new URL(request.url).searchParams.get("alt") === "media") {
    journey.bodyReads++;
    if (journey.phase === "armed" && journey.boundary === "response")
      await waitForRelease(journey);
    return new HttpResponse(PROVIDER_TEXT, {
      headers: { "content-type": "text/plain" },
    });
  }
  return HttpResponse.json({
    id: FILE_ID,
    name: SOURCE_NAME,
    mimeType: "text/plain",
    size: String(METADATA.sourceBytes),
    version: PROVIDER_REVISION.version,
    modifiedTime: PROVIDER_REVISION.modifiedTime,
    headRevisionId: PROVIDER_REVISION.headRevisionId,
    trashed: false,
    webViewLink: METADATA.deepLink,
    parents: [],
  });
}
async function savedCredential() {
  return fixtureDatabase()
    .prepare(
      "SELECT ciphertext_b64, rotated_at FROM vault_secret WHERE organisation_id = ? AND vault_handle = 'vault:gdrive:p55-origin'",
    )
    .bind(ORGANISATION_ID)
    .first();
}
function retainedFileState(
  accountId: IntegrationAccountId,
  _actor: unknown,
  state: DurableObjectState,
) {
  return {
    history: JSON.stringify(
      state.storage.sql.exec("SELECT * FROM session_harness_history").toArray(),
    ),
    providerObservations: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_information_flow_observation WHERE json_extract(evidence_json, '$.source.kind') = 'integration_resource' AND json_extract(evidence_json, '$.source.integrationAccountId') = ?",
        accountId,
      )
      .one().count,
  };
}
function sessionActor(session: IssuedControlSession) {
  return sessionActorByOrigin(session.session.controlSessionId);
}
async function sessionActorByOrigin(controlSessionId: string) {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT session_id FROM session_turn_access WHERE organisation_id = ? AND control_session_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(ORGANISATION_ID, controlSessionId)
    .first<{ session_id: string }>();
  if (row === null) throw new Error("Missing file Session");
  const id = parseSessionId(row.session_id);
  if (!id.ok) throw new Error(id.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: id.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  return actor.value;
}
function dispatch(
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
      body: JSON.stringify({
        instruction: "Inspect the operator's granted document.",
      }),
    },
  );
}
async function fixture() {
  await installSlackActorFixture();
  const user = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  const handle = parseVaultHandle("vault:gdrive:p55-origin");
  if (!user.ok || !handle.ok) throw new Error("Invalid file fixture identity");
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_p55_file', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(now, ORGANISATION_ID),
  ]);
  const secret = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    handle: handle.value,
    secret: {
      kind: "oauth_tokens",
      accessToken: TOKEN,
      refreshToken: TOKEN,
      expiry: { kind: "provider_managed" },
    },
    now,
  });
  if (!secret.ok) throw new Error(secret.error.code);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    provider: "google_drive",
    providerSubjectId: "p55-drive-owner",
    environment: "development",
    authMode: "shared_pantry_app",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: ["https://www.googleapis.com/auth/drive.file"],
    createdByUserId: user.value,
    providerAccountId: "p55-drive-owner",
    accountKind: "account",
    displayName: "P55 supplier files",
    capabilities: ["file.read"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const reference: CanonicalFileReference = {
    integrationAccountId: connected.account.integrationAccountId,
    provider: "google_drive",
    providerFileId: FILE_ID,
  };
  await createRequiredGrant({
    grantId: "grant_p55_file_context",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: "context.case.read",
      capabilityVersion: 1,
    },
    now,
  });
  await createRequiredGrant({
    grantId: GRANT_ID,
    subject: { kind: "person", personId: "person_e2e-slack-actor" },
    target: {
      kind: "file_resource",
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: reference.integrationAccountId,
      scope: {
        kind: "gdrive_file",
        providerFileId: FILE_ID,
        name: SOURCE_NAME,
      },
    },
    now,
  });
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const enabled = await writeOrganisationCapabilityPolicy({
    scope,
    write: {
      kind: "change",
      capabilityId: "file.read",
      expectedRevision: 1,
      mode: "enabled",
      provenance: {
        kind: "operator",
        userId: user.value,
        mutationReceiptId: "receipt_p55_file_read",
      },
      now,
    },
  });
  if (!enabled.ok) throw new Error(enabled.error.code);
  await replaceFileGrantAdmissions({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: GRANT_ID,
    grantRevision: 1,
    admissions: [
      {
        grantId: GRANT_ID,
        grantRevision: 1,
        ...reference,
        containingScopeKey: `gdrive_file:${FILE_ID}`,
        providerRevision: PROVIDER_REVISION,
      },
    ],
    admittedAt: now,
  });
  await upsertFileResourceSource({
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    metadata: {
      ...reference,
      providerRevision: PROVIDER_REVISION,
      displayName: SOURCE_NAME,
      displayPath: SOURCE_NAME,
      mediaType: "text/plain",
      deepLink: METADATA.deepLink,
      observedAt: now,
    },
    now,
  });
  const command = createFileProjectionCommand({
    organisationId: ORGANISATION_ID,
    grantId: GRANT_ID,
    grantRevision: 1,
    ...reference,
    sourceSequence: 1,
    providerRevision: PROVIDER_REVISION,
    visibilityKey: encodeContextVisibility({
      kind: "person",
      personId: "person_e2e-slack-actor",
    }),
  });
  const reader: FileProjectionSourceReader = {
    readMetadata: projectionMetadata,
    readTextContent: projectionContent,
  };
  const projected = await applyFileProjectionCommand({
    scope,
    command,
    sourceReader: reader,
    now,
  });
  if (projected.kind !== "applied") throw new Error(JSON.stringify(projected));
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
  return {
    reference,
    session: await issueControlSession({
      db: env.DB,
      userId: user.value,
      now,
      ttlMs: 1_800_000,
    }),
    fresh: await issueControlSession({
      db: env.DB,
      userId: user.value,
      now,
      ttlMs: 1_800_000,
    }),
  };
}
async function projectionMetadata() {
  return { ok: true, value: METADATA } as const;
}
async function projectionContent() {
  return { ok: true, value: new TextEncoder().encode(PROVIDER_TEXT) } as const;
}
