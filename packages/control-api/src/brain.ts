import { hasExactKeys, isNonNegativeInteger, isRecord } from "@seams/std";

/**
 * What waits for one person's decision in the Brain. Each number counts
 * records that this person may inspect in full and may decide. A person who
 * may read nothing receives the summary of an Organisation with no records.
 */
export type BrainSummary = Readonly<{
  /** Memories whose newest version is a candidate. */
  memoriesToReview: number;
  /** Evals whose newest version is a candidate. */
  evalsToReview: number;
}>;

export const EMPTY_BRAIN_SUMMARY: BrainSummary = {
  memoriesToReview: 0,
  evalsToReview: 0,
};

/** The count the Portal shows beside the Brain entry of its navigation. */
export function brainItemsToReview(summary: BrainSummary): number {
  return summary.memoriesToReview + summary.evalsToReview;
}

export function parseBrainSummaryResponse(raw: unknown): BrainSummary {
  const summary = isRecord(raw) && raw.ok === true ? raw.summary : null;
  if (
    !isRecord(summary) ||
    !hasExactKeys(summary, ["memoriesToReview", "evalsToReview"]) ||
    !isNonNegativeInteger(summary.memoriesToReview) ||
    !isNonNegativeInteger(summary.evalsToReview)
  )
    throw new Error("The Brain summary is unavailable.");
  return {
    memoriesToReview: summary.memoriesToReview,
    evalsToReview: summary.evalsToReview,
  };
}
