import { runInDurableObject } from "cloudflare:test";
import { organisationDatabase, publishGlobalOrganisation } from "./organisation-database";
import { parseOrganisationId } from "../../src/ids";
import { parseOrganisationPlacementProfile } from "../../src/placement";
import { ensureInitialOrganisationPlacement } from "../../src/data/shared-rows/placement-row";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { assertNever, sha256Hex } from "@seams/std";
import type {
  AuthorizedHarnessToolResult,
  HarnessTurnLease,
} from "@seams/contracts";
import type {
  AcceptHarnessEventInput,
  AppendHarnessHistoryInput,
} from "../../src/actors/agent-session-harness-authority";
import type {
  CanonicalHarnessEventSink,
  CanonicalHarnessHistorySink,
  EmbeddedHarnessConstructionInput,
  EmbeddedHarnessTurnResult,
  HarnessToolHost,
} from "../../src/actors/embedded-harness";
import type { HarnessCodeModeAdmission, HarnessCodeModeAdmittedExecution, HarnessCodeModeExecutionLease } from "../../src/agent-tools/catalog/types";
import type { CodemodeRemote } from "@earendil-works/pi-codemode/portable";
import { createPiDurableAdapter } from "../../src/actors/pi-durable-runtime";
import {
  TEST_ACCEPTED_INPUT_CONTEXT,
  TEST_HARNESS_LEASE_AUTHORITY,
} from "../fixtures/plan25-turn";

export type PiSdkFixtureMode = "native" | "direct";

export class RecordingBoundary
  implements
    CanonicalHarnessEventSink,
    CanonicalHarnessHistorySink,
    HarnessCodeModeAdmission
{
  readonly entries: AppendHarnessHistoryInput["entry"][] = [];
  readonly settlements: string[] = [];
  capabilityCalls = 0;

  async acceptCanonicalHarnessEvent(input: AcceptHarnessEventInput) {
    return {
      ok: true as const,
      value: {
        kind: "advanced" as const,
        cursor: {
          kind: "accepted" as const,
          turn: input.turn,
          lastSequence: input.sequence,
          lastEventDigest: input.eventDigest,
        },
      },
    };
  }

  async appendHarnessHistory(input: AppendHarnessHistoryInput) {
    this.entries.push(input.entry);
    return {
      ok: true as const,
      value: {
        kind: "advanced" as const,
        cursor: {
          lastSequence: this.entries.length,
          lastEntryDigest: await sha256Hex(JSON.stringify(this.entries)),
        },
      },
    };
  }

  async begin(
    _source: string,
    callId: string,
  ): Promise<HarnessCodeModeAdmittedExecution> {
    return {
      executionId: `cmx_${callId}`,
      leaseId: "lease_compaction",
      executionDeadlineAt: Date.now() + 30_000,
      runnable: true,
    };
  }

  async claim(
    _lease: HarnessCodeModeExecutionLease,
    callId: string,
  ): Promise<void> {
    expect(callId).toMatch(/^call_[a-f0-9]{64}$/u);
  }

  async complete(): Promise<void> {}

  async abandon(): Promise<void> {}

  async settle(
    _lease: HarnessCodeModeExecutionLease,
    outcome: string,
  ): Promise<void> {
    this.settlements.push(outcome);
  }

  async executeTool(
    name: string,
    input: string,
  ): Promise<AuthorizedHarnessToolResult> {
    expect(name).toBe("inventory_read");
    expect(input).toBe("{}");
    this.capabilityCalls += 1;
    const text = JSON.stringify({
      code_mode_value: { revision: 7, items: ["croissant", "financier"] },
    });
    const digest = await sha256Hex(text);
    return {
      kind: "read",
      status: "succeeded",
      output: { kind: "inline", content: [{ kind: "text", text }], digest },
      authority: { kind: "read", resultDigest: digest },
    };
  }
}

