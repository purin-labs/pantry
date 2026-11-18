import type { Variant, VariantBy } from "@seams/type-utils";
import type {
  CommerceEntityType,
  CommerceList,
  CommerceMerchantId,
  CommerceSnapshotRevision,
  OrganisationId,
  RelationshipDefinition,
  SavedCommerceView,
} from "./index.ts";
import type {
  CommerceEntityPlaneExportPresetPublishRequest,
  CommerceEntityPlaneExportPresetEvidence,
  CommerceEntityPlaneExportPresetPublishResponse,
} from "./entity-plane-export.ts";
import type {
  CommercePurchasingPresetPublishRequest,
  CommercePurchasingPresetPublishResponse,
  CommercePurchasingReconcileRequest,
  CommercePurchasingReconcileResponse,
} from "./entity-plane-purchasing.ts";

type PreviousExportRequest = Readonly<{
  organisationId: string;
  merchantId: string;
  presetId: "export_coordination";
  presetVersion: 1;
}>;
type PreviousExportEvidence = Readonly<{
  customEntityTypes: readonly VariantBy<
    CommerceEntityType,
    "origin",
    "custom"
  >[];
  relationshipDefinitions: readonly VariantBy<
    RelationshipDefinition,
    "origin",
    "custom"
  >[];
  lists: readonly CommerceList[];
  views: readonly SavedCommerceView[];
}>;
type PreviousExportResponse = Readonly<{
  kind: "published";
  organisationId: OrganisationId;
  merchantId: CommerceMerchantId;
  presetId: "export_coordination";
  presetVersion: 1;
  merchantRevision: CommerceSnapshotRevision;
  evidence: PreviousExportEvidence;
  digest: string;
}>;
type PreviousPurchasingRequest = Readonly<{
  organisationId: string;
  merchantId: string;
}>;
type PreviousPurchasingPublished = Readonly<{
  kind: "published";
  organisationId: string;
  merchantId: string;
  merchantRevision: CommerceSnapshotRevision;
}>;
type PreviousPurchasingReconciliation = Readonly<{
  organisationId: string;
  merchantId: string;
  merchantRevision: CommerceSnapshotRevision;
}> &
  (
    | Readonly<{ kind: "inactive" }>
    | Readonly<{
        kind: "reconciled";
        opened: number;
        updated: number;
        received: number;
      }>
  );
type Equivalent<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type Assert<T extends true> = T;
export type ExportRequestCompatibility = Assert<
  Equivalent<
    PreviousExportRequest,
    CommerceEntityPlaneExportPresetPublishRequest
  >
>;
export type ExportEvidenceCompatibility = Assert<
  Equivalent<PreviousExportEvidence, CommerceEntityPlaneExportPresetEvidence>
>;
export type ExportResponseCompatibility = Assert<
  Equivalent<
    PreviousExportResponse,
    CommerceEntityPlaneExportPresetPublishResponse
  >
>;
export type PurchasingPublishRequestCompatibility = Assert<
  Equivalent<
    PreviousPurchasingRequest,
    CommercePurchasingPresetPublishRequest
  >
>;
export type PurchasingPublishResponseCompatibility = Assert<
  Equivalent<
    PreviousPurchasingPublished,
    CommercePurchasingPresetPublishResponse
  >
>;
export type PurchasingReconcileRequestCompatibility = Assert<
  Equivalent<PreviousPurchasingRequest, CommercePurchasingReconcileRequest>
>;
export type PurchasingReconcileResponseCompatibility = Assert<
  Equivalent<
    PreviousPurchasingReconciliation,
    CommercePurchasingReconcileResponse
  >
>;

declare const request: CommerceEntityPlaneExportPresetPublishRequest;
// @ts-expect-error An export request requires its preset version.
const missingVersion: CommerceEntityPlaneExportPresetPublishRequest = {
  organisationId: request.organisationId,
  merchantId: request.merchantId,
  presetId: request.presetId,
};
const unsupportedVersion: CommerceEntityPlaneExportPresetPublishRequest = {
  ...request,
  // @ts-expect-error The contract supports exactly preset version one.
  presetVersion: 2,
};
declare const evidence: CommerceEntityPlaneExportPresetEvidence;
// @ts-expect-error The evidence arrays retain their readonly API.
evidence.lists.push(evidence.lists[0]);
declare const systemType: Extract<CommerceEntityType, { origin: "system" }>;
const systemEvidence: CommerceEntityPlaneExportPresetEvidence = {
  ...evidence,
  // @ts-expect-error Export evidence contains only custom entity types.
  customEntityTypes: [systemType],
};
declare const inactive: Variant<CommercePurchasingReconcileResponse, "inactive">;
// @ts-expect-error An inactive reconciliation cannot contain counters through a spread.
const mixedReconciliation: CommercePurchasingReconcileResponse = {
  ...inactive,
  opened: 1,
  updated: 0,
  received: 0,
};
declare const reconciled: Variant<CommercePurchasingReconcileResponse, "reconciled">;
// @ts-expect-error A reconciled response requires all three counters.
const missingCount: CommercePurchasingReconcileResponse = {
  kind: "reconciled",
  organisationId: reconciled.organisationId,
  merchantId: reconciled.merchantId,
  merchantRevision: reconciled.merchantRevision,
  opened: reconciled.opened,
  updated: reconciled.updated,
};
void missingVersion;
void unsupportedVersion;
void systemEvidence;
void mixedReconciliation;
void missingCount;
