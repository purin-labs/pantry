import type { OrganisationDatabase } from "../../database-handles";
import type {
  ContextAssemblyStrategyVersion,
  ContextBundle,
  CanonicalContextSourceRef,
  ModelContextBundle,
  ModelContextItem,
  ModelContextSourceKind,
  Sha256Digest,
} from "./types";
import type { RequestAuthority } from "@seams/contracts";
import type { CaseContextReplayAuthority } from "../projection";

export type {
  CanonicalContextSourceRef,
  ContextAssemblyStrategyVersion,
  ContextBundle,
  ContextBundleDisposition,
  ContextFreshness,
  ContextItem,
  ContextProjectionRevision,
  ContextRetrievalEvidence,
  ContextVisibility,
  ModelContextBundle,
  ModelContextItem,
  ModelContextSourceKind,
  PolicyVersion,
  WorkflowAuthorityKind,
} from "./types";
export type { CaseContextReplayAuthority } from "../projection";
export type { FlowLabel, ObservationEvidence } from "../../policy";

import type {
  AssignmentId,
  CaseId,
  SessionId,
  OrganisationId,
} from "../../ids";
import type { ContextProjectionReader } from "../projection";
import type {
  ContextProjectionRevision,
  ContextVisibility,
  PolicyVersion,
  Timestamp,
} from "./types";
import type { FlowRecipient } from "../../policy/information-flow/types";
import type {
  FlowLabel,
  ObservationEvidence,
  SerializedFlowLabel,
} from "../../policy";
import type { Variant } from "@seams/type-utils";
export {
  assembleCommerceContext,
  selectCommerceContextSourceGrant,
  selectNamedCommerceQuerySourceGrant,
  prepareNamedCommerceQuery,
  type CommerceContextAssemblyError,
} from "./commerce";

export const CONTEXT_ASSEMBLY_STRATEGY_VERSION: ContextAssemblyStrategyVersion =
  "context_assembly_v1";

export type ContextAssemblyScope = "case" | "workspace";

/**
 * The assembler receives only this already-authorized read permit. Authority
 * compilation and revocation checks stay in turn-context.ts.
 */
export type ContextReadFields = {
  readonly db: OrganisationDatabase;
  readonly kind: "authorized_context_read";
  readonly organisationId: OrganisationId;
  readonly caseId: CaseId;
  readonly assignmentId: AssignmentId;
  readonly sessionId: SessionId;
  readonly requestAuthority: RequestAuthority;
  readonly authorityPartitionDigest: Sha256Digest;
  readonly contextVisibility: readonly ContextVisibility[];
  readonly policyVersion: PolicyVersion;
  readonly assemblyStrategyVersion: ContextAssemblyStrategyVersion;
  readonly query: string;
  readonly itemLimit: number;
  readonly tokenLimit: number;
  /** Selection deadline for optional projections; canonical tail remains item/token bounded. */
  readonly timeLimitMs: number;
  readonly freshnessBoundMs: number;
  readonly assembledAt: Timestamp;
  readonly projectionReader: ContextProjectionReader;
  readonly tailReader: CaseContextTailReader;
  readonly memoryReader: TurnMemoryReader;
  /** How long the Memory read may take. The selection deadline does not bound it. */
  readonly memoryDeadlineMs: number;
  /**
   * The one verified recipient everything this turn produces is bound to, or
   * null. Memory bound to a recipient is admitted only to a turn bound to
   * that exact recipient. Trusted code derives it; no request supplies it.
   */
  readonly replyRecipient: FlowRecipient | null;
};

export type { AuthorizedContextRead } from "../turn-context";

/**
 * The organisation record a Memory is observed as. Its revision is the
 * observation's source revision.
 */
export function memoryObservationRecordId(memoryId: string): string {
  return `memory:${memoryId}`;
}

/** One accepted Memory revision offered to a turn, with its recorded label. */
export type TurnMemoryCandidate = {
  readonly organisationId: OrganisationId;
  readonly memoryId: string;
  readonly revision: number;
  /** What the model reads: the statement with where and when it holds. */
  readonly boundedExcerpt: string;
  readonly contentDigest: Sha256Digest;
  readonly inputLabel: SerializedFlowLabel;
  readonly acceptedAt: Timestamp;
};

/** What the assembler asks of one Memory read. */
export type TurnMemoryReadRequest = Readonly<{
  /** The most revisions the turn could select. */
  limit: number;
  /** Whether this turn's own authority may be shown content under a label. */
  admits: (label: FlowLabel) => Promise<boolean>;
}>;

