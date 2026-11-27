import type {
  EvalCommandReceipt,
  MemoryCommandReceipt,
} from "@purin-labs/control-api";
import type { PlacedActorRpc } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { CaseExecutionEffectRecords } from "@purin-labs/agent/case-execution/records";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationCommandFailure } from "@purin-labs/tenancy/actors/organisation/types";
import type {
  AcceptedMemoryCursor,
  MemoryCommandError,
  MemoryReadError,
  SerializedAcceptedMemory,
  SerializedMemory,
} from "../memory/store";
import type {
  EvalCommandError,
  EvalReadError,
  SerializedEval,
  SerializedEvalRunResult,
} from "../evals/store";

/**
 * The RPC methods of the Organisation Actor that Brain calls: the Memories,
 * the Evals and the effects of a Case execution. `OrganisationDO`, the class
 * of the Worker, implements this interface, and Brain names it, not the
 * class. The class gives the comment of each method.
 */
export interface OrganisationBrainRpc {
  readMemories(
    input: Readonly<{ organisationId: OrganisationId }>,
  ): Promise<
    Result<
      readonly SerializedMemory[],
      OrganisationCommandFailure | MemoryReadError
    >
  >;
  readMemory(
    input: Readonly<{ organisationId: OrganisationId; memoryId: string }>,
  ): Promise<
    Result<
      SerializedMemory | null,
      OrganisationCommandFailure | MemoryReadError | { code: "memory_invalid" }
    >
  >;
  readMemoryCommandReceipt(
    input: Readonly<{ organisationId: OrganisationId; commandId: string }>,
  ): Promise<Result<MemoryCommandReceipt | null, OrganisationCommandFailure>>;
  readAcceptedMemories(
    input: Readonly<{
      organisationId: OrganisationId;
      applicabilityKeys: readonly string[];
      after: AcceptedMemoryCursor | null;
      limit: number;
    }>,
  ): Promise<
    Result<
      Readonly<{
        accepted: readonly SerializedAcceptedMemory[];
        next: AcceptedMemoryCursor | null;
      }>,
      OrganisationCommandFailure | MemoryReadError | { code: "memory_invalid" }
    >
  >;
  readAcceptedMemoryRevisions(
    input: Readonly<{
      organisationId: OrganisationId;
      memoryIds: readonly string[];
    }>,
  ): Promise<
    Result<
      readonly SerializedAcceptedMemory[],
      OrganisationCommandFailure | MemoryReadError | { code: "memory_invalid" }
    >
  >;
  commandMemory(
    input: Readonly<{
      organisationId: OrganisationId;
      principal: unknown;
      body: unknown;
      flowLabel: unknown;
    }>,
  ): Promise<
    Result<
      MemoryCommandReceipt,
      OrganisationCommandFailure | MemoryCommandError
    >
  >;
  readEvals(
    input: Readonly<{ organisationId: OrganisationId }>,
  ): Promise<
    Result<
      readonly SerializedEval[],
      OrganisationCommandFailure | EvalReadError
    >
  >;
  readEval(
    input: Readonly<{ organisationId: OrganisationId; evalId: string }>,
  ): Promise<
    Result<
      SerializedEval | null,
      OrganisationCommandFailure | EvalReadError | { code: "eval_invalid" }
    >
  >;
  readEvalCommandReceipt(
    input: Readonly<{ organisationId: OrganisationId; commandId: string }>,
  ): Promise<Result<EvalCommandReceipt | null, OrganisationCommandFailure>>;
  commandEval(
    input: Readonly<{
      organisationId: OrganisationId;
      principal: unknown;
      body: unknown;
      flowLabel: unknown;
    }>,
  ): Promise<
    Result<EvalCommandReceipt, OrganisationCommandFailure | EvalCommandError>
  >;
  settleEvalRun(
    input: Readonly<{
      organisationId: OrganisationId;
      result: unknown;
      flowLabel: unknown;
    }>,
  ): Promise<
    Result<
      Readonly<{ kind: "recorded" | "already_recorded" }>,
      OrganisationCommandFailure | EvalCommandError
    >
  >;
  readEvalRunResults(
    input: Readonly<{ organisationId: OrganisationId; evalId: string }>,
  ): Promise<
    Result<
      readonly SerializedEvalRunResult[],
      OrganisationCommandFailure | { code: "eval_invalid" }
    >
  >;
  readCaseExecutionEffects(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ): Promise<CaseExecutionEffectRecords | null>;
}

/** The Organisation Actor as Brain sees it: its placement and its Brain RPC. */
export type BrainOrganisationActor = PlacedActorRpc & OrganisationBrainRpc;

/** The stub of the Organisation Actor that Brain calls. */
export type BrainOrganisationStub = DurableObjectStub<BrainOrganisationActor>;
