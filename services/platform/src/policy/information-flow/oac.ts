import { parseFlowReader as parseContextVisibility } from "./readers";
import { parseCaseId } from "../../ids";
import type { Result } from "../../result";
import { digestCanonical } from "./digest";
import {
  canonicalFlowLabel,
  emptyFlowLabel,
  FlowLabel,
  joinFlowLabels,
} from "./labels";
import type {
  AdvanceInformationFlowContextResult,
  FlowBindingError,
  FlowSource,
  InformationFlowContextError,
  ObservationEvidenceError,
  SerializedFlowBinding,
  SerializedInformationFlowContext,
  SerializedObservationEvidence,
} from "./types";
import {
  isNonBlankString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  isSha256Hex,
} from "@seams/std";

export class ObservationEvidence {
  readonly source: FlowSource;
  readonly sourceRevision: number;
  readonly contentDigest: string;
  readonly flowLabelDigest: string;
  readonly observedAt: number;
  readonly evidenceDigest: string;
  readonly #observationEvidence = true;

  private constructor(
    input: Readonly<{
      readonly source: FlowSource;
      readonly sourceRevision: number;
      readonly contentDigest: string;
      readonly flowLabelDigest: string;
      readonly observedAt: number;
      readonly evidenceDigest: string;
    }>,
  ) {
    this.source = input.source;
    this.sourceRevision = input.sourceRevision;
    this.contentDigest = input.contentDigest;
    this.flowLabelDigest = input.flowLabelDigest;
    this.observedAt = input.observedAt;
    this.evidenceDigest = input.evidenceDigest;
    Object.freeze(this.source);
    Object.freeze(this);
  }

  static async create(
    input: Readonly<{
      readonly source: FlowSource;
      readonly sourceRevision: number;
      readonly contentDigest: string;
      readonly inputLabel: FlowLabel;
      readonly observedAt: number;
    }>,
  ): Promise<Result<ObservationEvidence, ObservationEvidenceError>> {
    if (!FlowLabel.is(input.inputLabel))
      return invalidObservation("inputLabel");
    const invalidField = invalidObservationInput(input);
    if (invalidField !== null) return invalidObservation(invalidField);
    const canonical = canonicalObservation({
      source: input.source,
      sourceRevision: input.sourceRevision,
      contentDigest: input.contentDigest,
      flowLabelDigest: input.inputLabel.digest,
      observedAt: input.observedAt,
    });
    const evidenceDigest = await digestCanonical(
      canonicalObservationIdentity(canonical),
    );
    return {
      ok: true,
      value: new ObservationEvidence({ ...canonical, evidenceDigest }),
    };
  }

  static async restore(
    raw: unknown,
  ): Promise<Result<ObservationEvidence, ObservationEvidenceError>> {
    if (!isRecord(raw)) return invalidObservation("shape");
    const source = parseFlowSource(raw.source);
    if (source === null) return invalidObservation("source");
    if (!isPositiveInteger(raw.sourceRevision))
      return invalidObservation("sourceRevision");
    if (!isSha256Hex(raw.contentDigest))
      return invalidObservation("contentDigest");
    if (!isSha256Hex(raw.flowLabelDigest))
      return invalidObservation("flowLabelDigest");
    if (!isNonNegativeInteger(raw.observedAt))
      return invalidObservation("observedAt");
    if (!isSha256Hex(raw.evidenceDigest))
      return invalidObservation("evidenceDigest");
    const canonical = canonicalObservation({
      source,
      sourceRevision: raw.sourceRevision,
      contentDigest: raw.contentDigest,
      flowLabelDigest: raw.flowLabelDigest,
      observedAt: raw.observedAt,
    });
    const digest = await digestCanonical(
      canonicalObservationIdentity(canonical),
    );
    return digest === raw.evidenceDigest
      ? {
          ok: true,
          value: new ObservationEvidence({
            ...canonical,
            evidenceDigest: digest,
          }),
        }
      : { ok: false, error: { code: "observation_evidence_digest_mismatch" } };
  }

  toJSON(): SerializedObservationEvidence {
    return {
      ...canonicalObservation(this),
      evidenceDigest: this.evidenceDigest,
    };
  }

  static is(value: unknown): value is ObservationEvidence {
    return (
      typeof value === "object" &&
      value !== null &&
      #observationEvidence in value
    );
  }
}

