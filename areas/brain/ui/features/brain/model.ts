import type {
  MemoryContent,
  MemoryEvidence,
  MemoryRevisionState,
  MemoryRevisionView,
  MemoryView,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import type { StatusChipStatus } from "@purin-labs/ui/status-chip";

/** The revision now in use, when a person accepted one that still stands. */
export function acceptedRevision(
  memory: MemoryView,
): MemoryRevisionView | null {
  return (
    memory.revisions.find((revision) => revision.kind === "accepted") ?? null
  );
}

/** The candidate waiting for a decision, when the newest revision is one. */
export function openCandidate(memory: MemoryView): MemoryRevisionView | null {
  const head = memory.revisions.at(-1);
  return head?.kind === "candidate" ? head : null;
}

/** The revision a reader should see first: what is in use, else the newest. */
export function leadRevision(memory: MemoryView): MemoryRevisionView | null {
  return acceptedRevision(memory) ?? memory.revisions.at(-1) ?? null;
}

export function memoryStatuses(
  memory: MemoryView,
): readonly StatusChipStatus[] {
  const accepted = acceptedRevision(memory);
  const candidate = openCandidate(memory);
  if (accepted !== null)
    return candidate === null
      ? [{ kind: "success", label: "In use" }]
      : [
          { kind: "success", label: "In use" },
          { kind: "warning", label: "Replacement to review" },
        ];
  if (candidate !== null) return [{ kind: "warning", label: "Needs review" }];
  const head = memory.revisions.at(-1);
  return [
    {
      kind: "neutral",
      label:
        head?.kind === "revoked"
          ? "Revoked"
          : head?.kind === "rejected"
            ? "Declined"
            : "Not in use",
    },
  ];
}

export function revisionStateLabel(revision: MemoryRevisionView): string {
  switch (revision.kind) {
    case "candidate":
      return "Waiting for review";
    case "accepted":
      return "Accepted and in use";
    case "rejected":
      return revision.rejection.reason === "revised"
        ? "Edited by a reviewer"
        : "Declined";
    case "superseded":
      return "Replaced by a later version";
    case "revoked":
      return "Revoked";
    default:
      return assertNever(revision, "Unexpected value");
  }
}

export function kindLabel(kind: MemoryContent["memoryKind"]): string {
  switch (kind) {
    case "fact":
      return "Fact";
    case "preference":
      return "Preference";
    case "lesson":
      return "Lesson";
    default:
      return assertNever(kind, "Unexpected value");
  }
}

export function applicabilityLabel(
  applicability: MemoryContent["applicability"],
): string {
  switch (applicability.kind) {
    case "portal_chat":
      return "Chats in the Portal";
    case "skill":
      return "Work that uses one skill";
    case "commerce_entity":
      return applicability.entity.typeId === "trade_partner"
        ? "One supplier"
        : "One record";
    default:
      return assertNever(applicability, "Unexpected value");
  }
}

export function authorLabel(revision: MemoryRevisionView): string {
  if (revision.proposedBy.kind === "agent") return "The agent";
  return revision.proposedBy.submission === "shared_review"
    ? "A reviewer, on this page"
    : "A person, privately";
}

export function evidenceLabel(evidence: MemoryEvidence): string {
  switch (evidence.kind) {
    case "proposal_correction":
      return "A reviewed correction of an email reply";
    case "operator_instruction":
      return "An instruction a person gave";
    case "case_observation":
      return "An observation recorded in a Case";
    case "case_context_collection":
      return "Collected Case context";
    default:
      return assertNever(evidence, "Unexpected value");
  }
}

export function effectiveLabel(validity: MemoryContent["validity"]): string {
  const range =
    validity.effectiveUntil === null
      ? `From ${validity.effectiveFrom}`
      : `${validity.effectiveFrom} to ${validity.effectiveUntil}`;
  return `${range}, ${validity.timezone} time`;
}

/**
 * When a version was last proposed or decided. An Eval version has the same
 * states, so the Evals of the Knowledge list use it too.
 */
export function revisionChangedAt(
  revision: MemoryRevisionState,
): number | null {
  switch (revision.kind) {
    case "candidate":
      return null;
    case "accepted":
      return revision.acceptance.decidedAt;
    case "rejected":
      return revision.rejection.decidedAt;
    case "superseded":
      return revision.supersession.supersededAt;
    case "revoked":
      return revision.revocation.decidedAt;
    default:
      return assertNever(revision, "Unexpected value");
  }
}

/** The time of the last proposal or decision on a Memory. */
export function lastChangedAt(memory: MemoryView): number {
  let latest = 0;
  for (const revision of memory.revisions)
    latest = Math.max(
      latest,
      revision.proposedAt,
      revisionChangedAt(revision) ?? 0,
    );
  return latest;
}

/** What the Overview counts. A Memory can be in use and have a candidate. */
export function overviewCounts(memories: readonly MemoryView[]): Readonly<{
  needsReview: number;
  inUse: number;
  notInUse: number;
}> {
  let needsReview = 0;
  let inUse = 0;
  let notInUse = 0;
  for (const memory of memories) {
    const accepted = acceptedRevision(memory) !== null;
    if (openCandidate(memory) !== null) needsReview += 1;
    if (accepted) inUse += 1;
    else if (openCandidate(memory) === null) notInUse += 1;
  }
  return { needsReview, inUse, notInUse };
}

/** The reviewed content of a revision, without its lifecycle. */
export function revisionContent(revision: MemoryRevisionView): MemoryContent {
  return {
    memoryKind: revision.memoryKind,
    statement: revision.statement,
    applicability: revision.applicability,
    validity: revision.validity,
    evidence: revision.evidence,
    sourceCaseId: revision.sourceCaseId,
  };
}
