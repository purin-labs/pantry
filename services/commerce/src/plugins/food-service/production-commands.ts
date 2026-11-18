import {
  parseCompleteProductionBatchCommand,
  type CompleteProductionBatchCommand,
  type CommerceFoodServiceSnapshotV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import type { CommerceDatabase } from "../../database.ts";
import {
  planProductionBatch,
  type ProductionBatchPlan,
  type ProductionBatchPlanResult,
} from "./production.ts";

export type ProductionMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type ProductionCommitRequest = Readonly<{
  kind: "production_batch";
  command: CompleteProductionBatchCommand;
  merchant: ProductionMerchantRow;
  plan: ProductionBatchPlan;
}>;

export type ProductionCommandAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  readMerchant: (merchantId: string) => ProductionMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readFoodServiceSnapshot: (
    merchantId: string,
  ) => CommerceFoodServiceSnapshotV1 | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command: CompleteProductionBatchCommand,
  ) => CommerceMutationResultV1 | undefined;
  commit: (request: ProductionCommitRequest) => CommerceMutationResultV1;
  validateMerchant: (
    merchantId: string,
    merchant: ProductionMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
}>;

export class ProductionCommandAuthority {
  readonly #options: ProductionCommandAuthorityOptions;

  constructor(options: ProductionCommandAuthorityOptions) {
    this.#options = options;
  }

  completeProductionBatch(rawCommand: unknown): CommerceMutationResultV1 {
    let command: CompleteProductionBatchCommand;
    try {
      command = parseCompleteProductionBatchCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    if (merchant.revision !== command.expectedMerchantRevision) {
      return this.#options.rejected({
        code: "stale_merchant_revision",
        expected: command.expectedMerchantRevision,
        actual: merchant.revision,
      });
    }
    const snapshot = this.#options.readSnapshot(command.merchantId);
    const foodService = this.#options.readFoodServiceSnapshot(
      command.merchantId,
    );
    if (snapshot === undefined || foodService === undefined) {
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    }
    const existing = foodService.resources.productionBatches.find(
      (batch) => batch.productionBatchId === command.productionBatchId,
    );
    if (existing !== undefined) {
      return this.#options.rejected({
        code: "resource_already_exists",
        kind: "production_batch",
        id: command.productionBatchId,
      });
    }
    const plan: ProductionBatchPlanResult = planProductionBatch(
      this.#options.database,
      command,
      snapshot.resources,
      foodService.resources,
    );
    if (plan.kind === "rejected") return this.#options.rejected(plan.error);
    return this.#options.commit({
      kind: "production_batch",
      command,
      merchant,
      plan: plan.value,
    });
  }
}
