import type { CommerceProviderReceipt } from "@purin-labs/control-api";

import type { GlobalDatabase } from "../database-handles";
import { FlowBinding, digestFlowBinding } from "../policy/information-flow";
import type { Result } from "../result";
import { reconcileCommerceProviderReceipt } from "../commerce/action-model";
import { readActionResult } from "./action-ledger";
import { readActivationExportSource } from "./actor-export";
import type { ActorFenceToken } from "./actor-registry";
import type { ActorRelocationId } from "./actor-relocation";
import {
  frozenRelocationReceiptGate,
  type RelocationReceiptError,
} from "./actor-relocation-state";

/**
 * The commerce receipt that an Organisation Actor settles while its
 * relocation is frozen. The Actor runtime gives the gate of the frozen
 * relocation; this step reads the action ledger and settles the receipt.
 */
export type RelocationReceiptRequest = {
  readonly relocationId: ActorRelocationId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly receipt: CommerceProviderReceipt;
  readonly now: number;
};

/** Settle an observed receipt before any source snapshot can be accepted. Never dispatch an effect. */
export async function reconcileFrozenOrganisationReceipt(
  directory: GlobalDatabase,
  storage: DurableObjectStorage,
  request: RelocationReceiptRequest,
): Promise<Result<null, RelocationReceiptError>> {
  const activation = readActivationExportSource(storage.sql);
  if (
    !activation.ok ||
    activation.value.identity.objectKind !== "organisation" ||
    activation.value.fenceToken !== request.expectedFenceToken
  )
    return { ok: false, error: { code: "relocation_receipt_rejected" } };
  const organisationId = activation.value.identity.organisationId;
  const allowed = frozenRelocationReceiptGate(
    directory,
    activation.value,
    request.relocationId,
  );
  if ((await allowed.first()) === null)
    return { ok: false, error: { code: "relocation_receipt_rejected" } };
  const action = readActionResult(
    storage.sql,
    organisationId,
    request.receipt.actionNonce,
  );
  if (!action.ok)
    return { ok: false, error: { code: "relocation_receipt_rejected" } };
  const binding = await FlowBinding.restore(action.value.action.flowBinding);
  if (
    !binding.ok ||
    (await digestFlowBinding(binding.value)) !==
      request.receipt.flowBindingDigest
  )
    return { ok: false, error: { code: "relocation_receipt_rejected" } };
  if ((await allowed.first()) === null)
    return { ok: false, error: { code: "relocation_receipt_rejected" } };
  const settled = storage.transactionSync(
    reconcileCommerceProviderReceipt.bind(null, storage.sql, {
      organisationId,
      nonce: request.receipt.actionNonce,
      receipt: request.receipt,
      now: request.now,
    }),
  );
  return settled.ok &&
    (settled.value.state === "confirmed" || settled.value.state === "failed")
    ? { ok: true, value: null }
    : { ok: false, error: { code: "relocation_receipt_rejected" } };
}
