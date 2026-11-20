// The `CommerceProvider` of the built-in commerce engine (Seams Checkout and
// the commerce engine Worker). Its records have the source `underclerk`.
import { resolveCommerceMerchantBinding } from "../data/commerce-merchant-binding";
import type { CommerceProvider } from "./commerce-provider";
import {
  executeBuiltInCommerceAction,
  reconcileBuiltInCommerceAction,
} from "./provider-execution";

export const builtInCommerceProvider: CommerceProvider<"satyr_commerce"> = {
  kind: "satyr_commerce",
  wire: (system) => ({
    kind: "satyr_commerce",
    organisationId: system.organisationId,
    bindingId: system.bindingId,
    merchantId: system.merchantId,
    revision: system.revision,
  }),
  graphSource: () => ({ kind: "commerce_engine" }),
  async resolveActionCredential(input) {
    const merchantBinding = await resolveCommerceMerchantBinding(input);
    return merchantBinding.ok
      ? {
          ok: true,
          value: { kind: "underclerk", merchantBinding: merchantBinding.value },
        }
      : {
          ok: false,
          error: { code: "commerce_action_provider_execution_failed" },
        };
  },
  executeAction: (input) => executeBuiltInCommerceAction(input),
  reconcileAction: (input) => reconcileBuiltInCommerceAction(input),
};
