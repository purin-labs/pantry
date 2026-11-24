import type { CheckoutProfileConfiguration } from "@purin-labs/commerce-contracts";
import React from "react";
import { REFUND_GOVERNANCE_DESCRIPTION } from "./model";

type Fact = readonly [label: string, value: string];

/**
 * What a customer meets in this checkout, as plain facts in the order of a
 * purchase. Each fact is a setting of the profile; nothing here is advice.
 */
export function BuyingExperience(props: {
  readonly configuration: CheckoutProfileConfiguration;
  readonly isDraft: boolean;
  readonly unsaved: boolean;
}): React.ReactNode {
  const config = props.configuration;
  const currency = config.currencyPolicy.currency || "Not set";
  return (
    <section className="checkout-experience" aria-label="How customers buy">
      {props.isDraft || props.unsaved ? (
        <p className="checkout-experience-intro">
          Customers keep using the active checkout until you publish and
          activate a saved version.
        </p>
      ) : null}
      <div className="checkout-facts">
        <FactGroup
          title="Shop"
          facts={[
            [
              "Name",
              config.presentationPolicy.merchantDisplayName ||
                "Storefront name needed",
            ],
            ["Currency", currency],
            ["Order limit", `${config.cartPolicy.maximumTotalQuantity} items`],
          ]}
        />
        <FactGroup
          title="Customer details"
          facts={[
            [
              "Account",
              config.buyerPolicy.kind === "guest"
                ? "Guest checkout"
                : "Guest or account",
            ],
            ["Email", "Required"],
            [
              "Phone",
              config.buyerPolicy.requiredContact === "email_and_phone_required"
                ? "Required"
                : "Optional",
            ],
          ]}
        />
        <FactGroup
          title="Receiving the order"
          facts={[
            ["Choices", fulfillmentTitle(config.fulfillmentPolicy)],
            [
              "Fulfillment rules",
              fulfillmentConfigured(config.fulfillmentPolicy)
                ? "Configured"
                : "Setup needed",
            ],
          ]}
        />
        <FactGroup
          title="Payment"
          facts={[
            ["Pay in", currency],
            [
              "Payment provider",
              config.paymentPolicy.paymentProviderBindingId
                ? "Configured"
                : "Not set",
            ],
            [
              "Tax",
              config.taxPolicy.kind === "merchant_inclusive"
                ? "Included in prices"
                : "Quoted at checkout",
            ],
          ]}
        />
        <FactGroup
          title="After the purchase"
          wide
          facts={[
            ["Refunds", REFUND_GOVERNANCE_DESCRIPTION],
            [
              "Customer support",
              config.presentationPolicy.supportContact ||
                "Add a support contact",
            ],
          ]}
        />
      </div>
    </section>
  );
}

function FactGroup(props: {
  readonly title: string;
  readonly facts: readonly Fact[];
  readonly wide?: boolean;
}): React.ReactNode {
  return (
    <section data-wide={props.wide === true}>
      <h3>{props.title}</h3>
      <dl>{props.facts.map(renderFact)}</dl>
    </section>
  );
}

function renderFact([label, value]: Fact): React.ReactNode {
  return (
    <div key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
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
