import { requireOrganisationBootstrap } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import {
  authorizeWorkspaceExecutorDispatch,
  executeRecordedWorkspaceOperation,
  recoverRecordedWorkspaceOperation,
  releaseRecordedWorkspaceOperation,
  type WorkspaceExecutorRequest,
  type WorkspaceExecutorInvocation,
} from "../../src/workspace-executor-container";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";
import { env } from "cloudflare:workers";
import { expect, it, vi, type TestContext } from "vitest";
import { sha256Hex } from "@seams/std";
import {
  issueControlSession,
  readActiveOrganisationMembershipRevision,
  upsertUser,
} from "../../src/data/control-plane";
import { newControlMutationIdentity } from "../../src/data/control-mutation";
import { parseInitialOrganisationPlacement } from "../../src/placement";
import { buildControlAuthority } from "../../src/request-authority";
import { authorizeSessionTurnExecution } from "../../src/chat/turn-access";
import {
  commitWorkspaceRevision,
  prepareWorkspaceRevisionMutation,
  verifyWorkspaceRevisionReceipt,
  type WorkspaceRevisionProposal,
} from "../../src/workspace-revision-store";
import {
  admitControlTurnFixture,
  requireOrganisationExecutionScope,
} from "../organisation-execution-fixture";
import type { OrganisationId } from "../../src/ids";

type Pause = { phase: "armed" | "paused" | "released" };

it.for(["prepare", "commit", "issued"] as const)(
  "retains workspace origin through %s, withholding revoked publication or preserving its issued receipt",
  { timeout: 60_000 },
  workspaceOriginJourney,
);

