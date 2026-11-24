import type {
  MemoryApplicability,
  MemoryCommandErrorCode,
  MemoryEvidence,
  MemoryView,
  EvalContent,
} from "@purin-labs/control-api";
import type { TurnMemoryReader } from "@purin-labs/agent/context/assembly/index";
import type { FlowLabel } from "@purin-labs/authority/policy/information-flow/index";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { AuthorizedConversationScope } from "@purin-labs/tenancy/organisation-access/access";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Variant } from "@purin-labs/type-utils";
import { definePort } from "@purin-labs/kernel/port";
import type { ShownMemoryRevision } from "./turn-memory";

export type MemoryAccessError = Readonly<{
  code:
    | MemoryCommandErrorCode
    /** A cited record has no recorded provenance this boundary can verify. */
    | "memory_evidence_unsupported";
}>;

/** Where a cited record is read from. */
export type RecordScope = Readonly<{
  env: Env;
  organisationId: OrganisationId;
  execution: OrganisationExecutionScope;
}>;

/**
 * What one turn concerns. A Memory applies only when its scope names one of
 * these exactly: a skill the turn loaded, a commerce resource class it reads,
 * or the commerce entity it is about.
 */
type TurnMemorySubjects = Readonly<{
  applicability: readonly MemoryApplicability[];
}>;

/** Whether a turn's destination audience may receive content under a label. */
export type TurnMemoryDestination = (
  label: FlowLabel,
) => Promise<"allow" | "deny" | "unavailable">;

/** The turn that a Memory reader reads for. */
export type TurnMemoryReaderInput = Readonly<{
  env: Env;
  execution: OrganisationExecutionScope;
  organisationId: OrganisationId;
  subjects: TurnMemorySubjects;
  destinationMayReceive: TurnMemoryDestination;
  now: number;
}>;

/** The eval task that a Memory reader reads for, with its candidate. */
export type EvalTurnMemoryReaderInput = TurnMemoryReaderInput &
  Readonly<{
    candidate: ShownMemoryRevision | null;
    /**
     * Called when the candidate applies to this turn: `true` when it was
     * offered, `false` when this turn may not be shown it.
     */
    onCandidateDecided?: (offered: boolean) => void;
  }>;

/** The agent turn and the reviewed correction that a candidate comes from. */
export type MemoryCorrectionProposal = Readonly<{
  env: Env;
  execution: OrganisationExecutionScope;
  organisationId: OrganisationId;
  agent: Readonly<{
    caseId: string;
    assignmentId: string;
    sessionId: string;
  }>;
  correction: Variant<MemoryEvidence, "proposal_correction">;
  turnLabel: FlowLabel;
  statement: string;
  applicability: MemoryApplicability;
  now: number;
}>;

export type MemoryCorrectionProposalResult = Result<
  Readonly<{
    kind: "proposed" | "already_proposed";
    memoryId: string;
    revision: number;
  }>,
  Readonly<{ code: "memory_evidence_unavailable" | "memory_unavailable" }>
>;

/** The agent turn and the reviewed correction that an Eval candidate comes from. */
export type EvalCorrectionProposal = Readonly<{
  env: Env;
  execution: OrganisationExecutionScope;
  organisationId: OrganisationId;
  agent: Readonly<{
    caseId: string;
    assignmentId: string;
    sessionId: string;
  }>;
  correction: Variant<MemoryEvidence, "proposal_correction">;
  turnLabel: FlowLabel;
  title: string;
  scenario: EvalContent["scenarios"][number];
}>;

export type EvalCorrectionProposalResult = Result<
  Readonly<{
    kind: "proposed" | "already_proposed";
    evalId: string;
    revision: number;
  }>,
  Readonly<{ code: "eval_evidence_unavailable" | "eval_unavailable" }>
>;

type ReadMemoryViews = (
  env: Env,
  scope: AuthorizedConversationScope,
  execution?: OrganisationExecutionScope,
) => Promise<Result<readonly MemoryView[], MemoryAccessError>>;

type ReadShownMemoryStanding = (
  input: RecordScope &
    Readonly<{ revisions: readonly ShownMemoryRevision[]; now: number }>,
) => Promise<"in_force" | "changed" | "unavailable">;

type CreateTurnMemoryReader = (
  input: TurnMemoryReaderInput,
) => TurnMemoryReader;

export type CreateEvalTurnMemoryReader = (
  input: EvalTurnMemoryReaderInput,
) => TurnMemoryReader;

type ProposeMemoryFromCorrection = (
  input: MemoryCorrectionProposal,
) => Promise<MemoryCorrectionProposalResult>;

type ProposeEvalFromCorrection = (
  input: EvalCorrectionProposal,
) => Promise<EvalCorrectionProposalResult>;

/**
 * The Memory service of Brain, as a service interface of its contract. The
 * Inbox reads the Memory that a person may see, the standing of the Memory
 * that a turn was shown and the Memory of a mailbox turn, and it proposes a
 * Memory and an Eval from a correction. The Memory store stays private: only
 * Brain makes a Memory revision. The Worker registers the implementation
 * (`worker-ports.ts`).
 */
export type MemoryService = Readonly<{
  /** Every Memory that a person may inspect in full. */
  readMemoryViews: ReadMemoryViews;
  /** Whether the Memory that a turn was shown still stands. */
  readShownMemoryStanding: ReadShownMemoryStanding;
  /** The Memory reader of one turn, for the destination of the turn. */
  createTurnMemoryReader: CreateTurnMemoryReader;
  /** Proposes a Memory candidate from a corrected reply. */
  proposeMemoryFromCorrection: ProposeMemoryFromCorrection;
  /** Proposes an Eval candidate from a corrected reply. */
  proposeEvalFromCorrection: ProposeEvalFromCorrection;
}>;

/** The person and the conversation of a Memory read. */
export type MemoryReadScope = Parameters<MemoryService["readMemoryViews"]>[1];

export const memoryService = definePort<MemoryService>("memory_service");
