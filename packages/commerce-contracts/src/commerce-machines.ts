// Commerce's state machines (Plan 77 step 1). This file is the source
// (Plan 78); `pnpm --filter @purin-labs/commerce-contracts commerce-data:check` checks it.
import type { CheckoutLifecycle } from "./records/commerce-records.ts";
import type { CheckoutPaymentAttemptLifecycle } from "./records/commerce-records.ts";
import type { CheckoutProfileLifecycle } from "./records/checkout-profile.ts";
import type { CustomerState } from "./records/lifecycle-states.ts";
import type { DiscountStatus } from "./records/lifecycle-states.ts";
import type { DraftOrderState } from "./records/lifecycle-states.ts";
import type { FirstPartyShipmentLifecycle } from "./records/commerce-records.ts";
import type { OrderLifecycle } from "./records/commerce-records.ts";
import type { PaymentDisputeLifecycle } from "./records/after-sale.ts";
import type { PaymentLifecycle } from "./records/commerce-records.ts";
import type { PickupFulfillmentLifecycle } from "./records/commerce-records.ts";
import type { PluginState } from "./records/plugins.ts";
import type { RefundAttemptLifecycle } from "./records/after-sale.ts";
import type { ReturnState } from "./records/lifecycle-states.ts";
import type { ShippingFulfillmentLifecycle } from "./records/commerce-records.ts";
import type { StoredValueAccountStatus } from "./records/lifecycle-states.ts";
import type { WebhookSubscriptionState } from "./records/lifecycle-states.ts";
import type { UnplacedCaptureLifecycle } from "./records/api-unplaced-captures.ts";
import type { CredentialState } from "./records/api-access.ts";
import type { PreparationTicketLifecycle } from "./records/commerce-records.ts";
import type { InventoryAllocationLifecycle } from "./records/commerce-records.ts";
import type { InventoryLotLifecycle } from "./records/commerce-records.ts";
import type { PurchaseRequestStatus } from "./records/lifecycle-states.ts";
import type { CommerceMachineDefinition } from "./state-machine.ts";