export function sdkInput(
  boundary: RecordingBoundary,
  definitions: EmbeddedHarnessConstructionInput["toolHost"]["definitions"],
  mode: PiSdkFixtureMode | HarnessToolHost,
): EmbeddedHarnessConstructionInput {
  const turn = {
    turnId: "turn_compaction",
    inputId: "input_compaction",
    turnLeaseGeneration: 1,
    budgetRevision: "budget_compaction",
  };
  const lease: HarnessTurnLease = {
    requestAuthority: TEST_HARNESS_LEASE_AUTHORITY.requestAuthority,
    authorityPartitionDigest:
      TEST_HARNESS_LEASE_AUTHORITY.authorityPartitionDigest,
    leaseId: "lease_compaction",
    session: {
      organisationId: "organisation_compaction",
      sessionId: "session_compaction",
      streamId: "stream_compaction",
    },
    turn,
    runtimeLease: { generation: 1, leaseId: "runtime_compaction" },
    runtimeRevision: "runtime_compaction",
    issuedAt: 1,
    expiresAt: 100,
  };
  return {
    persistence: { kind: "transient" },
    source: { kind: "fresh" },
    inheritedHistory: [],
    inheritedAttachments: {},
    sessionId: "session_compaction",
    acceptedInput: {
      kind: "thread",
      contextBundleDigest: TEST_ACCEPTED_INPUT_CONTEXT.contextBundleDigest,
      inputId: turn.inputId,
      threadActorId: "thread_compaction",
      threadBlockId: "block_compaction",
      contentDigest: "a".repeat(64),
      workspaceRevision: "workspace_compaction",
    },
    model: "moonshotai/kimi-k3",
    modelTokenAllowance: 65_536,
    goalModelCalls: { kind: "untracked" },
    harnessInstructions:
      "Use governed evidence. When Code Mode is available, keep intermediate datasets inside the script or native store and emit only the requested brief. Retain the completed brief under native store key brief when available.",
    modelRouteLease: {
      kind: "platform_api_key",
      resolveModelApiKey: compactionKey,
    },
    checkpointBinding: {
      cursor: null,
      modelRouteDigest: "b".repeat(64),
      instructionDigest: "c".repeat(64),
      toolCatalogDigest: "d".repeat(64),
      workspaceRevision: "workspace_compaction",
      policyRevision: "policy_compaction",
    },
    toolHost:
      typeof mode === "object"
        ? mode
        : {
            mode: "hybrid",
            catalogDigest: "d".repeat(64),
            codeMode: fixtureCodeMode(mode, boundary),
            definitions,
            executeTool: boundary.executeTool.bind(boundary),
          },
    eventSink: boundary,
    historySink: boundary,
    turnLease: lease,
    now: Date.now,
  };
}

function fixtureCodeMode(
  mode: PiSdkFixtureMode,
  boundary: RecordingBoundary,
): EmbeddedHarnessConstructionInput["toolHost"]["codeMode"] {
  switch (mode) {
    case "native":
      return {
        kind: "enabled",
        sandbox: fixtureSandbox,
        admission: boundary,
        executeTool: executeNestedFixtureTool.bind(null, boundary),
        claimedCapabilities: noClaimedCapabilities,
        authorizeSources: authorizeFixtureSources,
      };
    case "direct":
      return { kind: "disabled" };
    default:
      return assertNever(mode);
  }
}

/** The sandbox Worker of the test runtime, one object for each execution. */
export function fixtureSandbox(executionId: string): CodemodeRemote {
  const sandbox = env.CODE_MODE_SANDBOX?.getByName(executionId);
  if (sandbox === undefined) throw new Error("Missing sandbox binding");
  return {
    async execute(request, exchange) {
      await sandbox.execute(request, exchange);
    },
  };
}

function noClaimedCapabilities(): readonly string[] {
  return [];
}

async function authorizeFixtureSources() {
  return { ok: true as const, value: null };
}

function executeNestedFixtureTool(
  boundary: RecordingBoundary,
  _lease: HarnessCodeModeExecutionLease,
  name: string,
  input: string,
): Promise<AuthorizedHarnessToolResult> {
  return boundary.executeTool(name, input);
}

export function restoredInput(
  firstInput: EmbeddedHarnessConstructionInput,
  completed: EmbeddedHarnessTurnResult,
  boundary: RecordingBoundary,
  phase: string,
): EmbeddedHarnessConstructionInput {
  const turn = {
    turnId: `turn_compaction_${phase}`,
    inputId: `input_compaction_${phase}`,
    turnLeaseGeneration: 1,
    budgetRevision: "budget_compaction",
  };
  return {
    persistence: { kind: "transient" },
    inheritedHistory: firstInput.inheritedHistory,
    inheritedAttachments: firstInput.inheritedAttachments,
    sessionId: firstInput.sessionId,
    model: firstInput.model,
    modelTokenAllowance: firstInput.modelTokenAllowance,
    goalModelCalls: { kind: "untracked" },
    harnessInstructions: firstInput.harnessInstructions,
    modelRouteLease: firstInput.modelRouteLease,
    toolHost: firstInput.toolHost,
    eventSink: boundary,
    historySink: boundary,
    now: firstInput.now,
    source: {
      kind: "restore",
      checkpoint: completed.checkpoint,
      historyCursor: completed.historyCursor,
      history: { cursor: completed.historyCursor, entries: boundary.entries },
    },
    acceptedInput: {
      kind: "thread",
      contextBundleDigest: TEST_ACCEPTED_INPUT_CONTEXT.contextBundleDigest,
      inputId: turn.inputId,
      threadActorId: "thread_compaction",
      threadBlockId: "block_compaction_restored",
      contentDigest: "e".repeat(64),
      workspaceRevision: "workspace_compaction",
    },
    checkpointBinding: {
      modelRouteDigest: firstInput.checkpointBinding.modelRouteDigest,
      instructionDigest: firstInput.checkpointBinding.instructionDigest,
      toolCatalogDigest: firstInput.checkpointBinding.toolCatalogDigest,
      workspaceRevision: firstInput.checkpointBinding.workspaceRevision,
      policyRevision: firstInput.checkpointBinding.policyRevision,
      cursor: completed.cursor,
    },
    turnLease: {
      requestAuthority: firstInput.turnLease.requestAuthority,
      authorityPartitionDigest: firstInput.turnLease.authorityPartitionDigest,
      leaseId: firstInput.turnLease.leaseId,
      session: firstInput.turnLease.session,
      turn,
      runtimeLease: firstInput.turnLease.runtimeLease,
      runtimeRevision: firstInput.turnLease.runtimeRevision,
      issuedAt: firstInput.turnLease.issuedAt,
      expiresAt: firstInput.turnLease.expiresAt,
    },
  };
}