async function workspaceOriginJourney(
  boundary: "prepare" | "commit" | "issued",
  { task }: TestContext,
): Promise<void> {
  const { now, organisationId, scope, user, authority, session, execution } =
    await installWorkspaceOriginScenario(boundary);
  const authorize = authorizeSessionTurnExecution.bind(
    null,
    env.DB,
    scope.database,
    organisationId,
    execution,
    scope.accountAccess,
  );
  const genesis: WorkspaceRevisionProposal = {
    kind: "genesis",
    organisationId,
    workspaceId: "workspace_origin",
    idempotencyKey: "origin-genesis",
    files: [
      {
        path: "products/product_1/product.json",
        mediaType: "application/json",
        content: '{"title":"Initial"}',
      },
    ],
    correlationId: "origin-genesis",
    causation: { kind: "command", commandId: "origin-genesis" },
    committedAt: now,
  };
  const initial = await prepareWorkspaceRevisionMutation(
    scope,
    { kind: "placement" },
    env.ARCHIVE,
    genesis,
  );
  if (!initial.ok) throw new Error(initial.error.code);
  const initialCommit = await commitWorkspaceRevision(
    env.ARCHIVE,
    initial.value,
  );
  if (!initialCommit.ok) throw new Error(initialCommit.error.code);
  const material = {
    schemaVersion: "satyr.product-folder-changeset.v1",
    organisationId,
    workspaceId: genesis.workspaceId,
    baseRevision: initial.value.receipt.revision,
    resultingSemanticHash: await sha256Hex("Updated"),
    diff: {
      productId: "product_1",
      fields: ["title" as const],
      variantIds: [],
    },
  };
  const proposal: WorkspaceRevisionProposal = {
    kind: "product_folder_changeset",
    organisationId,
    workspaceId: genesis.workspaceId,
    idempotencyKey: "origin-edit",
    files: [
      {
        path: "products/product_1/product.json",
        mediaType: "application/json",
        content: '{"title":"Updated"}',
      },
    ],
    correlationId: "origin-edit",
    causation: { kind: "command", commandId: "origin-edit" },
    committedAt: now + 1,
    changeset: {
      ...material,
      changesetDigest: await sha256Hex(JSON.stringify(material)),
    },
  };
  const prepared =
    boundary === "prepare"
      ? null
      : await prepareWorkspaceRevisionMutation(
          scope,
          { kind: "execution", authorizeCommit: authorize },
          env.ARCHIVE,
          proposal,
        );
  if (prepared !== null && !prepared.ok) throw new Error(prepared.error.code);
  const pause: Pause = { phase: "armed" };
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const batch = fixtureDatabase().batch.bind(fixtureDatabase());
  const publishedBefore = await revisionCount(organisationId);
  const interception =
    boundary === "issued"
      ? vi
          .spyOn(fixtureDatabase(), "batch")
          .mockImplementation(
            pausePublishedBatch.bind(
              null,
              pause,
              batch,
              organisationId,
              publishedBefore,
            ),
          )
      : vi
          .spyOn(crypto.subtle, "digest")
          .mockImplementation(pauseManifestHash.bind(null, pause, digest));
  const work =
    prepared === null
      ? prepareWorkspaceRevisionMutation(
          scope,
          { kind: "execution", authorizeCommit: authorize },
          env.ARCHIVE,
          proposal,
        )
      : commitWorkspaceRevision(env.ARCHIVE, prepared.value);
  try {
    await expect.poll(pausePhase.bind(null, pause)).toBe("paused");
    await env.DB.prepare(
      "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
    )
      .bind(Date.now(), session.session.controlSessionId)
      .run();
    pause.phase = "released";
    expect(await work).toMatchObject({
      ok: false,
      error: { code: "workspace_execution_authority_inactive" },
    });
    const expectedCount = boundary === "issued" ? 2 : 1;
    expect(await revisionCount(organisationId)).toBe(expectedCount);
    if (boundary === "issued" && prepared !== null) {
      expect(
        await verifyWorkspaceRevisionReceipt(
          scope,
          organisationId,
          prepared.value.receipt,
        ),
      ).toEqual({ ok: true, value: prepared.value.receipt });
    }
    const recoveredScope = await requireOrganisationExecutionScope(
      env,
      organisationId,
    );
    expect(
      await prepareWorkspaceRevisionMutation(
        recoveredScope,
        { kind: "execution", authorizeCommit: authorize },
        env.ARCHIVE,
        proposal,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "workspace_execution_authority_inactive" },
    });
    const freshSession = await issueControlSession({
      db: env.DB,
      userId: user.userId,
      now: Date.now(),
      ttlMs: 1_800_000,
    });
    const freshExecution = await admitControlTurnFixture(
      env,
      authority,
      freshSession.session.controlSessionId,
    );
    const fresh = await prepareWorkspaceRevisionMutation(
      recoveredScope,
      {
        kind: "execution",
        authorizeCommit: authorizeSessionTurnExecution.bind(
          null,
          env.DB,
          recoveredScope.database,
          organisationId,
          freshExecution,
          recoveredScope.accountAccess,
        ),
      },
      env.ARCHIVE,
      proposal,
    );
    if (!fresh.ok) throw new Error(fresh.error.code);
    const committed = await commitWorkspaceRevision(env.ARCHIVE, fresh.value);
    expect(committed).toMatchObject({
      ok: true,
      value: { kind: boundary === "issued" ? "duplicate" : "committed" },
    });
    expect(
      await commitWorkspaceRevision(env.ARCHIVE, fresh.value),
    ).toMatchObject({ ok: true, value: { kind: "duplicate" } });
    expect(await revisionCount(organisationId)).toBe(2);
    Object.assign(task.meta, {
      workspaceOrigin: {
        boundary,
        revokedResultWithheld: true,
        revisionsAfterRevocation: expectedCount,
        finalRevisions: 2,
        freshCommandAccepted: true,
      },
    });
  } finally {
    pause.phase = "released";
    interception.mockRestore();
    await Promise.allSettled([work]);
  }
}

async function pauseManifestHash(
  pause: Pause,
  digest: SubtleCrypto["digest"],
  algorithm: Parameters<SubtleCrypto["digest"]>[0],
  data: BufferSource,
): Promise<ArrayBuffer> {
  const result = await digest(algorithm, data);
  if (
    new TextDecoder()
      .decode(data)
      .includes('"schemaVersion":"workspace_revision_manifest.v1"')
  )
    await pauseOnce(pause);
  return result;
}

// Pauses after the batch that publishes the revision. Earlier batches, such
// as the account check of the request, pass through.
async function pausePublishedBatch<T>(
  pause: Pause,
  batch: D1Database["batch"],
  organisationId: OrganisationId,
  publishedBefore: number,
  statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  const result = await batch<T>(statements);
  if ((await revisionCount(organisationId)) > publishedBefore) {
    await pauseOnce(pause);
  }
  return result;
}