export class InformationFlowContext {
  readonly organisationId: string;
  readonly sessionId: string;
  readonly authorityPartitionDigest: string;
  readonly workLabel: FlowLabel;
  readonly observationDigests: readonly string[];
  readonly observationSetDigest: string;
  readonly revision: number;
  readonly digest: string;
  readonly #informationFlowContext = true;

  private constructor(
    input: Readonly<{
      readonly organisationId: string;
      readonly sessionId: string;
      readonly authorityPartitionDigest: string;
      readonly workLabel: FlowLabel;
      readonly observationDigests: readonly string[];
      readonly observationSetDigest: string;
      readonly revision: number;
      readonly digest: string;
    }>,
  ) {
    this.organisationId = input.organisationId;
    this.sessionId = input.sessionId;
    this.authorityPartitionDigest = input.authorityPartitionDigest;
    this.workLabel = input.workLabel;
    this.observationDigests = input.observationDigests;
    this.observationSetDigest = input.observationSetDigest;
    this.revision = input.revision;
    this.digest = input.digest;
    Object.freeze(this.observationDigests);
    Object.freeze(this);
  }

  static async create(
    input: Readonly<{
      readonly organisationId: string;
      readonly sessionId: string;
      readonly authorityPartitionDigest: string;
    }>,
  ): Promise<Result<InformationFlowContext, InformationFlowContextError>> {
    if (!isNonBlankString(input.organisationId))
      return invalidContext("organisationId");
    if (!isNonBlankString(input.sessionId)) return invalidContext("sessionId");
    if (!isSha256Hex(input.authorityPartitionDigest)) {
      return invalidContext("authorityPartitionDigest");
    }
    const workLabel = await emptyFlowLabel();
    return createContext({
      ...input,
      workLabel,
      observationDigests: [],
      revision: 0,
    });
  }

  static async fromState(
    input: Readonly<{
      readonly organisationId: string;
      readonly sessionId: string;
      readonly authorityPartitionDigest: string;
      readonly workLabel: FlowLabel;
      readonly observationDigests: readonly string[];
      readonly revision: number;
    }>,
  ): Promise<Result<InformationFlowContext, InformationFlowContextError>> {
    if (!isNonBlankString(input.organisationId))
      return invalidContext("organisationId");
    if (!isNonBlankString(input.sessionId)) return invalidContext("sessionId");
    if (!isSha256Hex(input.authorityPartitionDigest)) {
      return invalidContext("authorityPartitionDigest");
    }
    if (!FlowLabel.is(input.workLabel)) return invalidContext("workLabel");
    if (!Array.isArray(input.observationDigests))
      return invalidContext("observationDigests");
    if (!isNonNegativeInteger(input.revision))
      return invalidContext("revision");
    const canonicalDigests = [...new Set(input.observationDigests)].sort();
    if (
      canonicalDigests.length !== input.observationDigests.length ||
      canonicalDigests.some(
        (digest, index) =>
          !isSha256Hex(digest) || digest !== input.observationDigests[index],
      )
    ) {
      return invalidContext("observationDigests");
    }
    const observationSetDigest = await digestCanonical(
      input.observationDigests,
    );
    const canonical = {
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      authorityPartitionDigest: input.authorityPartitionDigest,
      workLabelDigest: input.workLabel.digest,
      observationSetDigest,
      revision: input.revision,
    };
    const digest = await digestCanonical(canonical);
    return {
      ok: true,
      value: new InformationFlowContext({
        ...input,
        observationDigests: Object.freeze([...input.observationDigests]),
        observationSetDigest,
        digest,
      }),
    };
  }

