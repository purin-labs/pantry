import { BuyerReconcileStage } from "./buyer-checkout/reconcile-stage.ts";

/**
 * A storefront's buyer checkout (Plan 77 step 2). Each layer below is one stage of the checkout, in the order of the calls: the storefront and its catalog, the cart, the quote reads, the checkout, its refresh, the payment, the placed order and the reconciliation (Refactor 14).
 */
export class BuyerCheckoutAuthority extends BuyerReconcileStage {}
