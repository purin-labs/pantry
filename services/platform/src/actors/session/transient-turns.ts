import {
  createTransientGoalExecution,
  type GoalUsageContext,
} from "../session-goal-usage";
import type {
  EmbeddedHarnessConstructionInput,
  HarnessToolHost,
} from "../embedded-harness";
import type {
  AcceptedInputRef,
  SessionIdentity,
  SessionContract,
  HarnessTurnLease,
} from "@purin-labs/contracts";
import { parseSessionId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  SessionExecutionAdmission,
  admittedSessionModelRoute,
  admittedSessionToolHost,
} from "../session-execution-admission";
import { digestModelRoute } from "../../models/route";
import { runTransientEmailTurn as runTransientEmailTurnWithSinks } from "../transient-email-turn";
import { selectEmbeddedHarnessAdapterForModelRoute } from "../embedded-harness-adapter";
import { digestCanonical } from "../../policy";
import {
  authorizedTransientModelLease,
  createEmbeddedHarnessModelRouteLease,
} from "./model-route";
import type { TransientSessionExecution } from "./support";
import {
  admitTransientHarnessTurn,
  isTransientHarnessOpen,
  settleTransientHarnessTurn,
  startNoTransientTeardown,
} from "./turn-completion";
import type {
  TransientHarnessTurnInput,
  TransientModelTurnError,
} from "./types";

export async function runTransientMailHarness(
  execution: SessionExecutionAdmission,
  transient: TransientSessionExecution,
  context: GoalUsageContext,
  identity: SessionIdentity,
  contract: SessionContract,
  input: TransientHarnessTurnInput,
  toolHost: HarnessToolHost,
  toolRules: EmbeddedHarnessConstructionInput["toolRules"],
  reauthorize: () => Promise<Result<null, Readonly<{ code: string }>>>,
): Promise<
  Result<
    import("../transient-email-turn").TransientEmailTurnSuccess,
    TransientModelTurnError
  >
> {
  const { env } = context;
  const parsedSessionId = parseSessionId(identity.sessionId);
  if (!parsedSessionId.ok)
    return {
      ok: false,
      error: {
        code: "transient_email_session_identity_invalid",
        modelUsage: null,
      },
    };
  const adapter = selectEmbeddedHarnessAdapterForModelRoute(
    contract.modelRoute,
  );
  const lease = await createEmbeddedHarnessModelRouteLease({
    env: env,
    scope: execution.scope,
    sessionId: parsedSessionId.value,
    modelRoute: contract.modelRoute,
  });
  // No model route lease means no provider request was made.
  if (!lease.ok)
    return {
      ok: false,
      error: { code: lease.error.code, modelUsage: KNOWN_ZERO_MODEL_USAGE },
    };
  const now = Date.now();
  const turnLease: HarnessTurnLease = {
    leaseId: `transient_${input.turnId}`,
    session: identity,
    turn: {
      turnId: input.turnId,
      inputId: input.inputId,
      turnLeaseGeneration: 1,
      budgetRevision: contract.budgetRevision,
    },
    runtimeLease: {
      generation: 1,
      leaseId: `runtime_transient_${input.turnId}`,
    },
    runtimeRevision: contract.runtimeRevision,
    requestAuthority: input.requestAuthority,
    authorityPartitionDigest: input.authorityPartitionDigest,
    issuedAt: now,
    expiresAt: now + input.maxWallMs,
  };
  const modelRouteLease = admittedSessionModelRoute(
    {
      kind: "transient",
      admission: execution,
      lease: turnLease,
      isOpen: isTransientHarnessOpen.bind(null, transient),
    },
    authorizedTransientModelLease(lease.value, reauthorize),
  );
  const acceptedInput: AcceptedInputRef = {
    kind: "case",
    inputId: input.inputId,
    caseId: input.caseId,
    assignmentId: input.assignmentId,
    caseRevision: input.caseRevision,
    contentDigest: input.contentDigest,
    workspaceRevision: input.workspaceRevision,
    contextBundleDigest: input.contextBundleDigest,
  };

  let goalExecution;
  try {
    goalExecution = await createTransientGoalExecution(
      context,
      turnLease,
      input.caseId,
      input.allowanceTokens,
    );
  } catch (error) {
    return { ok: false, error: transientModelAdmissionError(error) };
  }
  try {
    const result = await runTransientEmailTurnWithSinks({
      adapter,
      construction: {
        persistence: { kind: "transient" },
        source: { kind: "fresh" },
        inheritedHistory: [],
        inheritedAttachments: {},
        sessionId: parsedSessionId.value,
        acceptedInput,
        model: contract.modelRoute.model,
        modelTokenAllowance: input.allowanceTokens,
        goalModelCalls: goalExecution.control,
        harnessInstructions: input.harnessInstructions,
        modelRouteLease,
        checkpointBinding: {
          cursor: null,
          modelRouteDigest: await digestModelRoute(contract.modelRoute),
          instructionDigest: await digestCanonical({
            kind: "pantry_transient_email_instructions_v1",
            instructions: input.harnessInstructions,
          }),
          toolCatalogDigest: toolHost.catalogDigest,
          workspaceRevision: input.workspaceRevision,
          policyRevision: String(contract.policyVersion),
        },
        toolRules,
        toolHost: admittedSessionToolHost(
          {
            kind: "transient",
            admission: execution,
            lease: turnLease,
            isOpen: isTransientHarnessOpen.bind(null, transient),
          },
          toolHost,
        ),
        turnLease,
        now: Date.now,
      },
      input: [{ kind: "text", text: input.turnPrompt }],
      onTurnStarted: admitTransientHarnessTurn.bind(null, execution, transient),
      onTurnSettled: settleTransientHarnessTurn.bind(null, transient),
      maxBodyChars: input.maxBodyChars,
      maxWallMs: input.maxWallMs,
      teardown: startNoTransientTeardown,
    });
    if (result.ok && goalExecution.state.stop !== null) {
      return {
        ok: false,
        error: {
          code: "transient_goal_stopped",
          modelUsage: result.value.modelUsage,
        },
      };
    }
    return result;
  } finally {
    await goalExecution.close();
  }
}

/** The usage of an attempt that ended before any provider request. */
export const KNOWN_ZERO_MODEL_USAGE = {
  modelCalls: 0,
  callsWithUsage: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
} as const;

export function transientModelAdmissionError(
  error: unknown,
): TransientModelTurnError {
  return {
    code: error instanceof Error ? error.message : "goal_admission_unavailable",
    // Admission precedes provider dispatch, so this attempt has known zero usage.
    modelUsage: KNOWN_ZERO_MODEL_USAGE,
  };
}

export function projectItemForSnapshot(
  digest: string,
  item: import("../../context/assembly").ContextBundle["items"][number],
): boolean {
  return (
    item.source.kind === "project_observation" &&
    item.source.snapshotDigest === digest
  );
}