async function pauseOnce(pause: Pause): Promise<void> {
  if (pause.phase !== "armed") return;
  pause.phase = "paused";
  while (pause.phase === "paused") await scheduler.wait(5);
}

function pausePhase(pause: Pause): Pause["phase"] {
  return pause.phase;
}

async function revisionCount(organisationId: OrganisationId): Promise<number> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS total FROM workspace_revision WHERE organisation_id = ? AND workspace_id = 'workspace_origin'",
    )
    .bind(organisationId)
    .first<{ total: number }>();
  if (row === null) throw new Error("Missing revision count");
  return row.total;
}

async function installWorkspaceOriginScenario(boundary: string) {
  const now = Date.now();
  const user = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `workspace-origin-${boundary}`,
      email: `workspace-${boundary}@example.test`,
      displayName: "Workspace operator",
      emailVerified: true,
    },
    now,
  });
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const created = await requireOrganisationBootstrap({
    env,
    owner: user,
    organisationName: `Workspace origin ${boundary}`,
    environment: "development",
    placement: placement.value,
    now,
    mutation: {
      scope: {
        userId: user.userId,
        organisationScope: "organisation:create",
        route: "/v1/control/organisations",
        operation: "organisation.create",
      },
      boundary: {
        kind: "unversioned",
        idempotencyKey: `workspace-${boundary}`,
        requestHash: `workspace-${boundary}`,
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: `workspace-${boundary}`,
        causationId: `workspace-${boundary}`,
        now,
      }),
    },
  });
  const organisationId = created.organisationId;
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'workspace-origin-fixture', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(now, organisationId)
    .run();
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const member = await fixtureDatabase()
    .prepare(
      "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(organisationId, user.userId)
    .first<{ personId: string }>();
  const revision = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId,
  });
  if (member === null || revision === null)
    throw new Error("Missing fixture membership");
  const authority = buildControlAuthority({
    organisationId,
    userId: user.userId,
    requesterPersonId: member.personId,
    membershipRevision: revision,
    role: "owner",
  }).requestAuthority;
  const session = await issueControlSession({
    db: env.DB,
    userId: user.userId,
    now,
    ttlMs: 1_800_000,
  });
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner: { identity: user, session },
    members: {},
  });
  const execution = await admitControlTurnFixture(
    env,
    authority,
    session.session.controlSessionId,
  );
  return { now, organisationId, scope, user, authority, session, execution };
}

type ExecutorProbe = {
  phase: "ready" | "paused" | "released";
  mode: "normal" | "interrupted" | "wait" | "authorize_wait";
  stopFailures: number;
};

it.for(["revoked", "lost_response", "interrupted", "concurrent"] as const)(
  "recovers executor %s through durable admission, native eviction and receipt release without duplicate dispatch",
  { timeout: 60_000 },
  executorReceiptJourney,
);

