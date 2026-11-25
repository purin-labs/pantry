import type {
  CheckoutProfile,
  PointOfSaleConfiguration,
} from "@purin-labs/commerce-contracts";
import {
  type ActivateCheckoutProfile,
  type ActiveStorefrontCheckoutProfile,
  type CheckoutProfileCommandResult,
  type CheckoutProfileActivation,
  type CreateCheckoutProfileDraft,
  type PublishCheckoutProfile,
  type ReplaceCheckoutProfileDraft,
  type RetireCheckoutProfile,
} from "../../checkout-profile-service.ts";
import {
  type PointOfSaleConfigurationResult,
  type PublishPointOfSaleConfiguration,
} from "../../point-of-sale-configuration-service.ts";
import { workingPaymentBindingIds } from "../../working-payment-bindings.ts";
import { OrderFamily } from "./orders.ts";

/**
 * Checkout profiles and point-of-sale configurations.
 */
export abstract class CheckoutProfileFamily extends OrderFamily {
  createCheckoutProfileDraft(
    input: CreateCheckoutProfileDraft,
  ): CheckoutProfileCommandResult<CheckoutProfile> {
    return this.checkoutProfiles.createDraft(input);
  }

  replaceCheckoutProfileDraft(
    input: ReplaceCheckoutProfileDraft,
  ): CheckoutProfileCommandResult<CheckoutProfile> {
    return this.checkoutProfiles.replaceDraft(input);
  }

  publishCheckoutProfile(
    input: PublishCheckoutProfile,
  ): CheckoutProfileCommandResult<CheckoutProfile> {
    return this.checkoutProfiles.publish(input);
  }

  /**
   * Publish the policy a counter sells under.
   *
   * Separate from a checkout profile: a counter has no storefront to activate
   * against, so publication is the whole of its lifecycle.
   */
  publishPointOfSaleConfiguration(
    input: PublishPointOfSaleConfiguration,
  ): PointOfSaleConfigurationResult<PointOfSaleConfiguration> {
    return this.pointOfSaleConfigurations.publish(input);
  }

  readPublishedPointOfSaleConfiguration(
    merchantId: string,
    pantryLocationId: string,
  ): PointOfSaleConfiguration | undefined {
    return this.pointOfSaleConfigurations.readPublished(
      merchantId,
      pantryLocationId,
    );
  }

  listPointOfSaleConfigurations(
    merchantId: string,
  ): readonly PointOfSaleConfiguration[] {
    return this.pointOfSaleConfigurations.listPublished(merchantId);
  }

  retireCheckoutProfile(
    input: RetireCheckoutProfile,
  ): CheckoutProfileCommandResult<CheckoutProfile> {
    return this.checkoutProfiles.retire(input);
  }

  activateCheckoutProfile(
    input: ActivateCheckoutProfile,
  ): CheckoutProfileCommandResult<ActiveStorefrontCheckoutProfile> {
    return this.checkoutProfiles.activate(input);
  }

  /**
   * After a payment account links: each storefront that still sells on the
   * template's profile and cannot charge moves to the account (spec §4).
   */
  followWorkingPaymentBinding(
    merchantId: string,
    paymentProviderBindingId: string,
  ): readonly string[] {
    return this.checkoutProfiles.followWorkingPaymentBinding({
      merchantId,
      paymentProviderBindingId,
      workingBindingIds: workingPaymentBindingIds(this.database, merchantId),
      at: this.now(),
    });
  }

  readCheckoutProfile(
    merchantId: string,
    checkoutProfileId: string,
    revision: number,
  ): CheckoutProfile | undefined {
    return this.checkoutProfiles.read(merchantId, checkoutProfileId, revision);
  }

  listCheckoutProfiles(merchantId: string): readonly CheckoutProfile[] {
    return this.checkoutProfiles.listLatest(merchantId);
  }

  listCheckoutProfileActivations(
    merchantId: string,
  ): readonly CheckoutProfileActivation[] {
    return this.checkoutProfiles.listActivations(merchantId);
  }

  listStorefrontIds(merchantId: string): readonly string[] {
    return this.checkoutProfiles.listStorefrontIds(merchantId);
  }

  readActiveCheckoutProfile(
    merchantId: string,
    storefrontId: string,
  ): ActiveStorefrontCheckoutProfile | undefined {
    return this.checkoutProfiles.readActiveForStorefront(
      merchantId,
      storefrontId,
    );
  }
}
