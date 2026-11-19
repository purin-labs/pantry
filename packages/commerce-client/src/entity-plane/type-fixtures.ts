import type {
  CommerceGraphQueryResult,
  CommerceList,
  CommerceFilter,
  CommerceQueryPlanOutcome,
  CommerceSnapshotRevision,
  MerchantRevision,
  CommerceMutationReceiptV1,
  CommerceEntityPlaneObservationV1,
} from "@purin-labs/commerce-contracts";
import type {
  CommerceAggregateObservationV1,
  CommerceObservationV1,
} from "../index.ts";
import type { CommerceEntityPlaneClient } from "./client.ts";
import type {
  CommerceEntityPlaneChange,
  CommerceEntityPlaneChanges,
  CommerceEntityPlaneCommandRequest,
  CommerceEntityPlaneSystemExtensionResponse,
} from "./parsers.ts";
import { assertNever } from "@purin-labs/std";

declare const snapshotRevision: CommerceSnapshotRevision;
declare const merchantRevision: MerchantRevision;
declare const aggregateObservation: CommerceAggregateObservationV1;
declare const entityPlaneObservation: CommerceEntityPlaneObservationV1;

const aggregateDeliveryObservation: CommerceObservationV1 =
  aggregateObservation;
const entityPlaneDeliveryObservation: CommerceObservationV1 =
  entityPlaneObservation;

const commandSnapshotPosition: CommerceEntityPlaneCommandRequest["expectedMerchantRevision"] =
  snapshotRevision;
const changeHeadSnapshotPosition: CommerceEntityPlaneChanges["merchantRevision"] =
  snapshotRevision;
const changeCursorSnapshotPosition: CommerceEntityPlaneChanges["nextAfterMerchantRevision"] =
  snapshotRevision;
const extensionHeadSnapshotPosition: CommerceEntityPlaneSystemExtensionResponse["merchantRevision"] =
  snapshotRevision;
const committedChangePosition: CommerceEntityPlaneChange["merchantRevision"] =
  merchantRevision;
const changeCursorInput: Parameters<CommerceEntityPlaneClient["changes"]>[1] =
  snapshotRevision;

// @ts-expect-error Snapshot watermarks cannot be committed merchant revisions.
const invalidCommandSnapshotPosition: CommerceEntityPlaneCommandRequest["expectedMerchantRevision"] =
  merchantRevision;
// @ts-expect-error Snapshot watermarks cannot be committed merchant revisions.
const invalidChangeHeadSnapshotPosition: CommerceEntityPlaneChanges["merchantRevision"] =
  merchantRevision;
// @ts-expect-error Snapshot cursors cannot be committed merchant revisions.
const invalidChangeCursorSnapshotPosition: CommerceEntityPlaneChanges["nextAfterMerchantRevision"] =
  merchantRevision;
// @ts-expect-error Snapshot cursors cannot be committed merchant revisions.
const invalidChangeCursorInput: Parameters<
  CommerceEntityPlaneClient["changes"]
>[1] = merchantRevision;
// @ts-expect-error Snapshot watermarks cannot be committed merchant revisions.
const invalidExtensionHeadSnapshotPosition: CommerceEntityPlaneSystemExtensionResponse["merchantRevision"] =
  merchantRevision;

// @ts-expect-error Zero is not a committed merchant revision.
const invalidZeroChangeRevision: CommerceEntityPlaneChange["merchantRevision"] = 0;
// @ts-expect-error Zero is not a committed merchant revision.
const invalidZeroReceiptRevision: CommerceMutationReceiptV1["merchantRevision"] = 0;
// @ts-expect-error Zero is not a committed merchant revision.
const invalidZeroObservationRevision: CommerceEntityPlaneObservationV1["merchantRevision"] = 0;

const querySnapshotRevision: CommerceGraphQueryResult["merchantRevision"] =
  snapshotRevision;
// @ts-expect-error A committed merchant revision is distinct from a query snapshot watermark.
const invalidQuerySnapshotRevision: CommerceGraphQueryResult["merchantRevision"] =
  merchantRevision;
// @ts-expect-error Aggregate-fact observations and entity-plane observations are separate vocabularies.
const invalidEntityPlaneObservation: CommerceEntityPlaneObservationV1 =
  aggregateObservation;
// @ts-expect-error Entity-plane observations are not aggregate facts.
const invalidAggregateObservation: CommerceAggregateObservationV1 =
  entityPlaneObservation;

void querySnapshotRevision;
void commandSnapshotPosition;
void changeHeadSnapshotPosition;
void changeCursorSnapshotPosition;
void extensionHeadSnapshotPosition;
void committedChangePosition;
void changeCursorInput;
void invalidCommandSnapshotPosition;
void invalidChangeHeadSnapshotPosition;
void invalidChangeCursorSnapshotPosition;
void invalidChangeCursorInput;
void invalidExtensionHeadSnapshotPosition;
void invalidZeroChangeRevision;
void invalidZeroReceiptRevision;
void invalidZeroObservationRevision;
void invalidQuerySnapshotRevision;
void invalidEntityPlaneObservation;
void invalidAggregateObservation;
void aggregateDeliveryObservation;
void entityPlaneDeliveryObservation;

function queryPlanOutcomeKind(outcome: CommerceQueryPlanOutcome): string {
  switch (outcome.kind) {
    case "planned":
      return outcome.plan.watermark.kind;
    case "cursor_mismatch":
      return outcome.reason;
    case "cursor_stale":
      return outcome.expected.kind;
    case "unsupported_query":
      return outcome.capability.kind;
    case "invalid":
      return outcome.kind;
    default:
      return assertNever(outcome, "Unexpected query plan outcome");
  }
}

void queryPlanOutcomeKind;

declare const listWithoutMembership: Omit<CommerceList, "membership">;
// @ts-expect-error Every list must state whether an entity may appear more than once.
const missingMembership: CommerceList = { ...listWithoutMembership };
// @ts-expect-error Entity filters require a complete entity reference.
const missingEntityReference: CommerceFilter = { kind: "entity" };
void missingMembership;
void missingEntityReference;
