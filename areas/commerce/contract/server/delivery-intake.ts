import type {
  CanonicalCommerceDelivery,
  CommerceCueFact,
} from "@purin-labs/commerce-contracts";
import type { CommerceBoundaryResponse } from "@purin-labs/commerce-contracts/commerce-boundary";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { definePort } from "@purin-labs/kernel/port";
import type { CommerceOutboxReconcileQueueMessage } from "./queue-messages";
import type {
  AppliedCommerceDeliveryResult,
  ApplyCommerceDeliveryInput,
  CommerceProjectionError,
  CommerceSystemStorageAuthority,
  InventoryStockChange,
} from "./commerce-projection";

export type {
  AppliedCommerceDeliveryResult,
  CommerceProjectionError,
  CommerceSystemStorageAuthority,
} from "./commerce-projection";

export type CommerceWasmError =
  | { readonly code: "commerce_wasm_input_invalid" }
  | { readonly code: "commerce_wasm_response_invalid" }
  | {
      readonly code: "commerce_wasm_rejected";
      readonly reason: string;
    };

export type CommerceLabMetadataError =
  | { readonly code: "commerce_lab_not_marked" }
  | { readonly code: "commerce_lab_namespace_mismatch" }
  | { readonly code: "commerce_lab_catalog_version_mismatch" }
  | { readonly code: "commerce_lab_run_conflict" }
  | { readonly code: "commerce_lab_run_missing" }
  | { readonly code: "commerce_lab_metadata_corrupt" };

/** A commerce lab run, as a queued lab delivery names it. */
type CommerceLabRunState = Readonly<{
  runId: string;
  result: "running" | "completed" | "failed";
}>;

/** What one pass over the Commerce outbox of a merchant did. */
export type CommerceOutboxReconcileResult =
  | Readonly<{
      kind: "drained";
      acknowledged: number;
      replayed: number;
      /** Deliveries quarantined this pass; they stay pending at Commerce. */
      rejected: number;
    }>
  | Readonly<{
      kind: "rejected";
      deliveryId: string | null;
      code: string;
    }>
  | Readonly<{
      kind: "retry";
      deliveryId: string | null;
      code: string;
    }>;

/**
 * Runs a normalizer of a provider payload and checks the canonical delivery
 * that it returns (`normalizeCommerceDelivery` of `commerce-wasm.ts`).
 */
type NormalizeCommerceDelivery = (
  input: unknown,
  typescript: (input: unknown) => CommerceBoundaryResponse,
) => Result<CanonicalCommerceDelivery, CommerceWasmError>;

/**
 * Applies one canonical delivery to the commerce projection
 * (`applyCommerceDelivery` of `actors/commerce-projection.ts`). Each change of
 * the available stock of a position is added to `stockChanges`.
 */
type ApplyCommerceDelivery = (
  sql: SqlStorage,
  input: ApplyCommerceDeliveryInput,
  commerceSystem: CommerceSystemStorageAuthority,
  stockChanges?: InventoryStockChange[],
) => Result<AppliedCommerceDeliveryResult, CommerceProjectionError>;

/**
 * The intake of a provider delivery, as a service interface of the commerce
 * contract. A provider module, such as Shopify, gives its normalizer of a
 * provider payload; commerce checks the canonical delivery that it returns
 * and applies it to the commerce projection. The queue consumers of the
 * webhook surface parse a queued delivery, check its lab run and drain the
 * Commerce outbox here. The Worker registers the implementation
 * (`worker-ports.ts`).
 */
export type CommerceDeliveryIntake = Readonly<{
  /** Runs a provider normalizer and checks the canonical delivery. */
  normalizeCommerceDelivery: NormalizeCommerceDelivery;
  /** Applies one canonical delivery to the commerce projection. */
  applyCommerceDelivery: ApplyCommerceDelivery;
  /** Checks a queued canonical delivery. */
  parseCanonicalCommerceDelivery(
    raw: unknown,
  ): Result<CanonicalCommerceDelivery, CommerceProjectionError>;
  /** Checks the cue facts of a queued delivery. */
  parseCommerceCueFacts(
    raw: unknown,
  ): Result<readonly CommerceCueFact[], CommerceProjectionError>;
  /** The newest lab runs of an Organisation, at most `limit` (1 to 50). */
  listCommerceLabRuns(
    input: Readonly<{
      db: OrganisationDatabase;
      organisationId: OrganisationId;
      limit: number;
    }>,
  ): Promise<Result<readonly CommerceLabRunState[], CommerceLabMetadataError>>;
  /** Ends a lab run as failed, with the stage and the code of the failure. */
  failCommerceLabRun(
    input: Readonly<{
      db: OrganisationDatabase;
      organisationId: OrganisationId;
      runId: string;
      completedAt: number;
      failureStage: string;
      failureCode: string;
      failureProviderEventId: string | null;
      failureProjectionId: string | null;
      failureSlackEffectId: string | null;
    }>,
  ): Promise<Result<CommerceLabRunState, CommerceLabMetadataError>>;
  /** Drains the Commerce outbox of the merchant that a message names. */
  reconcileCommerceOutbox(
    input: Readonly<{
      env: Env;
      message: CommerceOutboxReconcileQueueMessage;
    }>,
  ): Promise<CommerceOutboxReconcileResult>;
}>;

export const commerceDeliveryIntake = definePort<CommerceDeliveryIntake>(
  "commerce_delivery_intake",
);