  static async restore(
    raw: unknown,
  ): Promise<Result<InformationFlowContext, InformationFlowContextError>> {
    if (
      !isRecord(raw) ||
      !isNonBlankString(raw.organisationId) ||
      !isNonBlankString(raw.sessionId) ||
      !isSha256Hex(raw.authorityPartitionDigest) ||
      !Array.isArray(raw.observationDigests) ||
      !isNonNegativeInteger(raw.revision) ||
      !isSha256Hex(raw.observationSetDigest) ||
      !isSha256Hex(raw.digest)
    )
      return invalidContext("shape");
    const label = await FlowLabel.restore(raw.workLabel);
    if (!label.ok) return invalidContext("workLabel");
    const observationDigests: string[] = [];
    for (const digest of raw.observationDigests) {
      if (!isSha256Hex(digest)) return invalidContext("observationDigests");
      observationDigests.push(digest);
    }
    const canonicalDigests = [...new Set(observationDigests)].sort();
    if (
      canonicalDigests.length !== observationDigests.length ||
      canonicalDigests.some(
        (digest, index) => digest !== observationDigests[index],
      )
    ) {
      return invalidContext("observationDigests");
    }
    const restored = await InformationFlowContext.fromState({
      organisationId: raw.organisationId,
      sessionId: raw.sessionId,
      authorityPartitionDigest: raw.authorityPartitionDigest,
      workLabel: label.value,
      observationDigests: canonicalDigests,
      revision: raw.revision,
    });
    if (!restored.ok) return restored;
    return restored.value.observationSetDigest === raw.observationSetDigest &&
      restored.value.digest === raw.digest
      ? restored
      : {
          ok: false,
          error: { code: "information_flow_context_digest_mismatch" },
        };
  }

  toJSON(): SerializedInformationFlowContext {
    return canonicalInformationFlowContext(this);
  }

  static is(value: unknown): value is InformationFlowContext {
    return (
      typeof value === "object" &&
      value !== null &&
      #informationFlowContext in value
    );
  }
}

export class FlowBinding {
  readonly organisationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly authorityPartitionDigest: string;
  readonly flowLabel: FlowLabel;
  readonly informationFlowContextDigest: string;
  readonly observationSetDigest: string;
  readonly contextRevision: number;
  readonly #flowBinding = true;

  private constructor(
    input: Readonly<{
      readonly organisationId: string;
      readonly sessionId: string;
      readonly turnId: string;
      readonly authorityPartitionDigest: string;
      readonly flowLabel: FlowLabel;
      readonly informationFlowContextDigest: string;
      readonly observationSetDigest: string;
      readonly contextRevision: number;
    }>,
  ) {
    this.organisationId = input.organisationId;
    this.sessionId = input.sessionId;
    this.turnId = input.turnId;
    this.authorityPartitionDigest = input.authorityPartitionDigest;
    this.flowLabel = input.flowLabel;
    this.informationFlowContextDigest = input.informationFlowContextDigest;
    this.observationSetDigest = input.observationSetDigest;
    this.contextRevision = input.contextRevision;
    Object.freeze(this);
  }

  static fromContext(
    context: InformationFlowContext,
    turnId: string,
  ): FlowBinding {
    if (!isNonBlankString(turnId))
      throw new Error("invalid flow binding turn ID");
    return new FlowBinding({
      organisationId: context.organisationId,
      sessionId: context.sessionId,
      turnId,
      authorityPartitionDigest: context.authorityPartitionDigest,
      flowLabel: context.workLabel,
      informationFlowContextDigest: context.digest,
      observationSetDigest: context.observationSetDigest,
      contextRevision: context.revision,
    });
  }

  static async restore(
    raw: unknown,
  ): Promise<Result<FlowBinding, FlowBindingError>> {
    if (
      !isRecord(raw) ||
      !isNonBlankString(raw.organisationId) ||
      !isNonBlankString(raw.sessionId) ||
      !isNonBlankString(raw.turnId) ||
      !isSha256Hex(raw.authorityPartitionDigest) ||
      !isSha256Hex(raw.informationFlowContextDigest) ||
      !isSha256Hex(raw.observationSetDigest) ||
      !isNonNegativeInteger(raw.contextRevision)
    ) {
      return invalidBinding("shape");
    }
    const label = await FlowLabel.restore(raw.flowLabel);
    if (!label.ok) return invalidBinding("flowLabel");
    return {
      ok: true,
      value: new FlowBinding({
        organisationId: raw.organisationId,
        sessionId: raw.sessionId,
        turnId: raw.turnId,
        authorityPartitionDigest: raw.authorityPartitionDigest,
        flowLabel: label.value,
        informationFlowContextDigest: raw.informationFlowContextDigest,
        observationSetDigest: raw.observationSetDigest,
        contextRevision: raw.contextRevision,
      }),
    };
  }