async function executorReceiptJourney(
  boundary: "revoked" | "lost_response" | "interrupted" | "concurrent",
  { task }: TestContext,
): Promise<void> {
  const scenario = await installWorkspaceOriginScenario(`executor_${boundary}`);
  await ensureCreatedOrganisationActor({
    env,
    organisationId: scenario.organisationId,
    now: Date.now(),
  });
  const actor = await requireActiveOrganisationActor({
    env,
    organisationId: scenario.organisationId,
    now: Date.now(),
  });
  const request = executorRequest(scenario.organisationId);
  const probe: ExecutorProbe = {
    phase: "ready",
    mode: "normal",
    stopFailures: boundary === "lost_response" ? 1 : 0,
  };
  if (boundary === "revoked") probe.mode = "authorize_wait";
  if (boundary === "interrupted") probe.mode = "interrupted";
  if (boundary === "concurrent") probe.mode = "wait";
  const authorizeDispatch = authorizeWorkspaceExecutorDispatch.bind(
    null,
    env,
    {
      placement: {
        organisationId: scenario.scope.organisationId,
        placement: scenario.scope.placement,
        fenceToken: scenario.scope.fenceToken,
      },
      execution: scenario.execution,
      expiresAt: request.deadlineAtUnixMs,
    },
    request,
  );
  const authorize = pauseExecutorAuthorization.bind(
    null,
    probe,
    authorizeDispatch,
  );
  const input = { request, probe, authorize };
  const work = runInDurableObject(
    actor,
    executeReceiptFixture.bind(null, input),
  );
  try {
    if (boundary === "revoked") {
      await expect.poll(executorProbePhase.bind(null, probe)).toBe("paused");
      await env.DB.prepare(
        "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
      )
        .bind(Date.now(), scenario.session.session.controlSessionId)
        .run();
      expect(await authorizeDispatch()).toBe(false);
      expect(
        await runInDurableObject(
          actor,
          recoverReceiptFixture.bind(null, input),
        ),
      ).toEqual({ ok: true, value: { kind: "cancelled" } });
      probe.phase = "released";
    }
    if (boundary === "concurrent") {
      await expect.poll(executorProbePhase.bind(null, probe)).toBe("paused");
      expect(
        await runInDurableObject(
          actor,
          executeReceiptFixture.bind(null, input),
        ),
      ).toEqual({ ok: false, error: { code: "workspace_operation_pending" } });
      probe.phase = "released";
    }
    if (boundary === "interrupted" || boundary === "lost_response") {
      await expect(work).rejects.toThrow(
        boundary === "interrupted"
          ? "fixture_execution_lost"
          : "fixture_cleanup_failed",
      );
    } else if (boundary === "revoked") {
      expect(await work).toEqual({
        ok: true,
        value: { kind: "cancelled" },
      });
    } else {
      expect(await work).toMatchObject({
        ok: true,
        value: { kind: "completed" },
      });
    }
    if (boundary === "lost_response") {
      await env.DB.prepare(
        "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
      )
        .bind(Date.now(), scenario.session.session.controlSessionId)
        .run();
      for (const database of [env.DB, fixtureDatabase()])
        await database
          .prepare(
            "UPDATE organisation_placement SET fence_token = ? WHERE organisation_id = ?",
          )
          .bind(`tpf_${crypto.randomUUID()}`, scenario.organisationId)
          .run();
      expect(await authorize()).toBe(false);
    }
    await evictDurableObject(actor);
    const recovered = await runInDurableObject(
      actor,
      recoverReceiptFixture.bind(null, input),
    );
    if (boundary === "revoked") {
      expect(recovered).toEqual({ ok: true, value: { kind: "cancelled" } });
      // A delayed original RPC cannot reopen the sealed allocation.
      expect(
        await runInDurableObject(
          actor,
          executeReceiptFixture.bind(null, input),
        ),
      ).toEqual(recovered);
      expect(
        await runInDurableObject(actor, executorReceiptState),
      ).toMatchObject({
        attempts: 0,
        state: "cancelled",
        retainedOutput: false,
      });
    } else {
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          kind: "completed",
          invocation: {
            kind: "failed",
            error: {
              reason:
                boundary === "interrupted"
                  ? "workspace_operation_interrupted"
                  : "fixture_provider_failure",
            },
          },
        },
      });
      expect(
        await runInDurableObject(
          actor,
          executeReceiptFixture.bind(null, input),
        ),
      ).toEqual(recovered);
      expect(
        await runInDurableObject(actor, executorReceiptState),
      ).toMatchObject({
        attempts: 1,
        state: "completed",
        retainedOutput: true,
      });
      await runInDurableObject(actor, releaseReceiptFixture.bind(null, input));
      await evictDurableObject(actor);
      expect(
        await runInDurableObject(
          actor,
          executeReceiptFixture.bind(null, input),
        ),
      ).toEqual({ ok: false, error: { code: "workspace_operation_released" } });
      expect(
        await runInDurableObject(actor, executorReceiptState),
      ).toMatchObject({
        attempts: 1,
        state: "released",
        retainedOutput: false,
      });
    }
    const conflict = {
      request: { ...request, executionId: "another_execution" },
      probe,
      authorize,
    };
    expect(
      await runInDurableObject(
        actor,
        executeReceiptFixture.bind(null, conflict),
      ),
    ).toEqual({ ok: false, error: { code: "workspace_operation_conflict" } });
    Object.assign(task.meta, {
      executorReceipt: {
        boundary,
        nativeEviction: true,
        attempts: boundary === "revoked" ? 0 : 1,
        outputReleased: true,
      },
    });
  } finally {
    probe.phase = "released";
    await Promise.allSettled([work]);
  }
}