/**
 * The result of one Memory read. `unavailable` means a lookup failed, so
 * nothing is known. `invalid_state` means persisted Memory failed
 * verification, which is a fault and not an absence.
 */
export type TurnMemoryRead =
  | Readonly<{
      kind: "read";
      candidates: readonly TurnMemoryCandidate[];
      /**
       * A further revision that passed every check exists beyond the limit.
       * Revisions this turn may not be shown never set it.
       */
      more: boolean;
    }>
  | Readonly<{ kind: "unavailable"; candidates?: never; more?: never }>
  | Readonly<{ kind: "invalid_state"; candidates?: never; more?: never }>;

/**
 * Reads the accepted Memory that applies to one turn. It offers only
 * revisions that currently hold, whose dependencies are known to resolve,
 * that the turn's destination audience is known to accept, and that the
 * turn's own authority admits. It examines every applicable revision before
 * it applies the limit, so one the turn may not be shown can neither crowd
 * out nor reveal another.
 */
export interface TurnMemoryReader {
  read(request: TurnMemoryReadRequest): Promise<TurnMemoryRead>;
}

export type CaseContextTailCandidate = {
  readonly organisationId: OrganisationId;
  readonly source: Variant<CanonicalContextSourceRef, "case_entry">;
  readonly replayAuthority: CaseContextReplayAuthority;
  readonly sourceRevision: ContextProjectionRevision;
  readonly contentDigest: Sha256Digest;
  readonly boundedExcerpt: string;
  readonly inputLabel: SerializedFlowLabel;
  readonly observedAt: Timestamp;
};

export interface CaseContextTailReader {
  readTail(
    input: Readonly<{
      readonly organisationId: OrganisationId;
      readonly caseId: CaseId;
      readonly authorityPartitionDigest: Sha256Digest;
      readonly visibility: readonly ContextVisibility[];
      readonly limit: number;
    }>,
  ): Promise<readonly CaseContextTailCandidate[]>;
}

export type ContextAssemblyError =
  | { readonly code: "tail_unavailable" }
  | { readonly code: "memory_state_invalid" }
  | { readonly code: "invalid_candidate" };

export type ContextAssemblyResult = {
  readonly bundle: ContextBundle;
  readonly bundleDigest: Sha256Digest;
  readonly modelContext: ModelContextBundle;
};

export function materializeContextBundle(
  bundle: Pick<
    ContextBundle,
    "assemblyStrategyVersion" | "items" | "disposition"
  > &
    Readonly<{ memory?: ContextBundle["memory"] }>,
): ModelContextBundle {
  const items: ModelContextItem[] = [];
  for (const item of bundle.items) {
    if (item.provenance.kind === "native_chat_input") continue;
    items.push({
      sourceKind: modelSourceKind(item.source),
      provenance: modelProvenance(item),
      boundedExcerpt: item.boundedExcerpt,
      observedAt: item.observedAt,
      freshness: item.freshness,
    });
  }
  const context: ModelContextBundle = {
    assemblyStrategyVersion: bundle.assemblyStrategyVersion,
    items,
    disposition: bundle.disposition,
  };
  // The key is present only when Memory was withheld from the model.
  return bundle.memory?.kind === "limited" ||
    bundle.memory?.kind === "unavailable"
    ? { ...context, memoryLimitation: bundle.memory.kind }
    : context;
}

export async function digestContextBundle(
  bundle: ContextBundle,
): Promise<Sha256Digest> {
  return digestCanonicalBundle({
    ...canonicalBundleFields(bundle),
    memory: canonicalMemoryOutcome(bundle.memory),
  });
}

/**
 * The digest of a bundle accepted before Memory admission, which records no
 * Memory outcome. Only stored history is verified with it.
 */
export async function digestHistoricalContextBundle(
  bundle: Omit<ContextBundle, "memory">,
): Promise<Sha256Digest> {
  return digestCanonicalBundle(canonicalBundleFields(bundle));
}

function canonicalBundleFields(
  bundle: Omit<ContextBundle, "memory">,
): Record<string, unknown> {
  return {
    organisationId: bundle.organisationId,
    caseId: bundle.caseId,
    assignmentId: bundle.assignmentId,
    sessionId: bundle.sessionId,
    policyVersion: bundle.policyVersion,
    assemblyStrategyVersion: bundle.assemblyStrategyVersion,
    assembledAt: bundle.assembledAt,
    items: bundle.items.map(canonicalContextItem),
    usage: bundle.usage,
    disposition: bundle.disposition,
  };
}

