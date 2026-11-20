import { Select } from "../../ui/select";
import type {
  CheckoutProfileConfiguration,
} from "@purin-labs/commerce-contracts";
import React from "react";

import { formatMoneyMinor } from "../../formatting";
import type {
  CheckoutProfileSummary,
} from "@purin-labs/commerce-control-api/portal/checkout-profiles";
import {
  automaticRefundThresholdReady,
  refundGovernanceDescription,
  type BusyAction,
  type CheckoutProfilesAction,
  type ProfileDraft,
  type Readiness,
} from "./model";
import type { Variant } from "@purin-labs/type-utils";

type RefundGovernance =
  CheckoutProfileConfiguration["afterSalePolicy"]["refundGovernance"];

type RefundGovernanceKind = RefundGovernance["kind"];

type ProfileEditorAction = Variant<CheckoutProfilesAction, "replaceDraft">;

type ProfileEditorDispatch = React.Dispatch<ProfileEditorAction>;

const BUYER_KINDS = [
  { value: "guest", label: "Guest checkout" },
  { value: "guest_or_account", label: "Guest or customer account" },
];
const REQUIRED_CONTACTS = [
  {
    value: "email_required_phone_optional",
    label: "Email required, phone optional",
  },
  { value: "email_and_phone_required", label: "Email and phone required" },
];
const FULFILLMENT_KINDS = [
  { value: "pickup_only", label: "Pickup only" },
  { value: "shipping_only", label: "Shipping only" },
  { value: "buyer_choice", label: "Buyer chooses pickup or shipping" },
];
const TAX_KINDS = [
  { value: "merchant_inclusive", label: "Merchant-inclusive tax" },
  { value: "provider_quoted", label: "Provider-quoted tax" },
];
const REFUND_GOVERNANCE_KINDS = [
  { value: "approval_required", label: "Approval required" },
  { value: "automatic_up_to", label: "Automatic up to a threshold" },
];

function renderChoice(
  choice: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={choice.value} value={choice.value}>
      {choice.label}
    </Select.Item>
  );
}

