import {
  parseCompleteProductionBatchCommand,
  type CompleteProductionBatchCommand,
  type CommerceFoodServiceSnapshotV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import type { CommerceDatabase } from "../../database.ts";
import type { MerchantRow } from "../../commerce-authority/ledger.ts";
import {
  beginSnapshotCommand,
  merchantNotFound,
  type MerchantCommandPorts,
} from "../../commerce-authority/merchant-command.ts";
import {
  planProductionBatch,
  type ProductionBatchPlan,
  type ProductionBatchPlanResult,
} from "./production.ts";

export type ProductionCommitRequest = Readonly<{
  kind: "production_batch";
  command: CompleteProductionBatchCommand;
  merchant: MerchantRow;
  plan: ProductionBatchPlan;
}>;

type ProductionCommandAuthorityOptions =
  MerchantCommandPorts<CompleteProductionBatchCommand> &
    Readonly<{
      database: CommerceDatabase;
      readSnapshot: (
        merchantId: string,
      ) => CommerceMerchantSnapshotV1 | undefined;
      readFoodServiceSnapshot: (
        merchantId: string,
      ) => CommerceFoodServiceSnapshotV1 | undefined;
      commit: (request: ProductionCommitRequest) => CommerceMutationResultV1;
    }>;

export class ProductionCommandAuthority {
  readonly #options: ProductionCommandAuthorityOptions;

  constructor(options: ProductionCommandAuthorityOptions) {
    this.#options = options;
  }

  completeProductionBatch(rawCommand: unknown): CommerceMutationResultV1 {
    const start = beginSnapshotCommand(
      this.#options,
      rawCommand,
      parseCompleteProductionBatchCommand,
      { merchantRevision: true },
    );
    if (start.kind !== "ready") return start.result;
    const { command, merchant, snapshot } = start;
    const foodService = this.#options.readFoodServiceSnapshot(
      command.merchantId,
    );
    if (foodService === undefined) {
      return this.#options.rejected(merchantNotFound(command.merchantId));
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