  toJSON(): SerializedFlowBinding {
    return {
      organisationId: this.organisationId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      authorityPartitionDigest: this.authorityPartitionDigest,
      flowLabel: canonicalFlowLabel(this.flowLabel),
      informationFlowContextDigest: this.informationFlowContextDigest,
      observationSetDigest: this.observationSetDigest,
      contextRevision: this.contextRevision,
    };
  }

  static is(value: unknown): value is FlowBinding {
    return typeof value === "object" && value !== null && #flowBinding in value;
  }
}

export async function advanceInformationFlowContext(
  input: Readonly<{
    readonly context: InformationFlowContext;
    readonly observation: ObservationEvidence;
    readonly inputLabel: FlowLabel;
  }>,
): Promise<
  Result<
    Readonly<{
      readonly outcome: AdvanceInformationFlowContextResult;
      readonly context: InformationFlowContext;
    }>,
    InformationFlowContextError
  >
> {
  if (!InformationFlowContext.is(input.context))
    return invalidContext("context");
  if (!ObservationEvidence.is(input.observation))
    return invalidContext("observation");
  if (!FlowLabel.is(input.inputLabel)) return invalidContext("inputLabel");
  if (input.observation.flowLabelDigest !== input.inputLabel.digest) {
    return { ok: false, error: { code: "observation_label_mismatch" } };
  }
  if (
    input.context.observationDigests.includes(input.observation.evidenceDigest)
  ) {
    return {
      ok: true,
      value: {
        outcome: { kind: "duplicate", contextRevision: input.context.revision },
        context: input.context,
      },
    };
  }
  const workLabel = await joinFlowLabels(
    input.context.workLabel,
    input.inputLabel,
  );
  if (!workLabel.ok) return invalidContext(workLabel.error.code);
  const observationDigests = [
    ...input.context.observationDigests,
    input.observation.evidenceDigest,
  ].sort();
  const context = await createContext({
    organisationId: input.context.organisationId,
    sessionId: input.context.sessionId,
    authorityPartitionDigest: input.context.authorityPartitionDigest,
    workLabel: workLabel.value,
    observationDigests,
    revision: input.context.revision + 1,
  });
  if (!context.ok) return context;
  return {
    ok: true,
    value: {
      outcome: { kind: "advanced", contextRevision: context.value.revision },
      context: context.value,
    },
  };
}

export function flowBindingForContext(
  context: InformationFlowContext,
  turnId: string,
): FlowBinding {
  return FlowBinding.fromContext(context, turnId);
}

export type FlowBindingIdentity = Readonly<{
  readonly organisationId: string;
  readonly sessionId: string;
  readonly authorityPartitionDigest: string;
}>;

export type FlowBindingTurnIdentity = FlowBindingIdentity &
  Readonly<{
    readonly turnId: string;
  }>;

export function flowBindingMatchesIdentity(
  binding: Pick<
    FlowBinding,
    "organisationId" | "sessionId" | "turnId" | "authorityPartitionDigest"
  >,
  identity: FlowBindingIdentity,
): boolean {
  return (
    binding.organisationId === identity.organisationId &&
    binding.sessionId === identity.sessionId &&
    binding.authorityPartitionDigest === identity.authorityPartitionDigest
  );
}

export function flowBindingMatchesTurn(
  binding: Pick<
    FlowBinding,
    "organisationId" | "sessionId" | "turnId" | "authorityPartitionDigest"
  >,
  identity: FlowBindingTurnIdentity,
): boolean {
  return (
    flowBindingMatchesIdentity(binding, identity) &&
    binding.turnId === identity.turnId
  );
}

export function digestFlowBinding(binding: FlowBinding): Promise<string> {
  return digestCanonical(binding.toJSON());
}

export function canonicalInformationFlowContext(
  context: InformationFlowContext,
): SerializedInformationFlowContext {
  return {
    organisationId: context.organisationId,
    sessionId: context.sessionId,
    authorityPartitionDigest: context.authorityPartitionDigest,
    workLabel: canonicalFlowLabel(context.workLabel),
    observationDigests: context.observationDigests,
    observationSetDigest: context.observationSetDigest,
    revision: context.revision,
    digest: context.digest,
  };
}

