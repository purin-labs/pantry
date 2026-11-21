import type { CommerceSystemKind } from "@purin-labs/contracts";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";
import React from "react";
import { CommerceActionTrace } from "./commerce-trace";
import { CafeMenuPublicationDetails } from "./cafe-menu-details";
import { MenuPriceChangeDetails } from "./menu-price-card";
import { OrderRefundDetails } from "./order-refund-details";
import { StockOperationCard } from "./stock-operation-details";
import type {
  CommerceActionDetails,
  MerchantPluginSettingDetails,
  CommerceActionRecord,
  MerchantPluginPreview,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import { formatCommerceActionAmount, formatOfferPrice, commerceActionStateLabel, commerceActionTitle } from "./commerce";
import { runAsync } from "../../pages/agent-console-shared";
import { DecisionButtons } from "../../ui";
import {
  commerceSourceLabel,
  formatCommerceTimestamp,
} from "../commerce/entity-plane/presentation";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

export function CommerceActionStatus(input: {
  readonly action: CommerceActionRecord;
  readonly approve: () => Promise<void>;
  readonly reject: () => Promise<void>;
  readonly execute: () => Promise<void>;
  readonly readPluginPreview: () => Promise<MerchantPluginPreview>;
  readonly canAct: boolean;
  readonly disabled: boolean;
}): React.ReactNode {
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useLayoutEffect(focusCommerceAction.bind(null, heading), [
    input.action.nonce,
  ]);
  const awaitingDecision =
    input.action.state === "proposed" ||
    input.action.state === "approval_requested";
  const executable = input.action.state === "signed";
  const reconcilable = input.action.state === "indeterminate";
  const terminal =
    input.action.state === "confirmed" || input.action.state === "failed";
  return (
    <section className="portal-band commerce-action-status" aria-live="polite">
      <div className="action-status-heading">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {commerceActionTitle(input.action.verb)}
          </h2>
        </div>
        <span className={`action-state action-state-${input.action.state}`}>
          {commerceActionStateLabel(input.action.state)}
        </span>
      </div>
      <p className="action-summary">
        {commerceActionDetailSummary(input.action.details)}
      </p>
      <p className="action-authority">
        Authority: {commerceActionAuthorityName(input.action.commerceSystem)}
      </p>
      <CommerceActionTrace
        key={input.action.nonce}
        action={input.action}
        change={renderCommerceActionChange(
          input.action,
          // Only the members who may approve read the preview, and only
          // while it can still change their decision.
          input.canAct && awaitingDecision ? (
            <MerchantPluginPreviewPanel
              key={input.action.nonce}
              read={input.readPluginPreview}
            />
          ) : null,
        )}
        controls={
          <>
            {!input.canAct && (awaitingDecision || executable) ? (
              <p className="notice-text">
                An owner or admin can approve this change.
              </p>
            ) : null}
            {awaitingDecision && input.canAct ? (
              <ActionDecisionControls
                approve={input.approve}
                reject={input.reject}
                disabled={input.disabled}
              />
            ) : null}
            {executable && input.canAct ? (
              <button
                type="button"
                onClick={runAsync.bind(null, input.execute)}
                disabled={input.disabled}
              >
                Apply change
              </button>
            ) : null}
            {reconcilable && input.canAct ? (
              <button
                type="button"
                onClick={runAsync.bind(null, input.execute)}
                disabled={input.disabled}
              >
                Reconcile approved change
              </button>
            ) : null}
          </>
        }
      />
      {renderCommerceReceiptLine(input.action.receipt)}
      {terminal && input.canAct ? (
        <button
          type="button"
          className="secondary-button"
          onClick={runAsync.bind(null, input.execute)}
          disabled={input.disabled}
        >
          Retry Slack notification
        </button>
      ) : null}
    </section>
  );
}

function ActionDecisionControls(props: {
  readonly approve: () => Promise<void>;
  readonly reject: () => Promise<void>;
  readonly disabled: boolean;
}): React.ReactNode {
  return (
    <DecisionButtons
      className="button-row"
      groupLabel="Action decision"
      disabled={props.disabled}
      allow={{
        label: "Approve and apply",
        onSelect: runAsync.bind(null, props.approve),
      }}
      refuse={{
        label: "Reject change",
        className: "secondary-button",
        onSelect: runAsync.bind(null, props.reject),
        confirm: {
          label: "Reject change",
          className: "danger-button",
          keepLabel: "Keep proposal",
          keepClassName: "secondary-button",
          groupLabel: "Confirm action rejection",
          resetAfterMs: 5_000,
        },
      }}
    />
  );
}

function commerceSystemName(system: CommerceSystemKind): string {
  switch (system) {
    case "builtin_commerce":
      return "Seams Checkout";
    case "shopify":
      return "Shopify";
    default:
      return assertNever(system, "Unexpected portal state");
  }
}

function commerceActionAuthorityName(
  authority: CommerceActionRecord["commerceSystem"],
): string {
  switch (authority.kind) {
    case "commerce_system":
      return commerceSystemName(authority.system);
    case "integration_account":
      return "Connected commerce account";
    default:
      return assertNever(authority, "Unexpected portal state");
  }
}

export function commerceActionDetailSummary(details: CommerceActionDetails): string {
  switch (details.kind) {
    case "publish_catalog_listing":
      return "Publish the selected catalog listing to its sales channel.";
    case "update_product_description":
      return "Update the selected product description.";
    case "cancel_order":
      return "Cancel the selected customer order.";
    case "attach_tracking":
      return "Attach the frozen tracking reference to the selected fulfillment.";
    case "patch_commerce_list_entry":
      return "Patch the selected commerce-list entry.";
    case "adjust_offer_price":
      return "Change the price of the selected offer, within its allowance.";
    case "publish_cafe_menu":
      return "Publish this menu to the shop's screens and order page.";
    case "change_menu_price":
      return "Change this item's price on every board, screen and the order page.";
    case "refund_order":
      return "Return this money to the customer's payment.";
    case "stock_operation":
      return "Change this stock or purchasing record.";
    case "install_merchant_plugin":
      return "Install a plugin that checks every checkout of the shop.";
    default:
      return assertNever(details, "Unexpected portal state");
  }
}

function focusCommerceAction(
  heading: React.RefObject<HTMLHeadingElement | null>,
): void {
  heading.current?.focus({ preventScroll: true });
  heading.current
    ?.closest("section")
    ?.scrollIntoView({ block: "start", behavior: "auto" });
}

export function renderCommerceActionChange(
  action: CommerceActionRecord,
  pluginPreview: React.ReactNode,
): React.ReactNode {
  const details = action.details;
  switch (details.kind) {
    case "publish_catalog_listing":
      return (
        <dl className="action-change-facts">
          <div>
            <dt>Product</dt>
            <dd>
              <code>{details.productId}</code> · revision {details.productRevision}
            </dd>
          </div>
          <div>
            <dt>Variant</dt>
            <dd>
              <code>{details.variantId}</code> · revision {details.variantRevision}
            </dd>
          </div>
          <div>
            <dt>Offer</dt>
            <dd>
              <code>{details.offerId}</code> · revision {details.offerRevision}
            </dd>
          </div>
          <div>
            <dt>Sales channel</dt>
            <dd>
              <code>{details.salesChannelId}</code> · revision {details.salesChannelRevision}
            </dd>
          </div>
        </dl>
      );
    case "update_product_description":
      return (
        <dl className="action-change-facts">
          <div>
            <dt>New description</dt>
            <dd>{details.description || "No description"}</dd>
          </div>
        </dl>
      );
    case "cancel_order":
      return (
        <>
          <p className="action-summary">
            <span>Refund amount</span>:{" "}
            <strong>
              <bdi>{formatCommerceActionAmount(action.amount)}</bdi>
            </strong>
          </p>
          <p className="action-guidance">
            {commerceCancellationApprovalGuidance(details.execution)}
          </p>
          <dl className="action-change-facts">
            <div>
              <dt>Refund</dt>
              <dd>{commerceRefundLabel(details.refund)}</dd>
            </div>
            <div>
              <dt>Restock items</dt>
              <dd>{details.restock ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Notify customer</dt>
              <dd>{details.notifyCustomer ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{commerceCancellationReasonLabel(details.reason)}</dd>
            </div>
          </dl>
        </>
      );
    case "attach_tracking":
      return (
        <dl className="action-change-facts">
          <div>
            <dt>Tracking</dt>
            <dd>
              <code>{details.trackingNumber}</code>
            </dd>
          </div>
          <div>
            <dt>Fulfillment</dt>
            <dd>
              <code>{details.fulfillmentId}</code>
            </dd>
          </div>
          <div>
            <dt>Shipment</dt>
            <dd>
              <code>{details.shipmentId}</code>
            </dd>
          </div>
          <div>
            <dt>Batch</dt>
            <dd>
              <code>{details.batchId}</code>
            </dd>
          </div>
        </dl>
      );
    case "patch_commerce_list_entry":
      return (
        <dl className="action-change-facts">
          <div>
            <dt>List</dt>
            <dd>
              <code>{details.listId}</code>
            </dd>
          </div>
          <div>
            <dt>Entry</dt>
            <dd>
              <code>{details.entryId}</code>
            </dd>
          </div>
          <div>
            <dt>Entry revision</dt>
            <dd>{details.expectedRevision}</dd>
          </div>
          <div>
            <dt>List revision</dt>
            <dd>{details.expectedListRevision}</dd>
          </div>
        </dl>
      );
    case "publish_cafe_menu":
      return <CafeMenuPublicationDetails details={details} />;
    case "change_menu_price":
      return <MenuPriceChangeDetails details={details} />;
    case "refund_order":
      return <OrderRefundDetails details={details} />;
    case "stock_operation":
      return <StockOperationCard details={details} />;
    case "install_merchant_plugin":
      // The rule in the merchant's words leads; the code that enforces it
      // follows, because the approval signs that exact code.
      return (
        <>
          <p className="action-summary">
            <strong>
              <bdi>{details.title}</bdi>
            </strong>
            : <bdi>{details.purpose}</bdi>
          </p>
          <dl className="action-change-facts">
            {details.settings.map((setting) => (
              <div key={setting.key}>
                <dt>
                  <bdi>{setting.description}</bdi>
                </dt>
                <dd>
                  <bdi>{merchantPluginSettingText(setting.value)}</bdi>
                </dd>
              </div>
            ))}
          </dl>
          {details.functionSource === null ? null : (
            <pre className="action-plugin-source">
              <code>{details.functionSource}</code>
            </pre>
          )}
          {pluginPreview}
          {details.entityTypes.map((entityType) => (
            <p className="action-summary" key={entityType.typeId}>
              <span>Adds records</span>:{" "}
              <bdi>{entityType.label}</bdi> (
              <bdi>
                {entityType.attributes
                  .map((attribute) => attribute.label)
                  .join(", ")}
              </bdi>
              )
            </p>
          ))}
          {details.fields.map((field) => (
            <p
              className="action-summary"
              key={`${field.entityType}:${field.key}`}
            >
              <span>
                {field.entityType === "customer"
                  ? "Keeps on each customer"
                  : field.entityType === "product"
                    ? "Keeps on each product"
                    : "Keeps on each variant"}
              </span>
              : <bdi>{field.description}</bdi> (<bdi>{field.valueKind}</bdi>)
            </p>
          ))}
          {details.commands.length === 0 ? null : (
            <p className="action-summary">
              <span>May submit</span>:{" "}
              <bdi>{details.commands.join(", ")}</bdi>
            </p>
          )}
          {details.handlers.map((handler) => (
            <div key={handler.handlerId}>
              <p className="action-summary">
                <span>On</span> <bdi>{handler.eventKinds.join(", ")}</bdi>
              </p>
              <pre className="action-plugin-source">
                <code>{handler.source}</code>
              </pre>
            </div>
          ))}
          {details.actions.map((action) => (
            <div key={action.actionId}>
              <p className="action-summary">
                <span>Action</span>: <bdi>{action.title}</bdi> (
                <bdi>{action.inputs.map((input) => input.key).join(", ")}</bdi>
                )
              </p>
              <pre className="action-plugin-source">
                <code>{action.source}</code>
              </pre>
            </div>
          ))}
        </>
      );
    case "adjust_offer_price":
      // The new price is the whole decision here, so it leads.
      return (
        <>
          <p className="action-summary">
            <span>New price</span>:{" "}
            <strong>
              <bdi>
                {formatOfferPrice(details.proposedPriceMinor, details.currency)}
              </bdi>
            </strong>
          </p>
          <dl className="action-change-facts">
            <div>
              <dt>Offer</dt>
              <dd>
                <code>{details.offerId}</code>
              </dd>
            </div>
            <div>
              <dt>Offer revision</dt>
              <dd>{details.expectedOfferRevision}</dd>
            </div>
            <div>
              <dt>Price allowance revision</dt>
              <dd>{details.expectedPolicyRevision}</dd>
            </div>
          </dl>
        </>
      );
    default:
      return assertNever(details, "Unexpected portal state");
  }
}

function commerceCancellationApprovalGuidance(
  execution: Variant<CommerceActionDetails, "cancel_order">["execution"],
): string {
  switch (execution.kind) {
    case "provider_managed":
      return "Merchant approval status is provider-managed; automatic eligibility is not asserted.";
    case "commerce_full_refund":
      return execution.refundGovernance === "approval_required"
        ? "Merchant approval is required before this full refund can run."
        : "This full refund is automatic-eligible under the pinned refund policy. Platform controls may still require merchant approval.";
    default:
      return assertNever(execution, "Unexpected portal state");
  }
}

function commerceCancellationReasonLabel(
  reason: Variant<CommerceActionDetails, "cancel_order">["reason"],
): string {
  switch (reason) {
    case "customer_requested":
      return "Customer requested cancellation";
    case "fraud_suspected":
      return "Suspected fraud";
    case "inventory_unavailable":
      return "Inventory unavailable";
    default:
      return assertNever(reason, "Unexpected portal state");
  }
}

function commerceRefundLabel(
  refund: Variant<CommerceActionDetails, "cancel_order">["refund"],
): string {
  switch (refund) {
    case "none":
      return "No refund";
    case "full":
      return "Full refund";
    default:
      return assertNever(refund, "Unexpected portal state");
  }
}

type PluginPreviewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; preview: MerchantPluginPreview }>
  | Readonly<{ kind: "unavailable" }>;

/**
 * The proposed checkout rule over the shop's recent checkouts, read when the
 * card opens: each refusal message with the number of checkouts it would
 * refuse, and each failure.
 */
function MerchantPluginPreviewPanel(input: {
  readonly read: () => Promise<MerchantPluginPreview>;
}): React.ReactNode {
  const [state, setState] = React.useState<PluginPreviewState>({
    kind: "loading",
  });
  React.useEffect(
    readPluginPreviewOnce.bind(null, input.read, setState),
    [input.read],
  );
  switch (state.kind) {
    case "loading":
      return <p className="notice-text">Checking recent checkouts…</p>;
    case "unavailable":
      return (
        <p className="notice-text">
          The check of recent checkouts is unavailable.
        </p>
      );
    case "ready":
      break;
    default:
      return assertNever(state, "Unexpected portal state");
  }
  const preview = state.preview;
  if (preview.kind === "no_checkout_function") return null;
  if (preview.checkouts === 0)
    return <p className="action-summary">No recent checkouts to check.</p>;
  return (
    <div className="action-plugin-preview">
      <p className="action-summary">
        <span>Recent checkouts</span>: the rule ran on the last{" "}
        {preview.checkouts}.
        {preview.refusals.length === 0 && preview.failures.length === 0
          ? " It refuses none of them."
          : null}
      </p>
      {preview.refusals.length === 0 && preview.failures.length === 0 ? null : (
        <ul>
          {preview.refusals.map((refusal) => (
            <li key={`refusal:${refusal.message}`}>
              Refuses {checkoutCount(refusal.checkouts)}:{" "}
              <bdi>{refusal.message}</bdi>
            </li>
          ))}
          {preview.failures.map((failure) => (
            <li key={`failure:${failure.reason}`}>
              Fails on {checkoutCount(failure.checkouts)}:{" "}
              <bdi>{failure.reason}</bdi>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function readPluginPreviewOnce(
  read: () => Promise<MerchantPluginPreview>,
  setState: (state: PluginPreviewState) => void,
): () => void {
  let open = true;
  read().then(
    (preview) => {
      if (open) setState({ kind: "ready", preview });
    },
    () => {
      if (open) setState({ kind: "unavailable" });
    },
  );
  return () => {
    open = false;
  };
}

function checkoutCount(checkouts: number): string {
  return checkouts === 1 ? "1 checkout" : `${checkouts} checkouts`;
}

function merchantPluginSettingText(
  value: MerchantPluginSettingDetails["value"],
): string {
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
}

/** One line for the provider's receipt: who settled the change, and when. */
function renderCommerceReceiptLine(
  receipt: CommerceProviderReceipt | null,
): React.ReactNode {
  if (receipt === null) return null;
  const provider = commerceSourceLabel(receipt.provider);
  const at = formatCommerceTimestamp(receipt.observedAt);
  switch (receipt.status) {
    case "accepted":
    case "settled":
      return (
        <p className="action-receipt">
          Confirmed by {provider} at {at}.
        </p>
      );
    case "failed":
      return (
        <p className="action-receipt">
          Refused by {provider} at {at}.
        </p>
      );
    case "indeterminate":
      return (
        <p className="action-receipt">
          Sent to {provider} at {at}. The result is not known.
        </p>
      );
    default:
      return assertNever(receipt, "Unexpected portal state");
  }
}