async function compactionKey(): Promise<string> {
  if (env.OPENROUTER_API_KEY === undefined)
    throw new Error("Missing fixture key");
  return env.OPENROUTER_API_KEY;
}
async function runNativeTurn(
  input: EmbeddedHarnessConstructionInput,
  text: string,
): Promise<EmbeddedHarnessTurnResult> {
  const runtime = createPiDurableAdapter(input.model).construct(input);
  if (!runtime.ok) throw new Error(runtime.error.code);
  try {
    const started = await runtime.value.startTurn([{ kind: "text", text }])
      .completion;
    if (!started.ok) throw new Error(JSON.stringify(started.error));
    const completed = await started.value.complete();
    if (!completed.ok) throw new Error(JSON.stringify(completed.error));
    return completed.value;
  } finally {
    await runtime.value.close();
  }
}

export function freshForkInput(
  base: EmbeddedHarnessConstructionInput,
  inheritedHistory: EmbeddedHarnessConstructionInput["inheritedHistory"],
): EmbeddedHarnessConstructionInput {
  return {
    persistence: { kind: "transient" },
    source: { kind: "fresh" },
    sessionId: "session_native_fork",
    inheritedHistory,
    inheritedAttachments: {},
    acceptedInput: base.acceptedInput,
    model: base.model,
    modelTokenAllowance: base.modelTokenAllowance,
    goalModelCalls: { kind: "untracked" },
    harnessInstructions:
      "Use the inherited conversation as historical context. Respond to the new user request. Historical tool results do not dispatch new actions.",
    modelRouteLease: base.modelRouteLease,
    checkpointBinding: base.checkpointBinding,
    toolHost: base.toolHost,
    eventSink: base.eventSink,
    historySink: base.historySink,
    turnLease: {
      requestAuthority: base.turnLease.requestAuthority,
      authorityPartitionDigest: base.turnLease.authorityPartitionDigest,
      leaseId: "lease_native_fork",
      session: {
        organisationId: base.turnLease.session.organisationId,
        sessionId: "session_native_fork",
        streamId: "stream_native_fork",
      },
      turn: base.turnLease.turn,
      runtimeLease: base.turnLease.runtimeLease,
      runtimeRevision: base.turnLease.runtimeRevision,
      issuedAt: base.turnLease.issuedAt,
      expiresAt: base.turnLease.expiresAt,
    },
    now: base.now,
  };
}

export async function prepareSdkOrganisation() {
  const organisation = parseOrganisationId("organisation_compaction");
  if (!organisation.ok) throw new Error(organisation.error.code);
  const placement = parseOrganisationPlacementProfile(
    env.SATYR_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!placement.ok) throw new Error(placement.error.code);
  const database = organisationDatabase(
    organisation.value,
    placement.value.placementCellId,
  );
  await database
    .prepare(
      "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'SDK fixture', 'beta', 1, 'active') ON CONFLICT (organisation_id) DO NOTHING",
    )
    .bind(organisation.value)
    .run();
  const initialized = await ensureInitialOrganisationPlacement({
    db: database,
    organisationId: organisation.value,
    environment: "development",
    placement: placement.value,
    now: 1,
  });
  if (!initialized.ok) throw new Error(initialized.error.code);
  await publishGlobalOrganisation(
    organisation.value,
    placement.value.placementCellId,
  );
  return requireOrganisationExecutionScope(env, organisation.value);
}

export async function runSdkTurn(
  input: EmbeddedHarnessConstructionInput,
  text: string,
): Promise<EmbeddedHarnessTurnResult> {
  const actor = env.SESSION.get(
    env.SESSION.idFromName(`pi-durable-test-${input.sessionId}`),
  );
  return runInDurableObject(actor, runStoredNativeTurn.bind(null, input, text));
}
function runStoredNativeTurn(
  input: EmbeddedHarnessConstructionInput,
  text: string,
  _actor: unknown,
  state: DurableObjectState,
): Promise<EmbeddedHarnessTurnResult> {
  return runNativeTurn(
    {
      ...input,
      persistence: {
        kind: "actor",
        storage: state.storage,
        preflight: fixtureLeaseAccepted,
      },
    },
    text,
  );
}
function fixtureLeaseAccepted(): void {}