function canonicalObservation(
  input: Readonly<{
    readonly source: FlowSource;
    readonly sourceRevision: number;
    readonly contentDigest: string;
    readonly flowLabelDigest: string;
    readonly observedAt: number;
  }>,
): Readonly<{
  readonly source: FlowSource;
  readonly sourceRevision: number;
  readonly contentDigest: string;
  readonly flowLabelDigest: string;
  readonly observedAt: number;
}> {
  return {
    source: canonicalSource(input.source),
    sourceRevision: input.sourceRevision,
    contentDigest: input.contentDigest,
    flowLabelDigest: input.flowLabelDigest,
    observedAt: input.observedAt,
  };
}

function canonicalObservationIdentity(
  observation: ReturnType<typeof canonicalObservation>,
): Omit<ReturnType<typeof canonicalObservation>, "observedAt"> {
  return {
    source: observation.source,
    sourceRevision: observation.sourceRevision,
    contentDigest: observation.contentDigest,
    flowLabelDigest: observation.flowLabelDigest,
  };
}

async function createContext(
  input: Readonly<{
    readonly organisationId: string;
    readonly sessionId: string;
    readonly authorityPartitionDigest: string;
    readonly workLabel: FlowLabel;
    readonly observationDigests: readonly string[];
    readonly revision: number;
  }>,
): Promise<Result<InformationFlowContext, InformationFlowContextError>> {
  return InformationFlowContext.fromState(input);
}

function invalidObservationInput(
  input: Readonly<{
    readonly source: FlowSource;
    readonly sourceRevision: number;
    readonly contentDigest: string;
    readonly observedAt: number;
  }>,
): string | null {
  if (parseFlowSource(input.source) === null) return "source";
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= 0)
    return "sourceRevision";
  if (!isSha256Hex(input.contentDigest)) return "contentDigest";
  return Number.isSafeInteger(input.observedAt) && input.observedAt >= 0
    ? null
    : "observedAt";
}

export function parseFlowSource(value: unknown): FlowSource | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "case_context_collection_evidence":
      return isNonBlankString(value.organisationId) &&
        isNonBlankString(value.caseContextCollectionId) &&
        isSha256Hex(value.dependencyDigest)
        ? {
            kind: "case_context_collection_evidence",
            organisationId: value.organisationId.trim(),
            caseContextCollectionId: value.caseContextCollectionId.trim(),
            dependencyDigest: value.dependencyDigest,
          }
        : null;
    case "project":
    case "chat_conversation": {
      const reader = parseContextVisibility(value);
      return reader.ok &&
        (reader.value.kind === "project" ||
          reader.value.kind === "chat_conversation")
        ? reader.value
        : null;
    }
    case "organisation_record":
      return isNonBlankString(value.organisationId) &&
        isNonBlankString(value.recordId)
        ? {
            kind: "organisation_record",
            organisationId: value.organisationId.trim(),
            recordId: value.recordId.trim(),
          }
        : null;
    case "case_entry": {
      if (!isNonBlankString(value.caseId) || !isNonBlankString(value.entryId))
        return null;
      const caseId = parseCaseId(value.caseId);
      return caseId.ok
        ? {
            kind: "case_entry",
            caseId: caseId.value,
            entryId: value.entryId.trim(),
          }
        : null;
    }
    case "integration_resource":
      return isNonBlankString(value.organisationId) &&
        isNonBlankString(value.integrationAccountId) &&
        isNonBlankString(value.resourceScope)
        ? {
            kind: "integration_resource",
            organisationId: value.organisationId.trim(),
            integrationAccountId: value.integrationAccountId.trim(),
            resourceScope: value.resourceScope.trim(),
          }
        : null;
    default:
      return null;
  }
}

function canonicalSource(source: FlowSource): FlowSource {
  const parsed = parseFlowSource(source);
  if (parsed === null) throw new Error("invalid flow source");
  return parsed;
}

function invalidObservation(
  field: string,
): Result<never, ObservationEvidenceError> {
  return { ok: false, error: { code: "invalid_observation_evidence", field } };
}

function invalidContext(
  field: string,
): Result<never, InformationFlowContextError> {
  return {
    ok: false,
    error: { code: "invalid_information_flow_context", field },
  };
}

function invalidBinding(field: string): Result<never, FlowBindingError> {
  return { ok: false, error: { code: "invalid_flow_binding", field } };
}