const CHECKOUT_PROFILE_MACHINE = {
  name: "checkout_profile",
  lifecycle: "CheckoutProfileLifecycle",
  stateType: "tagged",
  specSection: 4,
  states: {
    draft: {
      kind: "initial",
      meaning: "Staff can replace it with a new revision.",
    },
    published: {
      kind: "intermediate",
      meaning: "A storefront can activate it.",
    },
    retired: {
      kind: "terminal",
      meaning: "No storefront can activate it again.",
    },
  },
  transitions: [
    {
      event: "replace",
      from: ["draft"],
      to: "draft",
      by: ["staff"],
      guards: [],
    },
    {
      event: "publish",
      from: ["draft"],
      to: "published",
      by: ["staff"],
      guards: [],
    },
    {
      event: "retire",
      from: ["published"],
      to: "retired",
      by: ["staff"],
      guards: ["not_active"],
    },
    {
      event: "activate",
      from: ["published"],
      to: "published",
      by: ["staff"],
      guards: [],
    },
    {
      event: "use",
      from: ["published"],
      to: "published",
      by: ["buyer", "staff"],
      guards: [],
    },
    {
      event: "use",
      from: ["retired"],
      to: "retired",
      by: ["buyer", "staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  CheckoutProfileLifecycle["state"]
>;

const DISCOUNT_MACHINE = {
  name: "discount",
  lifecycle: "DiscountStatus",
  stateType: "plain",
  specSection: 10,
  states: {
    active: {
      kind: "initial",
      meaning: "Its codes and its automatic rule apply.",
    },
    inactive: {
      kind: "terminal",
      meaning: "Turned off. New checkouts do not take it.",
    },
  },
  transitions: [
    {
      event: "apply",
      from: ["active"],
      to: "active",
      by: ["buyer"],
      guards: ["within_window", "uses_left", "minimum_met"],
    },
    {
      event: "deactivate",
      from: ["active"],
      to: "inactive",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<DiscountStatus>;

const CHECKOUT_MACHINE = {
  name: "checkout",
  lifecycle: "CheckoutLifecycle",
  stateType: "tagged",
  specSection: 11,
  states: {
    quoted: {
      kind: "initial",
      meaning:
        "Priced. It holds stock, discount uses and stored value until the quote expires.",
    },
    payment_pending: {
      kind: "intermediate",
      meaning:
        "A payment attempt is open for the amount due. When the quote expires, Underclerk reads the payment from the provider.",
      exit: { kind: "due", reconciler: "payment_due", afterMs: 60000 },
    },
    accepted: {
      kind: "terminal",
      meaning: "Paid and placed. The order exists.",
    },
    expired: {
      kind: "terminal",
      meaning:
        "The quote ran out or the payment was declined. The holds are released.",
    },
  },
  transitions: [
    {
      event: "refresh",
      from: ["quoted"],
      to: "quoted",
      by: ["buyer"],
      guards: ["no_staff_prices", "revisions_match"],
    },
    {
      event: "begin_payment",
      from: ["quoted"],
      to: "payment_pending",
      by: ["buyer", "staff"],
      guards: ["quote_digest_matches", "quote_not_expired"],
    },
    {
      event: "record_capture",
      from: ["payment_pending"],
      to: "payment_pending",
      by: ["provider"],
      guards: [],
    },
    {
      event: "record_progress",
      from: ["payment_pending"],
      to: "payment_pending",
      by: ["provider", "system"],
      guards: [],
    },
    {
      event: "place",
      from: ["payment_pending"],
      to: "accepted",
      by: ["buyer", "staff", "provider"],
      guards: ["payment_captured"],
    },
    {
      event: "place_with_stored_value",
      from: ["quoted"],
      to: "accepted",
      by: ["buyer"],
      guards: [
        "quote_digest_matches",
        "quote_not_expired",
        "stored_value_covers_total",
      ],
    },
    {
      event: "place_manually",
      from: ["quoted"],
      to: "accepted",
      by: ["staff"],
      guards: ["quote_not_expired", "revisions_match", "no_stored_value"],
    },
    {
      event: "decline",
      from: ["payment_pending"],
      to: "expired",
      by: ["provider"],
      guards: [],
    },
    {
      event: "expire",
      from: ["quoted"],
      to: "expired",
      by: ["system", "staff"],
      guards: ["quote_time_passed"],
    },
  ],
} as const satisfies CommerceMachineDefinition<CheckoutLifecycle["state"]>;

const PAYMENT_ATTEMPT_MACHINE = {
  name: "payment_attempt",
  lifecycle: "CheckoutPaymentAttemptLifecycle",
  stateType: "tagged",
  specSection: 12,
  states: {
    pending: {
      kind: "initial",
      meaning:
        "Created for the amount due. The provider has not answered. Underclerk reads it when the quote expires.",
      exit: { kind: "due", reconciler: "payment_due", afterMs: 60000 },
    },
    processing: {
      kind: "intermediate",
      meaning:
        "The provider is working. Underclerk reads it again after `reconcileAfter`, and not before the quote expires.",
      exit: { kind: "due", reconciler: "payment_due", afterMs: 60000 },
    },
    indeterminate: {
      kind: "intermediate",
      meaning:
        "The answer was lost. Underclerk reads it again after `reconcileAfter`, and not before the quote expires.",
      exit: { kind: "due", reconciler: "payment_due", afterMs: 60000 },
    },
    captured: { kind: "terminal", meaning: "The provider took the money." },
    declined: {
      kind: "terminal",
      meaning: "The provider refused the payment.",
    },
  },
  transitions: [
    {
      event: "capture",
      from: ["pending", "processing", "indeterminate"],
      to: "captured",
      by: ["provider"],
      guards: ["answer_time_valid"],
    },
    {
      event: "report_processing",
      from: ["pending", "processing", "indeterminate"],
      to: "processing",
      by: ["provider"],
      guards: ["answer_time_valid"],
    },
    {
      event: "report_indeterminate",
      from: ["pending", "processing", "indeterminate"],
      to: "indeterminate",
      by: ["provider", "system"],
      guards: ["answer_time_valid"],
    },
    {
      event: "decline",
      from: ["pending", "processing", "indeterminate"],
      to: "declined",
      by: ["provider"],
      guards: ["answer_time_valid"],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  CheckoutPaymentAttemptLifecycle["state"]
>;

const PAYMENT_MACHINE = {
  name: "payment",
  lifecycle: "PaymentLifecycle",
  stateType: "tagged",
  specSection: 12,
  states: {
    pending: {
      kind: "external",
      meaning: "A payment read from another platform that is not authorized.",
    },
    authorized: {
      kind: "external",
      meaning: "A payment read from another platform that is authorized.",
    },
    failed: {
      kind: "external",
      meaning: "A payment read from another platform that failed.",
    },
    captured: {
      kind: "initial",
      meaning: "Paid at placement, by a provider or by stored value.",
    },
    partially_refunded: {
      kind: "intermediate",
      meaning: "Part of the amount went back.",
    },
    refunded: {
      kind: "terminal",
      meaning: "All of the amount went back. A dispute can still arrive.",
    },
  },
  transitions: [
    {
      event: "request_refund",
      from: ["captured"],
      to: "captured",
      by: ["staff"],
      guards: ["amount_within_refundable"],
    },
    {
      event: "request_refund",
      from: ["partially_refunded"],
      to: "partially_refunded",
      by: ["staff"],
      guards: ["amount_within_refundable"],
    },
    {
      event: "refund_part",
      from: ["captured", "partially_refunded"],
      to: "partially_refunded",
      by: ["provider", "system"],
      guards: [],
    },
    {
      event: "refund_rest",
      from: ["captured", "partially_refunded"],
      to: "refunded",
      by: ["provider", "system"],
      guards: [],
    },
    {
      event: "record_dispute",
      from: ["captured"],
      to: "captured",
      by: ["provider"],
      guards: [],
    },
    {
      event: "record_dispute",
      from: ["partially_refunded"],
      to: "partially_refunded",
      by: ["provider"],
      guards: [],
    },
    {
      event: "record_dispute",
      from: ["refunded"],
      to: "refunded",
      by: ["provider"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<PaymentLifecycle["state"]>;

const PAYMENT_DISPUTE_MACHINE = {
  name: "payment_dispute",
  lifecycle: "PaymentDisputeLifecycle",
  stateType: "tagged",
  specSection: 12,
  states: {
    action_required: {
      kind: "initial",
      meaning: "The merchant must answer by `responseDueAt`.",
    },
    under_review: {
      kind: "intermediate",
      meaning: "The bank reviews the answer.",
    },
    won: { kind: "terminal", meaning: "The bank decided for the merchant." },
    lost: { kind: "terminal", meaning: "The bank decided for the buyer." },
  },
  transitions: [
    {
      event: "report_action_required",
      from: ["action_required", "under_review"],
      to: "action_required",
      by: ["provider"],
      guards: ["later_observation"],
    },
    {
      event: "report_under_review",
      from: ["action_required", "under_review"],
      to: "under_review",
      by: ["provider"],
      guards: ["later_observation"],
    },
    {
      event: "win",
      from: ["action_required", "under_review"],
      to: "won",
      by: ["provider"],
      guards: ["later_observation"],
    },
    {
      event: "lose",
      from: ["action_required", "under_review"],
      to: "lost",
      by: ["provider"],
      guards: ["later_observation"],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  PaymentDisputeLifecycle["state"]
>;

const ORDER_MACHINE = {
  name: "order",
  lifecycle: "OrderLifecycle",
  stateType: "tagged",
  specSection: 13,
  states: {
    pending_confirmation: {
      kind: "external",
      meaning: "An order read from another platform that is not confirmed.",
    },
    confirmed: {
      kind: "external",
      meaning: "An order read from another platform that is confirmed.",
    },
    fulfillment_pending: {
      kind: "initial",
      meaning: "Placed. At least one fulfillment is open.",
    },
    partially_fulfilled: {
      kind: "intermediate",
      meaning: "Some fulfillments are complete and some are open.",
    },
    fulfilled: {
      kind: "intermediate",
      meaning: "Every fulfillment is complete. An exchange can open a new one.",
    },
    cancelled: {
      kind: "terminal",
      meaning: "Cancelled before fulfillment. Its refunds still resolve.",
    },
  },
  transitions: [
    {
      event: "edit",
      from: ["fulfillment_pending"],
      to: "fulfillment_pending",
      by: ["staff"],
      guards: ["pickup_not_ready"],
    },
    {
      event: "open_balance",
      from: ["fulfillment_pending"],
      to: "fulfillment_pending",
      by: ["buyer"],
      guards: ["balance_outstanding"],
    },
    {
      event: "pay_balance",
      from: ["fulfillment_pending"],
      to: "fulfillment_pending",
      by: ["buyer"],
      guards: ["balance_outstanding"],
    },
    {
      event: "ready_pickup",
      from: ["fulfillment_pending"],
      to: "fulfillment_pending",
      by: ["staff"],
      guards: ["balance_paid"],
    },
    {
      event: "prepare",
      from: ["fulfillment_pending"],
      to: "fulfillment_pending",
      by: ["staff"],
      guards: [],
    },
    {
      event: "complete_pickup",
      from: ["fulfillment_pending"],
      to: "fulfilled",
      by: ["staff"],
      guards: ["payments_paid", "last_open_fulfillment"],
    },
    {
      event: "complete_pickup_part",
      from: ["fulfillment_pending"],
      to: "partially_fulfilled",
      by: ["staff"],
      guards: ["payments_paid"],
    },
    {
      event: "deliver",
      from: ["fulfillment_pending"],
      to: "fulfilled",
      by: ["provider"],
      guards: ["handed_to_carrier", "last_open_fulfillment"],
    },
    {
      event: "deliver_part",
      from: ["fulfillment_pending"],
      to: "partially_fulfilled",
      by: ["provider"],
      guards: ["handed_to_carrier"],
    },
    {
      event: "cancel",
      from: ["fulfillment_pending"],
      to: "cancelled",
      by: ["staff"],
      guards: ["preparation_not_completed", "payments_refundable"],
    },
    {
      event: "resolve_cancellation",
      from: ["cancelled"],
      to: "cancelled",
      by: ["provider", "system"],
      guards: [],
    },
    {
      event: "exchange",
      from: ["fulfilled"],
      to: "fulfillment_pending",
      by: ["staff"],
      guards: ["return_received"],
    },
    {
      event: "request_return",
      from: ["fulfilled"],
      to: "fulfilled",
      by: ["buyer", "staff"],
      guards: [],
    },
    {
      event: "refund",
      from: ["fulfillment_pending"],
      to: "fulfillment_pending",
      by: ["staff"],
      guards: ["amount_within_refundable"],
    },
    {
      event: "refund",
      from: ["partially_fulfilled"],
      to: "partially_fulfilled",
      by: ["staff"],
      guards: ["amount_within_refundable"],
    },
    {
      event: "refund",
      from: ["fulfilled"],
      to: "fulfilled",
      by: ["staff"],
      guards: ["amount_within_refundable"],
    },
    {
      event: "refund",
      from: ["cancelled"],
      to: "cancelled",
      by: ["staff"],
      guards: ["amount_within_refundable"],
    },
  ],
} as const satisfies CommerceMachineDefinition<OrderLifecycle["state"]>;

const DRAFT_ORDER_MACHINE = {
  name: "draft_order",
  lifecycle: "DraftOrderState",
  stateType: "plain",
  specSection: 13,
  states: {
    open: { kind: "initial", meaning: "Staff can change it." },
    invoiced: {
      kind: "intermediate",
      meaning: "Its invoice link opens this revision until the link expires.",
    },
    cancelled: { kind: "terminal", meaning: "No invoice opens it again." },
  },
  transitions: [
    {
      event: "update",
      from: ["open", "invoiced"],
      to: "open",
      by: ["staff"],
      guards: ["not_completed"],
    },
    {
      event: "send_invoice",
      from: ["open", "invoiced"],
      to: "invoiced",
      by: ["staff"],
      guards: ["not_completed"],
    },
    {
      event: "cancel",
      from: ["open", "invoiced"],
      to: "cancelled",
      by: ["staff"],
      guards: ["not_completed"],
    },
    {
      event: "mark_paid",
      from: ["open"],
      to: "open",
      by: ["staff"],
      guards: ["not_completed"],
    },
    {
      event: "mark_paid",
      from: ["invoiced"],
      to: "invoiced",
      by: ["staff"],
      guards: ["not_completed"],
    },
  ],
} as const satisfies CommerceMachineDefinition<DraftOrderState>;

const PICKUP_FULFILLMENT_MACHINE = {
  name: "pickup_fulfillment",
  lifecycle: "PickupFulfillmentLifecycle",
  stateType: "tagged",
  specSection: 14,
  states: {
    requested: {
      kind: "initial",
      meaning: "Waits for staff to make it ready.",
    },
    preparing: {
      kind: "external",
      meaning:
        "A fulfillment read from another platform uses it; Underclerk does not write it.",
    },
    blocked: {
      kind: "external",
      meaning:
        "A fulfillment read from another platform uses it; Underclerk does not write it.",
    },
    ready_for_pickup: {
      kind: "intermediate",
      meaning: "Ready. The buyer may collect it.",
    },
    completed: { kind: "terminal", meaning: "Handed to the buyer." },
    cancelled: { kind: "terminal", meaning: "Cancelled with its order." },
  },
  transitions: [
    {
      event: "edit",
      from: ["requested"],
      to: "requested",
      by: ["staff"],
      guards: ["no_handed_over_fulfillment"],
    },
    {
      event: "prepare",
      from: ["requested"],
      to: "requested",
      by: ["staff"],
      guards: [],
    },
    {
      event: "ready",
      from: ["requested"],
      to: "ready_for_pickup",
      by: ["staff"],
      guards: ["balance_paid"],
    },
    {
      event: "complete",
      from: ["ready_for_pickup"],
      to: "completed",
      by: ["staff"],
      guards: ["payments_paid"],
    },
    {
      event: "cancel",
      from: ["requested"],
      to: "cancelled",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  PickupFulfillmentLifecycle["state"]
>;

const SHIPPING_FULFILLMENT_MACHINE = {
  name: "shipping_fulfillment",
  lifecycle: "ShippingFulfillmentLifecycle",
  stateType: "tagged",
  specSection: 14,
  states: {
    requested: { kind: "initial", meaning: "Waits for the carrier." },
    preparing: {
      kind: "external",
      meaning:
        "A fulfillment read from another platform uses it; Underclerk does not write it.",
    },
    blocked: {
      kind: "external",
      meaning:
        "A fulfillment read from another platform uses it; Underclerk does not write it.",
    },
    handed_to_carrier: {
      kind: "terminal",
      meaning: "The carrier has the parcel. The shipment records the delivery.",
    },
    cancelled: { kind: "terminal", meaning: "Cancelled with its order." },
  },
  transitions: [
    {
      event: "hand_over",
      from: ["requested"],
      to: "handed_to_carrier",
      by: ["staff", "provider"],
      guards: ["label_purchased"],
    },
    {
      event: "deliver",
      from: ["handed_to_carrier"],
      to: "handed_to_carrier",
      by: ["provider"],
      guards: [],
    },
    {
      event: "cancel",
      from: ["requested"],
      to: "cancelled",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  ShippingFulfillmentLifecycle["state"]
>;

const SHIPMENT_MACHINE = {
  name: "shipment",
  lifecycle: "FirstPartyShipmentLifecycle",
  stateType: "tagged",
  specSection: 14,
  states: {
    ready: { kind: "initial", meaning: "Placed. No label is bought yet." },
    label_purchased: { kind: "intermediate", meaning: "The label is bought." },
    in_transit: {
      kind: "intermediate",
      meaning: "The carrier has scanned the parcel.",
    },
    delivered: {
      kind: "terminal",
      meaning: "The carrier delivered the parcel.",
    },
  },
  transitions: [
    {
      event: "quote_label",
      from: ["ready"],
      to: "ready",
      by: ["staff"],
      guards: [],
    },
    {
      event: "purchase_label",
      from: ["ready"],
      to: "label_purchased",
      by: ["staff"],
      guards: ["rate_quote_current"],
    },
    {
      event: "hand_over",
      from: ["label_purchased"],
      to: "in_transit",
      by: ["staff", "provider"],
      guards: ["tracking_number_matches"],
    },
    {
      event: "deliver",
      from: ["in_transit"],
      to: "delivered",
      by: ["provider"],
      guards: ["scan_after_handover"],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  FirstPartyShipmentLifecycle["state"]
>;

const REFUND_ATTEMPT_MACHINE = {
  name: "refund_attempt",
  lifecycle: "RefundAttemptLifecycle",
  stateType: "tagged",
  specSection: 15,
  states: {
    requested: {
      kind: "initial",
      meaning: "Reserved before Underclerk asks the provider.",
    },
    processing: {
      kind: "intermediate",
      meaning: "The provider is working. The merchant's alarm reads it again.",
    },
    indeterminate: {
      kind: "intermediate",
      meaning: "The answer was lost. The merchant's alarm reads it again.",
    },
    succeeded: {
      kind: "terminal",
      meaning: "The money went back, to the card or to stored value.",
    },
    failed: { kind: "terminal", meaning: "The provider refused the refund." },
  },
  transitions: [
    {
      event: "ask_provider",
      from: ["requested"],
      to: "requested",
      by: ["staff", "system"],
      guards: [],
    },
    {
      event: "ask_provider",
      from: ["processing"],
      to: "processing",
      by: ["staff", "system"],
      guards: [],
    },
    {
      event: "ask_provider",
      from: ["indeterminate"],
      to: "indeterminate",
      by: ["staff", "system"],
      guards: [],
    },
    {
      event: "succeed",
      from: ["requested", "processing", "indeterminate"],
      to: "succeeded",
      by: ["provider", "system"],
      guards: [],
    },
    {
      event: "report_processing",
      from: ["requested", "processing", "indeterminate"],
      to: "processing",
      by: ["provider"],
      guards: [],
    },
    {
      event: "report_indeterminate",
      from: ["requested", "processing", "indeterminate"],
      to: "indeterminate",
      by: ["provider", "system"],
      guards: [],
    },
    {
      event: "fail",
      from: ["requested", "processing", "indeterminate"],
      to: "failed",
      by: ["provider"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<RefundAttemptLifecycle["state"]>;

const RETURN_MACHINE = {
  name: "return",
  lifecycle: "ReturnState",
  stateType: "plain",
  specSection: 15,
  states: {
    requested: {
      kind: "initial",
      meaning: "Asked for by the buyer or by staff.",
    },
    authorized: {
      kind: "intermediate",
      meaning: "Staff accepted some of its lines.",
    },
    rejected: { kind: "terminal", meaning: "Staff refused every line." },
    received: {
      kind: "intermediate",
      meaning: "The units are back, each line with its disposition.",
    },
    closed: {
      kind: "terminal",
      meaning: "A refund or an exchange settled it.",
    },
  },
  transitions: [
    {
      event: "authorize",
      from: ["requested"],
      to: "authorized",
      by: ["staff"],
      guards: [],
    },
    {
      event: "reject",
      from: ["requested"],
      to: "rejected",
      by: ["staff"],
      guards: [],
    },
    {
      event: "receive",
      from: ["authorized"],
      to: "received",
      by: ["staff"],
      guards: [],
    },
    {
      event: "close",
      from: ["received"],
      to: "closed",
      by: ["staff"],
      guards: ["refund_succeeded"],
    },
    {
      event: "exchange",
      from: ["received"],
      to: "closed",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<ReturnState>;

const CUSTOMER_MACHINE = {
  name: "customer",
  lifecycle: "CustomerState",
  stateType: "plain",
  specSection: 16,
  states: {
    active: { kind: "initial", meaning: "Its sealed profile can be read." },
    erased: {
      kind: "terminal",
      meaning: "Its key is deleted, so no field can be read.",
    },
  },
  transitions: [
    {
      event: "update",
      from: ["active"],
      to: "active",
      by: ["staff", "buyer"],
      guards: [],
    },
    {
      event: "erase",
      from: ["active"],
      to: "erased",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<CustomerState>;

const STORED_VALUE_ACCOUNT_MACHINE = {
  name: "stored_value_account",
  lifecycle: "StoredValueAccountStatus",
  stateType: "plain",
  specSection: 17,
  states: {
    active: { kind: "initial", meaning: "Pays at checkout until it expires." },
    disabled: {
      kind: "terminal",
      meaning:
        "Staff turned it off. It keeps its balance and still takes refunds.",
    },
  },
  transitions: [
    {
      event: "apply",
      from: ["active"],
      to: "active",
      by: ["buyer"],
      guards: ["not_expired", "same_currency"],
    },
    {
      event: "credit",
      from: ["active"],
      to: "active",
      by: ["staff", "system"],
      guards: [],
    },
    {
      event: "credit",
      from: ["disabled"],
      to: "disabled",
      by: ["staff", "system"],
      guards: [],
    },
    {
      event: "disable",
      from: ["active"],
      to: "disabled",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<StoredValueAccountStatus>;

const WEBHOOK_SUBSCRIPTION_MACHINE = {
  name: "webhook_subscription",
  lifecycle: "WebhookSubscriptionState",
  stateType: "plain",
  specSection: 18,
  states: {
    active: { kind: "initial", meaning: "Receives posts." },
    failing: {
      kind: "intermediate",
      meaning:
        "An event still failed 48 hours after its first post. No posts until staff restart it.",
    },
  },
  transitions: [
    {
      event: "fail",
      from: ["active"],
      to: "failing",
      by: ["system"],
      guards: ["failed_for_48_hours"],
    },
    {
      event: "restart",
      from: ["failing"],
      to: "active",
      by: ["staff"],
      guards: [],
    },
    {
      event: "rotate_secret",
      from: ["active"],
      to: "active",
      by: ["staff"],
      guards: [],
    },
    {
      event: "rotate_secret",
      from: ["failing"],
      to: "failing",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<WebhookSubscriptionState>;

const PLUGIN_MACHINE = {
  name: "plugin",
  lifecycle: "PluginState",
  stateType: "plain",
  specSection: 21,
  states: {
    active: {
      kind: "initial",
      meaning: "Its routes answer and its pipeline steps run.",
    },
    paused: {
      kind: "intermediate",
      meaning:
        "Its routes answer 404 and its pipeline steps are skipped. Its data stays.",
    },
    removed: {
      kind: "terminal",
      meaning: "A merchant plugin that its merchant removed. Its data stays.",
    },
  },
  transitions: [
    {
      event: "pause",
      from: ["active"],
      to: "paused",
      by: ["staff"],
      guards: ["no_active_dependents"],
    },
    {
      event: "auto_pause",
      from: ["active"],
      to: "paused",
      by: ["system"],
      guards: ["no_active_dependents"],
    },
    {
      event: "resume",
      from: ["paused"],
      to: "active",
      by: ["staff"],
      guards: ["dependencies_active"],
    },
    {
      event: "remove",
      from: ["active", "paused"],
      to: "removed",
      by: ["staff"],
      guards: ["merchant_plugin"],
    },
  ],
} as const satisfies CommerceMachineDefinition<PluginState>;

const UNPLACED_CAPTURE_MACHINE = {
  name: "unplaced_capture",
  lifecycle: "UnplacedCaptureLifecycle",
  stateType: "tagged",
  specSection: 12,
  states: {
    capture_unplaced: {
      kind: "initial",
      meaning:
        "The provider took the money, and Underclerk placed no order. Underclerk does not refund it by itself.",
      exit: { kind: "person", surface: "admin_unplaced_captures" },
    },
    resolved: {
      kind: "terminal",
      meaning:
        "Staff refunded the buyer on the provider, or made the order by hand.",
    },
  },
  transitions: [
    {
      event: "resolve",
      from: ["capture_unplaced"],
      to: "resolved",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  UnplacedCaptureLifecycle["state"]
>;

const CREDENTIAL_MACHINE = {
  name: "credential",
  lifecycle: "CredentialState",
  stateType: "plain",
  specSection: 3,
  states: {
    active: {
      kind: "initial",
      meaning:
        "Opens the routes of its scopes on its merchant until its `expiresAt`.",
    },
    revoked: {
      kind: "terminal",
      meaning:
        "Refused. A person revoked it, the credential that issued it was revoked, or the merchant closed.",
    },
    expired: {
      kind: "terminal",
      meaning: "Refused. Its `expiresAt` passed.",
    },
  },
  transitions: [
    {
      event: "revoke",
      from: ["active"],
      to: "revoked",
      by: ["staff", "system"],
      guards: [],
    },
    {
      event: "expire",
      from: ["active"],
      to: "expired",
      by: ["system"],
      guards: ["expiry_passed"],
    },
  ],
} as const satisfies CommerceMachineDefinition<CredentialState>;

const PREPARATION_TICKET_MACHINE = {
  name: "preparation_ticket",
  lifecycle: "PreparationTicketLifecycle",
  stateType: "tagged",
  specSection: 21,
  states: {
    queued: {
      kind: "initial",
      meaning: "Staff opened it for a paid made-to-order pickup.",
    },
    preparing: {
      kind: "intermediate",
      meaning:
        "Staff started it. The order's stock is still allocated, not used.",
    },
    completed: {
      kind: "terminal",
      meaning: "Staff made it. Its stock left the lots that were fit to use.",
    },
    cancelled: {
      kind: "terminal",
      meaning:
        "Staff cancelled the order before preparation ended. Its stock came back.",
    },
  },
  transitions: [
    {
      event: "start",
      from: ["queued"],
      to: "preparing",
      by: ["staff"],
      guards: [],
    },
    {
      event: "complete",
      from: ["preparing"],
      to: "completed",
      by: ["staff"],
      guards: ["lots_fit_to_use"],
    },
    {
      event: "cancel",
      from: ["queued", "preparing"],
      to: "cancelled",
      by: ["staff"],
      guards: [],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  PreparationTicketLifecycle["state"]
>;

const INVENTORY_ALLOCATION_MACHINE = {
  name: "inventory_allocation",
  lifecycle: "InventoryAllocationLifecycle",
  stateType: "tagged",
  specSection: 8,
  states: {
    held: {
      kind: "initial",
      meaning:
        "A quoted checkout line holds the stock until its quote expires.",
      exit: { kind: "due", reconciler: "lapsed_checkouts", afterMs: 60000 },
    },
    allocated_to_order: {
      kind: "initial",
      meaning:
        "A placed order line, or a line that an order edit added, keeps the stock until fulfillment or preparation uses it.",
    },
    committed: {
      kind: "terminal",
      meaning: "A stock movement used it.",
    },
    released: {
      kind: "terminal",
      meaning:
        "The stock came back: the checkout ended, the order was cancelled, or an edit changed the line.",
    },
    expired: {
      kind: "external",
      meaning:
        "Older rows only. A lapsed hold is now released with the reason `checkout_expired`.",
    },
  },
  transitions: [
    {
      event: "refresh",
      from: ["held"],
      to: "held",
      by: ["buyer"],
      guards: [],
    },
    {
      event: "allocate",
      from: ["held"],
      to: "allocated_to_order",
      by: ["buyer", "staff", "system"],
      guards: [],
    },
    {
      event: "commit",
      from: ["allocated_to_order"],
      to: "committed",
      by: ["staff", "provider"],
      guards: ["position_can_commit"],
    },
    {
      event: "release",
      from: ["held", "allocated_to_order"],
      to: "released",
      by: ["buyer", "staff", "system"],
      guards: ["position_can_release"],
    },
  ],
} as const satisfies CommerceMachineDefinition<
  InventoryAllocationLifecycle["state"]
>;

const STOCK_LOT_MACHINE = {
  name: "stock_lot",
  lifecycle: "InventoryLotLifecycle",
  stateType: "tagged",
  specSection: 8,
  states: {
    available: {
      kind: "initial",
      meaning:
        "A sale can use it until its expiry. When its expiry passes, the merchant's alarm expires it.",
      exit: { kind: "due", reconciler: "lot_expiry", afterMs: 60000 },
    },
    depleted: {
      kind: "intermediate",
      meaning: "Nothing is left in it. A count can find stock in it again.",
    },
    expired: {
      kind: "terminal",
      meaning:
        "Its expiry passed. No sale uses it; what is left in it leaves on hand as waste.",
    },
    quarantined: {
      kind: "external",
      meaning:
        "Reserved for a hold by staff. No command writes it, and no sale uses a lot in it.",
    },
  },
  transitions: [
    {
      event: "draw",
      from: ["available"],
      to: "available",
      by: ["buyer", "staff", "system"],
      guards: [],
    },
    {
      event: "deplete",
      from: ["available", "depleted"],
      to: "depleted",
      by: ["buyer", "staff", "system"],
      guards: [],
    },
    {
      event: "restock",
      from: ["depleted"],
      to: "available",
      by: ["staff"],
      guards: [],
    },
    {
      event: "expire",
      from: ["available"],
      to: "expired",
      by: ["staff", "system"],
      guards: ["expiry_passed"],
    },
    {
      event: "write_off",
      from: ["expired"],
      to: "expired",
      by: ["staff", "system"],
      guards: ["stock_not_allocated"],
    },
  ],
} as const satisfies CommerceMachineDefinition<InventoryLotLifecycle["state"]>;

const PURCHASE_REQUEST_MACHINE = {
  name: "purchase_request",
  lifecycle: "PurchaseRequestStatus",
  stateType: "plain",
  specSection: 21,
  states: {
    needs_review: {
      kind: "initial",
      meaning:
        "The reconciler opened it because stock fell below the reorder point.",
    },
    requested: {
      kind: "intermediate",
      meaning: "Staff asked the supplier for it.",
    },
    expected: {
      kind: "intermediate",
      meaning: "The supplier confirmed a delivery.",
    },
    late: {
      kind: "intermediate",
      meaning: "Its expected delivery passed with no receipt.",
    },
    partial: {
      kind: "intermediate",
      meaning: "Receipts that name it cover part of its quantity.",
    },
    received: {
      kind: "terminal",
      meaning:
        "Receipts that name it cover its quantity. A receipt that names it is refused.",
    },
  },
  transitions: [
    {
      event: "request",
      from: ["needs_review"],
      to: "requested",
      by: ["staff"],
      guards: [],
    },
    {
      event: "expect",
      from: ["needs_review", "requested", "late"],
      to: "expected",
      by: ["staff"],
      guards: ["delivery_not_passed"],
    },
    {
      event: "run_late",
      from: ["needs_review", "requested", "expected"],
      to: "late",
      by: ["system"],
      guards: ["delivery_passed", "no_receipt"],
    },
    {
      event: "receive_part",
      from: ["needs_review", "requested", "expected", "late", "partial"],
      to: "partial",
      by: ["system"],
      guards: ["receipts_below_quantity"],
    },
    {
      event: "receive",
      from: ["needs_review", "requested", "expected", "late", "partial"],
      to: "received",
      by: ["system"],
      guards: ["receipts_cover_quantity"],
    },
  ],
} as const satisfies CommerceMachineDefinition<PurchaseRequestStatus>;

export const COMMERCE_MACHINES = {
  checkout_profile: CHECKOUT_PROFILE_MACHINE,
  discount: DISCOUNT_MACHINE,
  checkout: CHECKOUT_MACHINE,
  payment_attempt: PAYMENT_ATTEMPT_MACHINE,
  payment: PAYMENT_MACHINE,
  payment_dispute: PAYMENT_DISPUTE_MACHINE,
  order: ORDER_MACHINE,
  draft_order: DRAFT_ORDER_MACHINE,
  pickup_fulfillment: PICKUP_FULFILLMENT_MACHINE,
  shipping_fulfillment: SHIPPING_FULFILLMENT_MACHINE,
  shipment: SHIPMENT_MACHINE,
  refund_attempt: REFUND_ATTEMPT_MACHINE,
  return: RETURN_MACHINE,
  customer: CUSTOMER_MACHINE,
  stored_value_account: STORED_VALUE_ACCOUNT_MACHINE,
  webhook_subscription: WEBHOOK_SUBSCRIPTION_MACHINE,
  plugin: PLUGIN_MACHINE,
  unplaced_capture: UNPLACED_CAPTURE_MACHINE,
  credential: CREDENTIAL_MACHINE,
  preparation_ticket: PREPARATION_TICKET_MACHINE,
  inventory_allocation: INVENTORY_ALLOCATION_MACHINE,
  stock_lot: STOCK_LOT_MACHINE,
  purchase_request: PURCHASE_REQUEST_MACHINE,
} as const;
