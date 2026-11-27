import {
  createTransientGoalExecution,
  type GoalUsageContext,
} from "@purin-labs/agent/actors/session-goal-usage";
import type {
  EmbeddedHarnessConstructionInput,
  HarnessToolHost,
} from "@purin-labs/agent/actors/embedded-harness";
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
} from "@purin-labs/agent/actors/session-execution-admission";
import { digestModelRoute } from "@purin-labs/agent/models/route";
import {
  runTransientEmailTurn as runTransientEmailTurnWithSinks,
  type TransientEmailTurnSuccess,
} from "./transient-email-turn";
import { selectEmbeddedHarnessAdapterForModelRoute } from "@purin-labs/agent/actors/embedded-harness-adapter";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import {
  authorizedTransientModelLease,
  createEmbeddedHarnessModelRouteLease,
} from "@purin-labs/agent/actors/session/model-route";
import type { TransientSessionExecution } from "@purin-labs/agent/actors/session/support";
import {
  KNOWN_ZERO_MODEL_USAGE,
  transientModelAdmissionError,
} from "@purin-labs/agent/actors/session/transient-turns";
import {
  admitTransientHarnessTurn,
  isTransientHarnessOpen,
  settleTransientHarnessTurn,
  startNoTransientTeardown,
} from "@purin-labs/agent/actors/session/turn-completion";
import type {
  TransientHarnessTurnInput,
  TransientModelTurnError,
} from "@purin-labs/agent/actors/session/types";

/**
 * The mail turn of a session: one transient harness turn whose final message
 * is the body of an email, bound to the Case input that the Inbox gives.
 */
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
): Promise<Result<TransientEmailTurnSuccess, TransientModelTurnError>> {
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
  // A pinned model that left its list makes no provider request.
  if (!adapter.ok)
    return {
      ok: false,
      error: { code: adapter.error.code, modelUsage: KNOWN_ZERO_MODEL_USAGE },
    };
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
      adapter: adapter.value,
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
