import type {
  CanonicalContextSourceRef,
  ContextProjectionProvenance,
  ContextProjectionRevision,
  ContextRetrievalEvidence,
  Sha256Digest,
  Timestamp,
} from "../projection";
import type {
  FlowLabel,
  ObservationEvidence,
} from "@purin-labs/authority/policy/index";
import type { FileContextProvider } from "@purin-labs/contracts";

export type { ContextVisibility } from "@purin-labs/authority/authorization/access-grants/types";

export type {
  CanonicalContextSourceRef,
  ContextProjectionProvenance,
  ContextProjectionRevision,
  ContextRetrievalEvidence,
  Sha256Digest,
  Timestamp,
} from "../projection";

export type ContextAssemblyStrategyVersion = "context_assembly_v1";
export type PolicyVersion = string;

export type ContextFreshness =
  | { readonly kind: "fresh" }
  | { readonly kind: "stale"; readonly ageMs: number; readonly reason: string };

export type ContextBundleDisposition =
  | { readonly kind: "complete" }
  | {
      readonly kind: "truncated";
      readonly limitingDimension: "items" | "tokens" | "time";
    };

/** One exact accepted Memory revision. */
type ContextMemoryRef = Readonly<{
  memoryId: string;
  revision: number;
}>;

/**
 * What became of accepted Memory for one turn.
 *
 * `none` means the read completed and found no Memory that applies to the
 * turn and that both its authority and its destination may receive.
 * `limited` means it found some and a size limit omitted at least one.
 * `unavailable` means a lookup did not complete, which says nothing about
 * whether any Memory applies.
 */
export type ContextMemoryOutcome =
  | Readonly<{ kind: "none"; revisions?: never; reason?: never }>
  | Readonly<{
      kind: "admitted";
      revisions: readonly ContextMemoryRef[];
      reason?: never;
    }>
  | Readonly<{
      kind: "limited";
      revisions: readonly ContextMemoryRef[];
      reason: "items" | "tokens";
    }>
  | Readonly<{
      kind: "unavailable";
      reason: "deadline" | "read_failed";
      revisions?: never;
    }>;

export type ContextItem = {
  readonly source:
    | CanonicalContextSourceRef
    | Readonly<{
        kind: "project_observation";
        source: import("@purin-labs/authority/policy/information-flow/index").FlowSource;
        snapshotDigest: string;
      }>
    | (ContextMemoryRef & Readonly<{ kind: "memory" }>);
  readonly provenance:
    | ContextProjectionProvenance
    | Readonly<{ kind: "project_context" | "native_chat_input" | "memory" }>;
  readonly sourceRevision: ContextProjectionRevision;
  readonly contentDigest: Sha256Digest;
  readonly boundedExcerpt: string;
  readonly inputLabel: FlowLabel;
  readonly observationEvidence: ObservationEvidence;
  readonly observedAt: Timestamp;
  readonly freshness: ContextFreshness;
  readonly retrievalEvidence: ContextRetrievalEvidence;
};

export type ContextBundle = {
  readonly organisationId: string;
  readonly caseId: string;
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly policyVersion: PolicyVersion;
  readonly assemblyStrategyVersion: ContextAssemblyStrategyVersion;
  readonly assembledAt: Timestamp;
  readonly items: readonly ContextItem[];
  readonly usage: {
    readonly items: number;
    readonly estimatedTokens: number;
  };
  readonly disposition: ContextBundleDisposition;
  readonly memory: ContextMemoryOutcome;
};

export type ModelContextSourceKind =
  "case_conversation" | "integration_file" | "project_context" | "memory";

type ModelContextProvenance =
  | Readonly<{ kind: "project_context" | "native_chat_input" }>
  | (ContextMemoryRef & Readonly<{ kind: "memory" }>)
  | Readonly<{ readonly kind: "case_entry" }>
  | Readonly<{
      readonly kind: "integration_file";
      readonly provider: FileContextProvider;
      readonly displayName: string;
      readonly displayPath: string;
      readonly deepLink: string;
      readonly mediaType: string;
      readonly metadataOnlyReason: string | null;
    }>;

export type ModelContextItem = {
  readonly sourceKind: ModelContextSourceKind;
  readonly provenance: ModelContextProvenance;
  readonly boundedExcerpt: string;
  readonly observedAt: Timestamp;
  readonly freshness: ContextFreshness;
};

export type ModelContextBundle = {
  readonly assemblyStrategyVersion: ContextAssemblyStrategyVersion;
  readonly items: readonly ModelContextItem[];
  readonly disposition: ContextBundleDisposition;
  /** Present only when some accepted Memory could not be given to the model. */
  readonly memoryLimitation?: "limited" | "unavailable";
};