export function ProfileEditor(props: {
  readonly profile: CheckoutProfileSummary;
  readonly draft: ProfileDraft;
  readonly readiness: Readiness;
  readonly canManage: boolean;
  readonly busy: BusyAction;
  readonly dispatch: ProfileEditorDispatch;
  readonly onSave: React.FormEventHandler<HTMLFormElement>;
}): React.ReactNode {
  const selected = props.profile;
  const editorDraft = props.draft;
  const readiness = props.readiness;
  const busy = props.busy;

  return (
    <form className="checkout-profile-editor" onSubmit={props.onSave}>
      <fieldset
        disabled={
          !props.canManage ||
          selected.profile.lifecycle.state !== "draft" ||
          busy !== null
        }
      >
        <legend>1. Where customers shop</legend>
        <div className="checkout-profile-fields checkout-profile-fields-two">
          <label>
            <span>Profile name</span>
            <input
              value={editorDraft.name}
              onChange={handleDraftNameChange.bind(
                null,
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Currency</span>
            <input
              value={editorDraft.configuration.currencyPolicy.currency}
              onChange={handleCurrencyChange.bind(
                null,
                editorDraft,
                props.dispatch,
              )}
              inputMode="text"
              maxLength={3}
              aria-describedby="checkout-currency-help"
              required
            />
            <small id="checkout-currency-help">
              Three-letter settlement currency, such as JPY or SGD.
            </small>
          </label>
          <label>
            <span>Merchant display name</span>
            <input
              value={
                editorDraft.configuration.presentationPolicy.merchantDisplayName
              }
              onChange={handlePresentationChange.bind(
                null,
                "merchantDisplayName",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Checkout locale</span>
            <input
              value={editorDraft.configuration.presentationPolicy.locale}
              onChange={handlePresentationChange.bind(
                null,
                "locale",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Terms policy</span>
            <input
              value={editorDraft.configuration.presentationPolicy.termsPolicyId}
              onChange={handlePresentationChange.bind(
                null,
                "termsPolicyId",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Privacy policy</span>
            <input
              value={
                editorDraft.configuration.presentationPolicy.privacyPolicyId
              }
              onChange={handlePresentationChange.bind(
                null,
                "privacyPolicyId",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Support contact</span>
            <input
              value={
                editorDraft.configuration.presentationPolicy.supportContact
              }
              onChange={handlePresentationChange.bind(
                null,
                "supportContact",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
        </div>
      </fieldset>

      <fieldset
        disabled={
          !props.canManage ||
          selected.profile.lifecycle.state !== "draft" ||
          busy !== null
        }
      >
        <legend>2. Who can order and what they can buy</legend>
        <div className="checkout-profile-fields checkout-profile-fields-three">
          <label>
            <span>Minimum distinct products</span>
            <input
              type="number"
              min="1"
              value={editorDraft.configuration.cartPolicy.minimumLines}
              onChange={handleCartNumberChange.bind(
                null,
                "minimumLines",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Maximum distinct products</span>
            <input
              type="number"
              min="1"
              value={editorDraft.configuration.cartPolicy.maximumLines}
              onChange={handleCartNumberChange.bind(
                null,
                "maximumLines",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Maximum items per order</span>
            <input
              type="number"
              min="1"
              value={editorDraft.configuration.cartPolicy.maximumTotalQuantity}
              onChange={handleCartNumberChange.bind(
                null,
                "maximumTotalQuantity",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Buyer access</span>
            <Select.Root
              items={BUYER_KINDS}
              value={editorDraft.configuration.buyerPolicy.kind}
              onValueChange={handleBuyerKindChange.bind(
                null,
                editorDraft,
                props.dispatch,
              )}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{BUYER_KINDS.map(renderChoice)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            <span>Required contact</span>
            <Select.Root
              items={REQUIRED_CONTACTS}
              value={editorDraft.configuration.buyerPolicy.requiredContact}
              onValueChange={handleBuyerContactChange.bind(
                null,
                editorDraft,
                props.dispatch,
              )}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {REQUIRED_CONTACTS.map(renderChoice)}
              </Select.Popup>
            </Select.Root>
          </label>
          <label>
            <span>Sales channel</span>
            <input
              value={editorDraft.configuration.pricingPolicy.salesChannelId}
              onChange={handleSalesChannelChange.bind(
                null,
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
        </div>
      </fieldset>

      <fieldset
        disabled={
          !props.canManage ||
          selected.profile.lifecycle.state !== "draft" ||
          busy !== null
        }
      >
        <legend>3. How customers receive their order</legend>
        <div className="checkout-profile-fields checkout-profile-fields-two">
          <label>
            <span>Fulfillment choices</span>
            <Select.Root
              items={FULFILLMENT_KINDS}
              value={editorDraft.configuration.fulfillmentPolicy.kind}
              onValueChange={handleFulfillmentKindChange.bind(
                null,
                editorDraft,
                props.dispatch,
              )}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {FULFILLMENT_KINDS.map(renderChoice)}
              </Select.Popup>
            </Select.Root>
          </label>
          {renderFulfillmentFields(editorDraft, props.dispatch)}
          <label>
            <span>Tax calculation</span>
            <Select.Root
              items={TAX_KINDS}
              value={editorDraft.configuration.taxPolicy.kind}
              onValueChange={handleTaxKindChange.bind(
                null,
                editorDraft,
                props.dispatch,
              )}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{TAX_KINDS.map(renderChoice)}</Select.Popup>
            </Select.Root>
          </label>
          {renderTaxFields(editorDraft, props.dispatch)}
        </div>
      </fieldset>

      <fieldset
        disabled={
          !props.canManage ||
          selected.profile.lifecycle.state !== "draft" ||
          busy !== null
        }
      >
        <legend>4. Payment and after-purchase care</legend>
        <div className="checkout-profile-fields checkout-profile-fields-two">
          <label>
            <span>Payment provider binding</span>
            <input
              value={
                editorDraft.configuration.paymentPolicy.paymentProviderBindingId
              }
              onChange={handlePaymentChange.bind(
                null,
                "paymentProviderBindingId",
                editorDraft,
                props.dispatch,
              )}
              required
            />
            <small>
              May resolve to Stripe, GMO-PG, Square, or another certified
              adapter.
            </small>
          </label>
          <label>
            <span>Cancellation policy</span>
            <input
              value={
                editorDraft.configuration.afterSalePolicy.cancellationPolicyId
              }
              onChange={handleAfterSaleChange.bind(
                null,
                "cancellationPolicyId",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          <label>
            <span>Refund policy</span>
            <input
              value={editorDraft.configuration.afterSalePolicy.refundPolicyId}
              onChange={handleAfterSaleChange.bind(
                null,
                "refundPolicyId",
                editorDraft,
                props.dispatch,
              )}
              required
            />
          </label>
          {renderRefundGovernanceFields(editorDraft, props.dispatch)}
        </div>
      </fieldset>

      {selected.profile.lifecycle.state === "draft" && props.canManage ? (
        <div className="checkout-profile-editor-actions">
          <button
            type="submit"
            disabled={busy !== null || readiness.blockers.length > 0}
          >
            Save checkout settings
          </button>
          <span>Saving preserves every earlier revision.</span>
        </div>
      ) : null}
    </form>
  );
}

function replaceDraft(
  dispatch: ProfileEditorDispatch,
  draft: ProfileDraft,
): void {
  dispatch({ kind: "replaceDraft", draft });
}

function handleDraftNameChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  replaceDraft(write, { ...draft, name: event.currentTarget.value });
}

function handleCurrencyChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const currency = event.currentTarget.value.toUpperCase();
  replaceDraft(write, {
    ...draft,
    configuration: {
      ...draft.configuration,
      currencyPolicy: { kind: "fixed", currency },
      afterSalePolicy: {
        ...draft.configuration.afterSalePolicy,
        refundGovernance: refundGovernanceWithCurrency(
          draft.configuration.afterSalePolicy.refundGovernance,
          currency,
        ),
      },
    },
  });
}

function handlePresentationChange(
  field:
    | "locale"
    | "merchantDisplayName"
    | "termsPolicyId"
    | "privacyPolicyId"
    | "supportContact",
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  replaceDraft(write, {
    ...draft,
    configuration: {
      ...draft.configuration,
      presentationPolicy: {
        ...draft.configuration.presentationPolicy,
        [field]: event.currentTarget.value,
      },
    },
  });
}

function handleSalesChannelChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  replaceDraft(write, {
    ...draft,
    configuration: {
      ...draft.configuration,
      pricingPolicy: {
        kind: "published_offers",
        salesChannelId: event.currentTarget.value,
      },
    },
  });
}

function handleCartNumberChange(
  field: "minimumLines" | "maximumLines" | "maximumTotalQuantity",
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  replaceDraft(write, {
    ...draft,
    configuration: {
      ...draft.configuration,
      cartPolicy: {
        ...draft.configuration.cartPolicy,
        [field]: event.currentTarget.valueAsNumber,
      },
    },
  });
}

function handleBuyerKindChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  value: string | null,
): void {
  if (value === null) return;
  const requiredContact = draft.configuration.buyerPolicy.requiredContact;
  const buyerPolicy =
    value === "guest"
      ? { kind: "guest" as const, requiredContact }
      : {
          kind: "guest_or_account" as const,
          requiredContact,
          savedAddressPolicy: "enabled" as const,
        };
  replaceDraft(write, {
    ...draft,
    configuration: { ...draft.configuration, buyerPolicy },
  });
}

function handleBuyerContactChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  value: string | null,
): void {
  if (value === null) return;
  const requiredContact =
    value === "email_and_phone_required"
      ? ("email_and_phone_required" as const)
      : ("email_required_phone_optional" as const);
  const buyerPolicy =
    draft.configuration.buyerPolicy.kind === "guest"
      ? { kind: "guest" as const, requiredContact }
      : { ...draft.configuration.buyerPolicy, requiredContact };
  replaceDraft(write, {
    ...draft,
    configuration: { ...draft.configuration, buyerPolicy },
  });
}

function handleFulfillmentKindChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  value: string | null,
): void {
  if (value === null) return;
  const current = draft.configuration.fulfillmentPolicy;
  const pickupPolicyId =
    current.kind === "shipping_only" ? "" : current.pickupPolicyId;
  const shippingPolicyId =
    current.kind === "pickup_only" ? "" : current.shippingPolicyId;
  const fulfillmentPolicy =
    value === "pickup_only"
      ? { kind: "pickup_only" as const, pickupPolicyId }
      : value === "shipping_only"
        ? { kind: "shipping_only" as const, shippingPolicyId }
        : { kind: "buyer_choice" as const, pickupPolicyId, shippingPolicyId };
  replaceDraft(write, {
    ...draft,
    configuration: { ...draft.configuration, fulfillmentPolicy },
  });
}

function handleFulfillmentReferenceChange(
  field: "pickupPolicyId" | "shippingPolicyId",
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const value = event.currentTarget.value;
  const current = draft.configuration.fulfillmentPolicy;
  const fulfillmentPolicy =
    current.kind === "pickup_only"
      ? { ...current, pickupPolicyId: value }
      : current.kind === "shipping_only"
        ? { ...current, shippingPolicyId: value }
        : field === "pickupPolicyId"
          ? { ...current, pickupPolicyId: value }
          : { ...current, shippingPolicyId: value };
  replaceDraft(write, {
    ...draft,
    configuration: { ...draft.configuration, fulfillmentPolicy },
  });
}

function handleTaxKindChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  value: string | null,
): void {
  if (value === null) return;
  const current = draft.configuration.taxPolicy;
  const taxPolicy =
    value === "merchant_inclusive"
      ? {
          kind: "merchant_inclusive" as const,
          jurisdictionPolicyId:
            current.kind === "merchant_inclusive"
              ? current.jurisdictionPolicyId
              : "",
        }
      : {
          kind: "provider_quoted" as const,
          taxCapabilityId:
            current.kind === "provider_quoted" ? current.taxCapabilityId : "",
          registrationPolicyId:
            current.kind === "provider_quoted"
              ? current.registrationPolicyId
              : "",
        };
  replaceDraft(write, {
    ...draft,
    configuration: { ...draft.configuration, taxPolicy },
  });
}

function handleTaxReferenceChange(
  field: "jurisdictionPolicyId" | "taxCapabilityId" | "registrationPolicyId",
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const current = draft.configuration.taxPolicy;
  const value = event.currentTarget.value;
  const taxPolicy =
    current.kind === "merchant_inclusive"
      ? { ...current, jurisdictionPolicyId: value }
      : field === "taxCapabilityId"
        ? { ...current, taxCapabilityId: value }
        : { ...current, registrationPolicyId: value };
  replaceDraft(write, {
    ...draft,
    configuration: { ...draft.configuration, taxPolicy },
  });
}

function handlePaymentChange(
  field: "paymentProviderBindingId",
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  replaceDraft(write, {
    ...draft,
    configuration: {
      ...draft.configuration,
      paymentPolicy: {
        ...draft.configuration.paymentPolicy,
        [field]: event.currentTarget.value,
      },
    },
  });
}

function handleAfterSaleChange(
  field: "cancellationPolicyId" | "refundPolicyId",
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  replaceDraft(write, {
    ...draft,
    configuration: {
      ...draft.configuration,
      afterSalePolicy: {
        ...draft.configuration.afterSalePolicy,
        [field]: event.currentTarget.value,
      },
    },
  });
}

function handleRefundGovernanceKindChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  value: string | null,
): void {
  const kind = value;
  if (kind !== "approval_required" && kind !== "automatic_up_to") {
    return;
  }
  replaceDraft(write, {
    ...draft,
    configuration: {
      ...draft.configuration,
      afterSalePolicy: {
        ...draft.configuration.afterSalePolicy,
        refundGovernance: refundGovernanceForKind(
          draft.configuration.afterSalePolicy.refundGovernance,
          kind,
          draft.configuration.currencyPolicy.currency,
        ),
      },
    },
  });
}

function handleRefundThresholdChange(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const current = draft.configuration.afterSalePolicy.refundGovernance;
  if (current.kind !== "automatic_up_to") {
    return;
  }
  replaceDraft(write, {
    ...draft,
    configuration: {
      ...draft.configuration,
      afterSalePolicy: {
        ...draft.configuration.afterSalePolicy,
        refundGovernance: {
          kind: "automatic_up_to",
          threshold: {
            amountMinor: refundThresholdAmount(event),
            currency: draft.configuration.currencyPolicy.currency,
          },
        },
      },
    },
  });
}

function refundThresholdAmount(
  event: React.ChangeEvent<HTMLInputElement>,
): number {
  const amount = event.currentTarget.valueAsNumber;
  return Number.isFinite(amount) ? amount : 0;
}

function refundGovernanceForKind(
  current: RefundGovernance,
  kind: RefundGovernanceKind,
  currency: string,
): RefundGovernance {
  switch (kind) {
    case "approval_required":
      return { kind: "approval_required" };
    case "automatic_up_to":
      return {
        kind: "automatic_up_to",
        threshold:
          current.kind === "automatic_up_to"
            ? { amountMinor: current.threshold.amountMinor, currency }
            : { amountMinor: 0, currency },
      };
  }
}

function refundGovernanceWithCurrency(
  current: RefundGovernance,
  currency: string,
): RefundGovernance {
  switch (current.kind) {
    case "approval_required":
      return { kind: "approval_required" };
    case "automatic_up_to":
      return {
        kind: "automatic_up_to",
        threshold: { amountMinor: current.threshold.amountMinor, currency },
      };
  }
}

function renderRefundGovernanceFields(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
): React.ReactNode {
  const governance = draft.configuration.afterSalePolicy.refundGovernance;
  const currency = draft.configuration.currencyPolicy.currency;
  return (
    <>
      <label>
        <span>Refund governance</span>
        <Select.Root
          items={REFUND_GOVERNANCE_KINDS}
          value={governance.kind}
          onValueChange={handleRefundGovernanceKindChange.bind(
            null,
            draft,
            write,
          )}
        >
          <Select.Trigger aria-describedby="checkout-refund-governance-help">
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {REFUND_GOVERNANCE_KINDS.map(renderChoice)}
          </Select.Popup>
        </Select.Root>
        <small id="checkout-refund-governance-help">
          {refundGovernanceDescription(draft.configuration)}
        </small>
      </label>
      {governance.kind === "approval_required" ? null : (
        <label>
          <span>Automatic refund threshold ({currency} minor units)</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={governance.threshold.amountMinor}
            onChange={handleRefundThresholdChange.bind(null, draft, write)}
            aria-describedby="checkout-refund-governance-help"
            aria-invalid={!automaticRefundThresholdReady(draft.configuration)}
            required
          />
          {automaticRefundThresholdReady(draft.configuration) ? (
            <small>
              Equals{" "}
              {formatMoneyMinor(governance.threshold.amountMinor, currency)}.
            </small>
          ) : null}
        </label>
      )}
    </>
  );
}

function renderFulfillmentFields(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
): React.ReactNode {
  const policy = draft.configuration.fulfillmentPolicy;
  return (
    <>
      {policy.kind === "shipping_only" ? null : (
        <label>
          <span>Pickup policy</span>
          <input
            value={policy.pickupPolicyId}
            onChange={handleFulfillmentReferenceChange.bind(
              null,
              "pickupPolicyId",
              draft,
              write,
            )}
            required
          />
        </label>
      )}
      {policy.kind === "pickup_only" ? null : (
        <label>
          <span>Shipping policy</span>
          <input
            value={policy.shippingPolicyId}
            onChange={handleFulfillmentReferenceChange.bind(
              null,
              "shippingPolicyId",
              draft,
              write,
            )}
            required
          />
        </label>
      )}
    </>
  );
}

function renderTaxFields(
  draft: ProfileDraft,
  write: ProfileEditorDispatch,
): React.ReactNode {
  const policy = draft.configuration.taxPolicy;
  return policy.kind === "merchant_inclusive" ? (
    <label>
      <span>Jurisdiction policy</span>
      <input
        value={policy.jurisdictionPolicyId}
        onChange={handleTaxReferenceChange.bind(
          null,
          "jurisdictionPolicyId",
          draft,
          write,
        )}
        required
      />
    </label>
  ) : (
    <>
      <label>
        <span>Tax capability</span>
        <input
          value={policy.taxCapabilityId}
          onChange={handleTaxReferenceChange.bind(
            null,
            "taxCapabilityId",
            draft,
            write,
          )}
          required
        />
      </label>
      <label>
        <span>Tax registration policy</span>
        <input
          value={policy.registrationPolicyId}
          onChange={handleTaxReferenceChange.bind(
            null,
            "registrationPolicyId",
            draft,
            write,
          )}
          required
        />
      </label>
    </>
  );
}