type ExecutorFixture = {
  request: WorkspaceExecutorRequest;
  probe: ExecutorProbe;
  authorize: () => Promise<boolean>;
};
async function pauseExecutorAuthorization(
  probe: ExecutorProbe,
  authorize: () => Promise<boolean>,
): Promise<boolean> {
  const allowed = await authorize();
  if (probe.mode === "authorize_wait" && probe.phase === "ready") {
    probe.phase = "paused";
    while (probe.phase === "paused") await scheduler.wait(5);
  }
  return allowed;
}
function executeReceiptFixture(
  input: ExecutorFixture,
  _actor: unknown,
  state: DurableObjectState,
) {
  return executeRecordedWorkspaceOperation(
    state.storage.sql,
    input.request,
    input.authorize,
    dispatchReceiptFixture.bind(null, state.storage.sql, input.probe),
    stopReceiptFixture.bind(null, input.probe),
  );
}
function recoverReceiptFixture(
  input: ExecutorFixture,
  _actor: unknown,
  state: DurableObjectState,
) {
  return recoverRecordedWorkspaceOperation(
    state.storage.sql,
    input.request,
    stopReceiptFixture.bind(null, input.probe),
  );
}
function releaseReceiptFixture(
  input: ExecutorFixture,
  _actor: unknown,
  state: DurableObjectState,
) {
  return releaseRecordedWorkspaceOperation(
    state.storage.sql,
    input.request,
    stopReceiptFixture.bind(null, input.probe),
  );
}
async function dispatchReceiptFixture(
  sql: SqlStorage,
  probe: ExecutorProbe,
): Promise<WorkspaceExecutorInvocation> {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS executor_fixture_attempt (attempt INTEGER NOT NULL)",
  );
  sql.exec("INSERT INTO executor_fixture_attempt VALUES (1)");
  if (probe.mode === "interrupted") throw new Error("fixture_execution_lost");
  if (probe.mode === "wait") {
    probe.phase = "paused";
    while (probe.phase === "paused") await scheduler.wait(5);
  }
  return {
    kind: "failed",
    error: {
      kind: "container_unavailable",
      reason: "fixture_provider_failure",
    },
    usage: { requestBytes: 100, responseBytes: 30, gatewayDurationMs: 10 },
  };
}
async function stopReceiptFixture(probe: ExecutorProbe): Promise<void> {
  if (probe.stopFailures > 0) {
    probe.stopFailures -= 1;
    throw new Error("fixture_cleanup_failed");
  }
}
function executorProbePhase(probe: ExecutorProbe): ExecutorProbe["phase"] {
  return probe.phase;
}
function executorReceiptState(_actor: unknown, state: DurableObjectState) {
  state.storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS executor_fixture_attempt (attempt INTEGER NOT NULL)",
  );
  const attempts = state.storage.sql
    .exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM executor_fixture_attempt",
    )
    .one().total;
  const receipt = state.storage.sql
    .exec<{ state: string; retained: number }>(
      "SELECT state, invocation IS NOT NULL AS retained FROM workspace_executor_operation WHERE singleton = 1",
    )
    .one();
  return {
    attempts,
    state: receipt.state,
    retainedOutput: receipt.retained === 1,
  };
}
function executorRequest(
  organisationId: OrganisationId,
): WorkspaceExecutorRequest {
  return {
    schemaVersion: "workspace_executor_request.v1",
    executionId: "executor_fixture",
    executionReceiptId: "receipt_fixture",
    deadlineAtUnixMs: Date.now() + 60_000,
    baseRevision: "revision_fixture",
    baseCanonicalHead: "a".repeat(64),
    baseManifestDigest: "b".repeat(64),
    operation: {
      kind: "product_folder_candidate",
      productRoot: "products/product_1",
      workspaceYaml: "workspace: fixture",
      base: { productMarkdown: "Before", variantsYaml: "variants: []" },
      candidate: { productMarkdown: "After", variantsYaml: "variants: []" },
      claimedChangeset: {
        schemaVersion: "satyr.product-folder-changeset.v1",
        organisationId,
        workspaceId: "workspace_fixture",
        baseRevision: "revision_fixture",
        resultingSemanticHash: "c".repeat(64),
        changesetDigest: "d".repeat(64),
        diff: { productId: "product_1", fields: ["title"], variantIds: [] },
      },
    },
  };
}