async function digestCanonicalBundle(
  canonical: Record<string, unknown>,
): Promise<Sha256Digest> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(digest), formatHexByte).join("");
}

function canonicalContextItem(item: ContextBundle["items"][number]): unknown {
  return {
    source: canonicalSource(item.source),
    provenance: item.provenance,
    sourceRevision: item.sourceRevision,
    contentDigest: item.contentDigest,
    boundedExcerpt: item.boundedExcerpt,
    inputLabel: item.inputLabel.toJSON(),
    observationEvidence: canonicalObservationEvidence(item.observationEvidence),
    observedAt: item.observedAt,
    freshness: canonicalFreshness(item.freshness),
    retrievalEvidence: {
      exactPhraseMatch: item.retrievalEvidence.exactPhraseMatch,
      tokenOverlapMillionths: item.retrievalEvidence.tokenOverlapMillionths,
      recencyRank: item.retrievalEvidence.recencyRank,
    },
  };
}

function canonicalMemoryOutcome(memory: ContextBundle["memory"]): unknown {
  switch (memory.kind) {
    case "none":
      return { kind: memory.kind };
    case "admitted":
      return {
        kind: memory.kind,
        revisions: memory.revisions.map(canonicalMemoryRef),
      };
    case "limited":
      return {
        kind: memory.kind,
        revisions: memory.revisions.map(canonicalMemoryRef),
        reason: memory.reason,
      };
    case "unavailable":
      return { kind: memory.kind, reason: memory.reason };
  }
}

function canonicalMemoryRef(
  ref: Readonly<{ memoryId: string; revision: number }>,
): unknown {
  return { memoryId: ref.memoryId, revision: ref.revision };
}

function canonicalSource(
  source: ContextBundle["items"][number]["source"],
): unknown {
  switch (source.kind) {
    case "project_observation":
      return source;
    case "memory":
      return {
        kind: source.kind,
        memoryId: source.memoryId,
        revision: source.revision,
      };
    case "case_entry":
      return {
        kind: source.kind,
        caseId: source.caseId,
        entryId: source.entryId,
      };
    case "file_segment":
      return {
        kind: source.kind,
        integrationAccountId: source.integrationAccountId,
        provider: source.provider,
        providerFileId: source.providerFileId,
        segmentIndex: source.segmentIndex,
      };
  }
}

function canonicalFreshness(
  freshness: ContextBundle["items"][number]["freshness"],
): unknown {
  if (freshness.kind === "fresh") return { kind: "fresh" };
  return { kind: "stale", ageMs: freshness.ageMs, reason: freshness.reason };
}

function canonicalObservationEvidence(evidence: ObservationEvidence): unknown {
  return {
    source: canonicalObservationSource(evidence.source),
    sourceRevision: evidence.sourceRevision,
    contentDigest: evidence.contentDigest,
    flowLabelDigest: evidence.flowLabelDigest,
    observedAt: evidence.observedAt,
    evidenceDigest: evidence.evidenceDigest,
  };
}

function canonicalObservationSource(
  source: ObservationEvidence["source"],
): unknown {
  return source;
}

function modelSourceKind(
  source: ContextBundle["items"][number]["source"],
): ModelContextSourceKind {
  switch (source.kind) {
    case "project_observation":
      return "project_context";
    case "memory":
      return "memory";
    case "case_entry":
      return "case_conversation";
    case "file_segment":
      return "integration_file";
  }
}

function modelProvenance(
  item: ContextBundle["items"][number],
): ModelContextItem["provenance"] {
  const provenance = item.provenance;
  switch (provenance.kind) {
    case "memory":
      if (item.source.kind !== "memory")
        throw new Error("memory provenance does not match its source");
      return {
        kind: "memory",
        memoryId: item.source.memoryId,
        revision: item.source.revision,
      };
    case "native_chat_input":
    case "project_context":
    case "case_entry":
      return { kind: provenance.kind };
    case "integration_file":
      return {
        kind: provenance.kind,
        provider: provenance.provider,
        displayName: provenance.displayName,
        displayPath: provenance.displayPath,
        deepLink: provenance.deepLink,
        mediaType: provenance.mediaType,
        metadataOnlyReason: provenance.metadataOnlyReason,
      };
  }
}

export function normalizeContextQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function formatHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}
