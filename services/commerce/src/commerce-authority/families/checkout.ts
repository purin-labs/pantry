import { type CommerceMutationResultV1 } from "@purin-labs/commerce-client";
import type { PlaceCommerceStoredValueCheckoutV1 } from "../checkout-payment-planning.ts";
import { CheckoutProfileFamily } from "./checkout-profiles.ts";

/**
 * Merchant checkout commands: in-person and pickup checkouts and their payment lifecycle.
 */
export abstract class CheckoutFamily extends CheckoutProfileFamily {
  placeStoredValueCheckout(
    command: PlaceCommerceStoredValueCheckoutV1,
  ): CommerceMutationResultV1 {
    return this.checkoutCommands.placeStoredValueCheckout(command);
  }

  createInPersonCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    return this.checkoutCommands.createInPersonCheckout(rawCommand);
  }

  createPickupCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    return this.checkoutCommands.createPickupCheckout(rawCommand);
  }

  beginCheckoutPayment(rawCommand: unknown): CommerceMutationResultV1 {
    return this.checkoutCommands.beginCheckoutPayment(rawCommand);
  }

  recordCheckoutPaymentCapture(
    rawCommand: unknown,
  ): CommerceMutationResultV1 {
    return this.checkoutCommands.recordCheckoutPaymentCapture(rawCommand);
  }

  placePaidCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    return this.checkoutCommands.placePaidCheckout(rawCommand);
  }

  recordCounterCashPayment(rawCommand: unknown): CommerceMutationResultV1 {
    return this.checkoutCommands.recordCounterCashPayment(rawCommand);
  }

  /** Releases the stock of lapsed checkouts; returns when the next lapses. */
  expireLapsedCheckouts(): string | null {
    return this.checkoutCommands.expireLapsedCheckouts();
  }

  resolveCheckoutPayment(rawCommand: unknown): CommerceMutationResultV1 {
    return this.checkoutCommands.resolveCheckoutPayment(rawCommand);
  }

  expireCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    return this.checkoutCommands.expireCheckout(rawCommand);
  }
}
