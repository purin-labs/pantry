import type { CheckoutProfileConfiguration } from "@purin-labs/contracts";
import { CreditCard, ShoppingBag, Truck, UserRound } from "lucide-react";
import React from "react";
import { refundGovernanceDescription } from "./model";

export function BuyingExperience(props: {
  readonly configuration: CheckoutProfileConfiguration;
  readonly activeCount: number;
  readonly isDraft: boolean;
  readonly unsaved: boolean;
}): React.ReactNode {
  const config = props.configuration;
  return (
    <section className="checkout-experience" aria-label="How customers buy">
      <div className="checkout-experience-heading">
        <div>
          <p className="checkout-profile-eyebrow">Buying experience</p>
          <h2>How customers buy</h2>
        </div>
        <span
          className={
            props.activeCount > 0 && !props.unsaved
              ? "checkout-ready"
              : "checkout-blocked"
          }
        >
          {props.unsaved
            ? "Unsaved changes"
            : props.isDraft
              ? "Draft · not live"
              : props.activeCount > 0
                ? "Active on storefront"
                : "Not active on a storefront"}
        </span>
      </div>
      <p className="checkout-experience-intro">
        {props.isDraft || props.unsaved
          ? "This is the experience these settings describe. Customers keep using the active checkout until you publish and activate a saved version."
          : "Review the ordering experience configured for this checkout."}
      </p>
      <div className="checkout-experience-cards">
        <article>
          <ShoppingBag size={22} aria-hidden="true" />
          <small>01 · Shop</small>
          <h3>
            {config.presentationPolicy.merchantDisplayName ||
              "Storefront name needed"}
          </h3>
          <p>
            Customers choose products from the storefront’s published offers.
          </p>
          <dl>
            <div>
              <dt>Currency</dt>
              <dd>{config.currencyPolicy.currency || "Not set"}</dd>
            </div>
            <div>
              <dt>Order limit</dt>
              <dd>{config.cartPolicy.maximumTotalQuantity} items</dd>
            </div>
          </dl>
        </article>
        <article>
          <UserRound size={22} aria-hidden="true" />
          <small>02 · Customer details</small>
          <h3>
            {config.buyerPolicy.kind === "guest"
              ? "Guest checkout"
              : "Guest or account"}
          </h3>
          <p>
            {config.buyerPolicy.kind === "guest"
              ? "Customers can order without creating an account."
              : "Customers can check out as a guest or use their account."}
          </p>
          <dl>
            <div>
              <dt>Email</dt>
              <dd>Required</dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd>
                {config.buyerPolicy.requiredContact ===
                "email_and_phone_required"
                  ? "Required"
                  : "Optional"}
              </dd>
            </div>
          </dl>
        </article>
        <article>
          <Truck size={22} aria-hidden="true" />
          <small>03 · Receive the order</small>
          <h3>{fulfillmentTitle(config.fulfillmentPolicy)}</h3>
          <p>{fulfillmentDescription(config.fulfillmentPolicy)}</p>
          <dl>
            <div>
              <dt>Fulfillment rules</dt>
              <dd>
                {fulfillmentConfigured(config.fulfillmentPolicy)
                  ? "Configured"
                  : "Setup needed"}
              </dd>
            </div>
          </dl>
        </article>
        <article>
          <CreditCard size={22} aria-hidden="true" />
          <small>04 · Pay</small>
          <h3>
            {config.currencyPolicy.currency
              ? `Pay in ${config.currencyPolicy.currency}`
              : "Choose a currency"}
          </h3>
          <p>
            Payment methods are supplied by the configured payment provider.
          </p>
          <dl>
            <div>
              <dt>Provider reference</dt>
              <dd>
                {config.paymentPolicy.paymentProviderBindingId
                  ? "Configured"
                  : "Not set"}
              </dd>
            </div>
            <div>
              <dt>Tax</dt>
              <dd>
                {config.taxPolicy.kind === "merchant_inclusive"
                  ? "Included in prices"
                  : "Quoted at checkout"}
              </dd>
            </div>
          </dl>
        </article>
      </div>
      <div className="checkout-after-purchase">
        <div>
          <h3>After the purchase</h3>
          <p>{refundGovernanceDescription(config)}</p>
        </div>
        <div>
          <span>Customer support</span>
          <strong>
            {config.presentationPolicy.supportContact ||
              "Add a support contact"}
          </strong>
        </div>
      </div>
      <p className="checkout-experience-caption">
        Configuration overview. Provider connectivity and the customer-facing
        checkout should be tested before taking live orders.
      </p>
    </section>
  );
}

function fulfillmentTitle(
  policy: CheckoutProfileConfiguration["fulfillmentPolicy"],
): string {
  switch (policy.kind) {
    case "pickup_only":
      return "Collect in store";
    case "shipping_only":
      return "Ship to an address";
    case "buyer_choice":
      return "Pickup or shipping";
  }
}
function fulfillmentDescription(
  policy: CheckoutProfileConfiguration["fulfillmentPolicy"],
): string {
  switch (policy.kind) {
    case "pickup_only":
      return "Customers collect their order using your pickup policy.";
    case "shipping_only":
      return "Customers provide a delivery address using your shipping policy.";
    case "buyer_choice":
      return "Customers choose collection or shipping during checkout.";
  }
}
function fulfillmentConfigured(
  policy: CheckoutProfileConfiguration["fulfillmentPolicy"],
): boolean {
  switch (policy.kind) {
    case "pickup_only":
      return policy.pickupPolicyId.trim().length > 0;
    case "shipping_only":
      return policy.shippingPolicyId.trim().length > 0;
    case "buyer_choice":
      return (
        policy.pickupPolicyId.trim().length > 0 &&
        policy.shippingPolicyId.trim().length > 0
      );
  }
}
