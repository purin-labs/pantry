import {
  type CommerceBuyerCheckoutIdentityV1,
  normalizeCustomerEmail,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import {
  type BuyerPickupCheckoutCommand,
  type BuyerShippingCheckoutCommand,
} from "../checkout-planning.ts";
import type {
  BuyerCheckoutAuthorityOptions,
  BuyerCheckoutProfileClaims,
} from "./types.ts";

/**
 * The buyer checkout's options and the checkout commands that it submits (Refactor 14).
 */
export abstract class BuyerCheckoutBase {
  protected readonly options!: BuyerCheckoutAuthorityOptions;

  constructor(options: BuyerCheckoutAuthorityOptions) {
    this.options = options;
  }

  protected submitBuyerPickupCheckout(
    command: BuyerPickupCheckoutCommand,
  ): CommerceMutationResultV1 {
    return this.options.checkoutCommands.submitBuyerPickupCheckout(command);
  }

  protected submitBuyerShippingCheckout(
    command: BuyerShippingCheckoutCommand,
  ): CommerceMutationResultV1 {
    return this.options.checkoutCommands.submitBuyerShippingCheckout(command);
  }

  protected beginCheckoutPayment(
    rawCommand: unknown,
  ): CommerceMutationResultV1 {
    return this.options.checkoutCommands.beginCheckoutPayment(rawCommand);
  }

  protected recordCheckoutPaymentCapture(
    rawCommand: unknown,
  ): CommerceMutationResultV1 {
    return this.options.checkoutCommands.recordCheckoutPaymentCapture(
      rawCommand,
    );
  }

  protected resolveCheckoutPayment(
    rawCommand: unknown,
  ): CommerceMutationResultV1 {
    return this.options.checkoutCommands.resolveCheckoutPayment(rawCommand);
  }

  protected placePaidCheckout(rawCommand: unknown): CommerceMutationResultV1 {
    return this.options.checkoutCommands.placePaidCheckout(rawCommand);
  }

  protected customerIdOf(
    claims: BuyerCheckoutProfileClaims,
    buyer: CommerceBuyerCheckoutIdentityV1,
  ): string | null {
    if (claims.buyer.kind === "identified_customer")
      return claims.buyer.protectedCustomerReference;
    return buyer.kind === "guest"
      ? this.options.findCustomerId(
          claims.merchantId,
          normalizeCustomerEmail(buyer.contact.email, "buyer.contact.email"),
        )
      : null;
  }

  protected recordBuyer(
    claims: BuyerCheckoutProfileClaims,
    checkoutId: string,
    buyer: CommerceBuyerCheckoutIdentityV1,
  ): void {
    if (claims.buyer.kind === "identified_customer") {
      this.options.recordCheckoutBuyer(claims.merchantId, checkoutId, {
        kind: "customer",
        customerId: claims.buyer.protectedCustomerReference,
      });
    } else if (buyer.kind === "guest") {
      this.options.recordCheckoutBuyer(claims.merchantId, checkoutId, {
        kind: "guest",
        email: normalizeCustomerEmail(
          buyer.contact.email,
          "buyer.contact.email",
        ),
      });
    }
  }
}
