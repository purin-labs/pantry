import type { BakeryRunOpenReview } from "@purin-labs/bakery-model/bakery-surface";
import type { CompiledProcedure } from "@purin-labs/bakery-model/bakery-procedure";
import type { ProductionReady, ProductionSession } from "./production-session";
import type { ProductionWorkcells } from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import {
  acceptedProductionResults,
  appliedRunPatch,
  newDraftIdentity,
  productionDraftSource,
  type ProductionDraftSource,
} from "./production-draft.ts";
import {
  readyProduction,
  rehearsalSessionPatch,
} from "./scheduled-rehearsal.ts";
import type { SavedWorkspaceRun } from "./workspace-runs-api";
import type { ScheduleSpatialLayout } from "@purin-labs/production-simulation/recipes/bakery/schedule";

const reviewedRun: unique symbol = Symbol("reviewed workspace run");

export type WorkspaceRunReview = Readonly<{
  [reviewedRun]: true;
  from: ProductionReady;
  draft: ProductionDraftSource | null;
  preview: ProductionReady | null;
  name: string;
  note: string;
  presentation: ProductionSession["presentation"];
  plan: ProductionWorkcells;
  procedure: CompiledProcedure | null;
  notes: readonly string[];
  readOnly: readonly string[];
  savedRun: SavedWorkspaceRun | null;
}>;

export function prepareWorkspaceRunReview(
  input: Omit<WorkspaceRunReview, typeof reviewedRun>,
): WorkspaceRunReview {
  return {
    [reviewedRun]: true,
    from: input.from,
    draft: input.draft,
    preview: input.preview,
    name: input.name,
    note: input.note,
    presentation: input.presentation,
    plan: input.plan,
    procedure: input.procedure,
    notes: input.notes,
    readOnly: input.readOnly,
    savedRun: input.savedRun,
  };
}

export function workspaceRunReviewCurrent(
  session: ProductionSession,
  review: WorkspaceRunReview,
): boolean {
  if (
    session.data !== review.from ||
    session.preview !== review.preview ||
    session.procedure !== review.plan.procedure ||
    session.draftName !== review.name ||
    session.draftNote !== review.note ||
    session.presentation !== review.presentation
  )
    return false;
  const draft = productionDraftSource(session);
  if (draft === null || review.draft === null) return draft === review.draft;
  return (
    draft.draft === review.draft.draft &&
    draft.manualTasks === review.draft.manualTasks &&
    draft.variant === review.draft.variant &&
    draft.identity === review.draft.identity &&
    draft.sourceProcedure === review.draft.sourceProcedure
  );
}

export function workspaceRunReviewSummary(
  review: WorkspaceRunReview,
): BakeryRunOpenReview | null {
  if (
    review.savedRun === null ||
    (review.savedRun.kind !== "rehearsal" &&
      review.savedRun.kind !== "production")
  )
    return null;
  return {
    id: review.savedRun.id,
    name: review.savedRun.name,
    runKind: review.savedRun.kind,
    sourceFingerprint: review.from.plan.fingerprint,
    proposedFingerprint: review.plan.fingerprint,
    currentResults: acceptedProductionResults(review.from.plan),
    proposedResults: acceptedProductionResults(review.plan),
  };
}

export function workspaceRunReviewPatch(
  session: ProductionSession,
  review: WorkspaceRunReview,
  layout: ScheduleSpatialLayout | null,
): Partial<ProductionSession> {
  if (review.plan.procedure === "rehearsal")
    return rehearsalSessionPatch(
      session,
      review.plan,
      review.notes.length === 0
        ? "Saved rehearsal reopened paused with its accepted results."
        : `Saved rehearsal converted. ${review.notes.join(" ")}`,
      false,
      layout,
      review.readOnly,
    );
  const patch = appliedRunPatch(
    session,
    readyProduction(review.plan, layout),
    "Saved production reopened paused with its accepted results.",
  );
  return review.plan.source.kind === "local"
    ? {
        ...patch,
        sourceProcedure: review.procedure,
        identity: newDraftIdentity(),
        draftName: "",
        draftNote:
          "Assumed production timings; calibrate with a measured shift.",
      }
    : { ...patch, sourceProcedure: review.procedure };
}
