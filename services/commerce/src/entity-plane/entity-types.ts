import type { CommerceSnapshotRevision } from "@purin-labs/commerce-contracts";
import type {
  CommerceEntityPlaneChange,
  CommerceEntityPlaneChangeResource,
  CommerceEntityPlaneChanges,
  CommerceEntityPlaneCommandRequest,
  CommerceEntityPlaneQueryRequest,
  CommerceEntityPlaneSystemExtensionRequest,
  CommerceEntityPlaneSystemExtensionResponse,
} from "@purin-labs/commerce-client";

/** The route owns merchant binding; request wire shapes remain client-owned. */
export type EntityPlaneQueryRequest = CommerceEntityPlaneQueryRequest;
/** Idempotency and organisation fencing live at the Commerce request boundary. */
export type EntityPlaneCommandRequest = CommerceEntityPlaneCommandRequest;

export type EntityPlaneChangeOperation =
  CommerceEntityPlaneChange["operation"];
export type EntityPlaneChangeResource = CommerceEntityPlaneChangeResource;
export type EntityPlaneChange = CommerceEntityPlaneChange;

export type EntityPlaneChangeRequest = Readonly<{
  merchantId: string;
  afterMerchantRevision: CommerceSnapshotRevision;
  limit: number;
}>;

export type EntityPlaneChangeResponse = CommerceEntityPlaneChanges;

export type EntityPlaneSystemExtensionRequest =
  CommerceEntityPlaneSystemExtensionRequest;
export type EntityPlaneSystemExtensionResponse =
  CommerceEntityPlaneSystemExtensionResponse;
