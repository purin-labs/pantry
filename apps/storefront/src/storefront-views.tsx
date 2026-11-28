import React from "react";
import type {
  CommerceBuyerModifierGroupV1,
  CommerceBuyerQuotedCheckoutV1,
  CommerceBuyerQuotedShippingCheckoutV1,
} from "@purin-labs/commerce-client";
import { assertNever } from "@purin-labs/std";
import type { CafeLanguage } from "./checkout-errors.ts";
import type {
  BuyerTimelineItem,
  CafeFlavorMenuCopy,
  CafeFlavorMenuGroup,
  CafeProductConfiguration,
  Feedback,
} from "./storefront-types.ts";
import {
  QuantityStepper,
  cafeModifierName,
  hasText,
  money,
} from "./storefront-basket.tsx";
import { formatDate, formatDateRange } from "./order-presentation.ts";
import type { PaymentReviewPresentation } from "./order-presentation.ts";
import { orderQrSvg } from "./checkout-recovery.ts";
import type {
  StoredReceiptLineV1,
  StoredReceiptV1,
} from "./checkout-recovery.ts";

export class MobileCheckoutBar extends React.Component<
  Readonly<{
    count: number;
    label: string;
    total: string;
    /** Opens the cart drawer instead of scrolling to the basket. */
    onOpen?: () => void;
  }>,
  Readonly<{ basketVisible: boolean }>
> {
  state = { basketVisible: false };
  #observer: IntersectionObserver | undefined;

  componentDidMount(): void {
    const basket = document.querySelector(".cafe-basket");
    if (basket === null || typeof IntersectionObserver === "undefined") return;
    this.#observer = new IntersectionObserver(this.handleIntersection, {
      threshold: 0.25,
    });
    this.#observer.observe(basket);
  }

  componentWillUnmount(): void {
    this.#observer?.disconnect();
  }

  handleIntersection = (
    entries: readonly IntersectionObserverEntry[],
  ): void => {
    const entry = entries[0];
    if (entry !== undefined)
      this.setState({ basketVisible: entry.isIntersecting });
  };

  render(): React.ReactNode {
    const className = this.state.basketVisible
      ? "mobile-checkout-bar mobile-checkout-bar-hidden"
      : "mobile-checkout-bar";
    const contents = (
      <>
        <span className="mobile-checkout-count" aria-hidden="true">
          {this.props.count}
        </span>
        <strong>{this.props.label}</strong>
        <span className="mobile-checkout-total">{this.props.total}</span>
      </>
    );
    return this.props.onOpen === undefined ? (
      <a className={className} href="#pickup-summary-heading">
        {contents}
      </a>
    ) : (
      <button
        className="mobile-checkout-bar"
        type="button"
        onClick={this.props.onOpen}
      >
        {contents}
      </button>
    );
  }
}

export function CafeFlavorMenu(
  props: Readonly<{ copy: CafeFlavorMenuCopy; showcase: boolean }>,
): React.ReactNode {
  // The menu art carries the Nuki Café name, so only the showcase shows it.
  return (
    <section
      className={
        props.showcase
          ? "cafe-flavor-menu"
          : "cafe-flavor-menu cafe-flavor-menu-plain"
      }
      aria-labelledby="cafe-flavor-menu-heading"
    >
      {props.showcase ? (
        <figure className="cafe-flavor-menu-art">
          <img
            src="/products/nuki-french-taiwanese-menu.webp"
            alt={props.copy.imageAlt}
            width={1024}
            height={1536}
          />
        </figure>
      ) : null}
      <div className="cafe-flavor-menu-copy">
        <p className="eyebrow">{props.copy.eyebrow}</p>
        <h2 id="cafe-flavor-menu-heading">{props.copy.heading}</h2>
        <p>{props.copy.detail}</p>
        <div className="cafe-flavor-grid">
          {props.copy.groups.map(renderCafeFlavorGroup)}
        </div>
        <p className="cafe-packaging-note">{props.copy.packagingDetail}</p>
      </div>
    </section>
  );
}

function renderCafeFlavorGroup(group: CafeFlavorMenuGroup): React.ReactNode {
  return (
    <section
      className={`cafe-flavor-group cafe-flavor-${group.id}`}
      key={group.id}
    >
      <h3>
        <span aria-hidden="true" />
        {group.name}
      </h3>
      <ul>
        <li>
          <a href={`#${group.productIds[0]}`}>{group.items[0]}</a>
        </li>
        <li>
          <a href={`#${group.productIds[1]}`}>{group.items[1]}</a>
        </li>
        <li>
          <a href={`#${group.productIds[2]}`}>{group.items[2]}</a>
        </li>
      </ul>
    </section>
  );
}

export function CafeMenuItem(
  props: Readonly<{
    id: string;
    itemKey: string;
    flavor: CafeProductConfiguration["flavor"];
    imageUrl: string | undefined;
    imageAlt: string;
    category: string;
    title: string;
    description: string;
    allergenLine?: string;
    preparationLabel: string;
    timingLabel: string;
    price: Readonly<{ amountMinor: number; currency: string }>;
    availability: "available" | "unavailable";
    soldOutLabel: string;
    addVisibleLabel: string;
    addLabel: string;
    removeLabel: string;
    selectedLabel: string;
    quantity: number;
    onDecrease: React.MouseEventHandler<HTMLButtonElement>;
    onIncrease: React.MouseEventHandler<HTMLButtonElement>;
    children?: React.ReactNode;
  }>,
): React.ReactNode {
  return (
    <article
      className={`cafe-menu-item cafe-menu-item-${props.availability} cafe-menu-item-${props.flavor}`}
      id={props.id}
    >
      <div className="cafe-menu-item-media">
        {props.imageUrl === undefined ? (
          <div className="cafe-menu-item-mark" aria-hidden="true">
            {props.title.slice(0, 1)}
          </div>
        ) : (
          <img
            src={props.imageUrl}
            alt={props.imageAlt}
            width={1448}
            height={1086}
            loading="lazy"
          />
        )}
        {props.availability === "unavailable" ? (
          <span>{props.soldOutLabel}</span>
        ) : null}
      </div>
      <div className="cafe-menu-item-copy">
        <div>
          <p className="eyebrow">{props.category}</p>
          <h4>{props.title}</h4>
          <p>{props.description}</p>
          {props.preparationLabel.length === 0 ? null : (
            <div className="menu-item-details">
              <span>{props.preparationLabel}</span>
              <span>{props.timingLabel}</span>
            </div>
          )}
          {props.allergenLine === undefined ? null : (
            <p className="menu-item-allergens">{props.allergenLine}</p>
          )}
        </div>
        {props.children}
        <strong className="menu-item-price">{money(props.price)}</strong>
        <QuantityStepper
          itemKey={props.itemKey}
          label={props.title}
          addVisibleLabel={props.addVisibleLabel}
          addLabel={props.addLabel}
          removeLabel={props.removeLabel}
          selectedLabel={props.selectedLabel}
          value={props.quantity}
          minimum={0}
          maximum={props.availability === "available" ? 12 : 0}
          onDecrease={props.onDecrease}
          onIncrease={props.onIncrease}
        />
      </div>
    </article>
  );
}

export function CafeModifierControls(
  props: Readonly<{
    menuEntryId: string;
    groups: readonly CommerceBuyerModifierGroupV1[];
    selectedOptionIds: readonly string[];
    disabled: boolean;
    language: CafeLanguage;
    label: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }>,
): React.ReactNode {
  if (props.groups.length === 0) return null;
  const controls: React.ReactNode[] = [];
  for (const group of props.groups) {
    for (const option of group.options) {
      controls.push(
        <label className="modifier-control" key={option.modifierOptionId}>
          <input
            type="checkbox"
            data-menu-entry-id={props.menuEntryId}
            value={option.modifierOptionId}
            checked={props.selectedOptionIds.includes(option.modifierOptionId)}
            disabled={props.disabled}
            onChange={props.onChange}
          />
          <span>
            <strong>
              {cafeModifierName(
                props.language,
                option.modifierOptionId,
                option.name,
              )}
            </strong>
            <small>+{money(option.priceDelta)}</small>
          </span>
        </label>,
      );
    }
  }
  return (
    <fieldset className="modifier-group">
      <legend>{props.label}</legend>
      {controls}
    </fieldset>
  );
}

export function FormField(
  props: Readonly<{
    id: string;
    label: string;
    type?: "text" | "email" | "tel";
    autoComplete: string;
    placeholder?: string;
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    inputMode?: "numeric";
    pattern?: string;
    hint?: string;
    error?: string;
    required?: boolean;
  }>,
): React.ReactNode {
  const hintId = props.hint === undefined ? undefined : `${props.id}-hint`;
  const errorId = props.error === undefined ? undefined : `${props.id}-error`;
  const describedBy = [hintId, errorId].filter(hasText).join(" ");
  return (
    <label className="field" htmlFor={props.id}>
      <span>{props.label}</span>
      <input
        id={props.id}
        name={props.id}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        pattern={props.pattern}
        placeholder={props.placeholder}
        spellCheck={props.type === "email" ? false : undefined}
        aria-describedby={describedBy.length === 0 ? undefined : describedBy}
        aria-invalid={props.error === undefined ? undefined : "true"}
        value={props.value}
        onChange={props.onChange}
        required={props.required ?? true}
      />
      {props.hint === undefined ? null : (
        <small id={hintId}>{props.hint}</small>
      )}
      {props.error === undefined ? null : (
        <small className="field-error" id={errorId} role="alert">
          {props.error}
        </small>
      )}
    </label>
  );
}

export type QuantityStepperProps = Readonly<{
  itemKey: string;
  label: string;
  addVisibleLabel: string;
  addLabel: string;
  removeLabel: string;
  selectedLabel: string;
  value: number;
  minimum: 0 | 1;
  maximum: 0 | 12;
  onDecrease: React.MouseEventHandler<HTMLButtonElement>;
  onIncrease: React.MouseEventHandler<HTMLButtonElement>;
}>;

export type CheckoutReviewLine = Readonly<{
  key: string;
  label: string;
  detail: string;
  quantity: number;
  total: Readonly<{ amountMinor: number; currency: string }>;
  imageUrl?: string;
}>;

type CheckoutFact = Readonly<{ label: string; value: string }>;

export type CheckoutViewCopy = Readonly<{
  items: string;
  shipping: string;
  duty: string;
  tax: string;
  taxIncluded: string;
  total: string;
  expired: string;
  refresh: string;
  pay: string;
  edit: string;
  paymentNote: string;
}>;

export function CheckoutView(
  props: Readonly<{
    eyebrow: string;
    title: string;
    detail: string;
    facts?: readonly CheckoutFact[];
    evidence?: React.ReactNode;
    reviewLines: readonly CheckoutReviewLine[];
    totals: CommerceBuyerQuotedCheckoutV1["quote"]["totals"];
    expired: boolean;
    expiresAt: string;
    holdLabel: string;
    copy: CheckoutViewCopy;
    feedback: Feedback;
    onEdit: () => void;
    onRefresh: () => void;
    onPay: () => void;
  }>,
): React.ReactNode {
  return (
    <div className="checkout-shell">
      <section className="checkout-card">
        <p className="eyebrow">{props.eyebrow}</p>
        <h1 tabIndex={-1}>{props.title}</h1>
        <p>{props.expired ? props.copy.expired : props.detail}</p>
        <ul className="checkout-review" aria-label={props.copy.items}>
          {props.reviewLines.map(renderCheckoutReviewLine)}
        </ul>
        {props.facts === undefined || props.facts.length === 0 ? null : (
          <dl className="checkout-facts">
            {props.facts.map(renderCheckoutFact)}
          </dl>
        )}
        {props.evidence}
        <dl className="totals">
          <MoneyRow label={props.copy.items} value={props.totals.subtotal} />
          {props.totals.shipping.amountMinor === 0 ? null : (
            <MoneyRow
              label={props.copy.shipping}
              value={props.totals.shipping}
            />
          )}
          {props.totals.duty.amountMinor === 0 ? null : (
            <MoneyRow label={props.copy.duty} value={props.totals.duty} />
          )}
          <MoneyRow
            label={
              taxIsIncluded(props.totals)
                ? props.copy.taxIncluded
                : props.copy.tax
            }
            value={props.totals.tax}
          />
          <MoneyRow label={props.copy.total} value={props.totals.total} total />
        </dl>
        {props.expired ? (
          <button
            className="primary-button"
            type="button"
            onClick={props.onRefresh}
          >
            {props.copy.refresh}
          </button>
        ) : (
          <button
            className="primary-button"
            type="button"
            onClick={props.onPay}
          >
            {props.copy.pay}
          </button>
        )}
        <FeedbackView feedback={props.feedback} />
        {props.expired ? null : (
          <QuoteCountdown expiresAt={props.expiresAt} label={props.holdLabel} />
        )}
        <button className="text-button" type="button" onClick={props.onEdit}>
          {props.copy.edit}
        </button>
        <p className="payment-note">{props.copy.paymentNote}</p>
      </section>
    </div>
  );
}

type ShippingQuoteEvidenceProps = Readonly<{
  quote: CommerceBuyerQuotedShippingCheckoutV1;
}>;

export function ShippingQuoteEvidence(
  props: ShippingQuoteEvidenceProps,
): React.ReactNode {
  const shipping = props.quote.quote.shipping;
  const packageDetails = shipping.packagePlan.package;
  const domestic = shipping.destinationCountry === "JP";
  return (
    <section
      className="shipping-quote-evidence"
      aria-labelledby="shipping-quote-evidence-heading"
    >
      <h2 id="shipping-quote-evidence-heading">Quote evidence</h2>
      <dl className="checkout-facts">
        <div>
          <dt>Address validation reference</dt>
          <dd>{shipping.addressValidationReference}</dd>
        </div>
        <div>
          <dt>Carrier service</dt>
          <dd>
            {shipping.service.name} ({shipping.service.code})
          </dd>
        </div>
        <div>
          <dt>Carrier rate reference</dt>
          <dd>{shipping.carrierQuote.rateReference}</dd>
        </div>
        <div>
          <dt>Carrier amount</dt>
          <dd>{money(shipping.carrierQuote.shippingAmount)}</dd>
        </div>
        <div>
          <dt>Tax quote reference</dt>
          <dd>{shipping.taxQuote.quoteReference}</dd>
        </div>
        <div>
          <dt>Tax amount</dt>
          <dd>{money(shipping.taxQuote.taxAmount)}</dd>
        </div>
        <div>
          <dt>Delivery estimate</dt>
          <dd>
            {formatDateRange(
              shipping.estimatedDelivery.earliest,
              shipping.estimatedDelivery.latest,
              shipping.destinationCountry,
            )}
          </dd>
        </div>
        <div>
          <dt>Quote expires</dt>
          <dd>{formatDate(props.quote.quote.expiresAt, "shipping")}</dd>
        </div>
        {domestic ? (
          <div>
            <dt>Duty</dt>
            <dd>N/A (domestic delivery)</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>Duty quote reference</dt>
              <dd>{shipping.dutyQuote.quoteReference}</dd>
            </div>
            <div>
              <dt>Duty incoterm</dt>
              <dd>{shipping.dutyQuote.incoterm.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Duty amount</dt>
              <dd>{money(shipping.dutyQuote.dutyAmount)}</dd>
            </div>
          </>
        )}
      </dl>
      <h3>Carrier allocations</h3>
      <ul>
        {shipping.carrierQuote.lineAllocations.map(renderShippingAllocation)}
      </ul>
      <h3>Tax allocations</h3>
      <ul>{shipping.taxQuote.lineAllocations.map(renderShippingAllocation)}</ul>
      {domestic ? null : (
        <>
          <h3>Duty allocations</h3>
          <ul>
            {shipping.dutyQuote.lineAllocations.map(renderShippingAllocation)}
          </ul>
        </>
      )}
      <h3>Package</h3>
      <dl className="checkout-facts">
        <div>
          <dt>Package digest</dt>
          <dd>{shipping.packagePlan.packagePlanDigest}</dd>
        </div>
        <div>
          <dt>Package ID</dt>
          <dd>{packageDetails.packageId}</dd>
        </div>
        <div>
          <dt>Package weight</dt>
          <dd>{packageDetails.weight.grams} g</dd>
        </div>
        <div>
          <dt>Package dimensions</dt>
          <dd>
            {packageDetails.dimensions.lengthMillimeters} ×{" "}
            {packageDetails.dimensions.widthMillimeters} ×{" "}
            {packageDetails.dimensions.heightMillimeters} mm
          </dd>
        </div>
      </dl>
      <h3>Line quantities</h3>
      <ul>{packageDetails.lineQuantities.map(renderPackageLineQuantity)}</ul>
      <h3>Customs lines</h3>
      {packageDetails.customsLines.length === 0 ? (
        <p>None required for domestic delivery.</p>
      ) : (
        <ul>{packageDetails.customsLines.map(renderCustomsLine)}</ul>
      )}
    </section>
  );
}

function renderShippingAllocation(
  allocation: CommerceBuyerQuotedShippingCheckoutV1["quote"]["shipping"]["carrierQuote"]["lineAllocations"][number],
): React.ReactNode {
  return (
    <li key={allocation.checkoutLineId}>
      {allocation.checkoutLineId}: {money(allocation.amount)}
    </li>
  );
}

function renderPackageLineQuantity(
  line: CommerceBuyerQuotedShippingCheckoutV1["quote"]["shipping"]["packagePlan"]["package"]["lineQuantities"][number],
): React.ReactNode {
  return (
    <li key={line.checkoutLineId}>
      {line.checkoutLineId}: {packageQuantityLabel(line.quantity)}
    </li>
  );
}

function renderCustomsLine(
  line: CommerceBuyerQuotedShippingCheckoutV1["quote"]["shipping"]["packagePlan"]["package"]["customsLines"][number],
): React.ReactNode {
  return (
    <li key={line.checkoutLineId}>
      {line.checkoutLineId}: {line.description};{" "}
      {packageQuantityLabel(line.quantity)}; {line.weight.grams} g;{" "}
      {line.countryOfOrigin}; HS {line.hsCode}; {money(line.declaredValue)}
    </li>
  );
}

function packageQuantityLabel(
  quantity: Readonly<{ amount: number; scale: number; unit: string }>,
): string {
  return `${quantity.amount / 10 ** quantity.scale} ${quantity.unit}`;
}

class QuoteCountdown extends React.Component<
  Readonly<{ expiresAt: string; label: string }>,
  Readonly<{ now: number }>
> {
  state = { now: Date.now() };
  #timer: number | undefined;

  componentDidMount(): void {
    this.#timer = window.setInterval(this.tick, 1_000);
  }

  componentWillUnmount(): void {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
  }

  tick = (): void => {
    this.setState({ now: Date.now() });
  };

  render(): React.ReactNode {
    const remaining = Math.max(
      0,
      Date.parse(this.props.expiresAt) - this.state.now,
    );
    if (remaining === 0) return null;
    const totalSeconds = Math.round(remaining / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return (
      <p className="quote-countdown" aria-hidden="true">
        <span className="quote-countdown-dot" />
        {this.props.label} · {minutes}:{seconds}
      </p>
    );
  }
}

/**
 * A shop whose listed prices include tax (as Japan requires) charges the
 * items, shipping and duty only; its tax is a part of them, not added.
 */
function taxIsIncluded(totals: Readonly<{ taxIncluded?: true }>): boolean {
  return totals.taxIncluded === true;
}

function MoneyRow(
  props: Readonly<{
    label: string;
    value: Readonly<{ amountMinor: number; currency: string }>;
    total?: boolean;
    subtract?: boolean;
  }>,
): React.ReactNode {
  const value =
    props.subtract === true ? `−${money(props.value)}` : money(props.value);
  return (
    <div className={props.total === true ? "total-row" : undefined}>
      <dt>{props.label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function renderCheckoutFact(fact: CheckoutFact): React.ReactNode {
  return (
    <div key={fact.label}>
      <dt>{fact.label}</dt>
      <dd>{fact.value}</dd>
    </div>
  );
}

function renderCheckoutReviewLine(line: CheckoutReviewLine): React.ReactNode {
  return (
    <li key={line.key}>
      {line.imageUrl === undefined ? null : (
        <img src={line.imageUrl} alt="" width={1448} height={1086} />
      )}
      <div>
        <strong>{line.label}</strong>
        <small>{line.detail}</small>
      </div>
      <span>×{line.quantity}</span>
      <strong>{money(line.total)}</strong>
    </li>
  );
}

export type OrderViewCopy = Readonly<{
  paid: string;
  nextAction: string;
  lastUpdated: string;
  progress: string;
  returnUrl: string;
  returnUrlDetail: string;
  copyLink: string;
  refresh: string;
}>;

export type OrderStatusPresentation = Readonly<{
  title: string;
  detail: string;
  nextAction: string;
  timeline: readonly BuyerTimelineItem[];
  complete: boolean;
  lastUpdated?: string;
}>;

type OrderHandoff =
  | Readonly<{ kind: "standard" }>
  | Readonly<{
      kind: "pickup_kiosk";
      heading: string;
      detail: string;
      clearLabel: string;
      confirmHeading: string;
      confirmDetail: string;
      confirmClear: string;
      confirmKeep: string;
      onClear: () => void;
    }>;

export function OrderView(
  props: Readonly<{
    eyebrow: string;
    title: string;
    detail: string;
    orderCode?: Readonly<{ label: string; value: string }>;
    total: Readonly<{ amountMinor: number; currency: string }>;
    complete: boolean;
    lastUpdated: string;
    nextAction: string;
    timeline: readonly BuyerTimelineItem[];
    paymentReview?: PaymentReviewPresentation;
    facts?: readonly CheckoutFact[];
    receipt?: StoredReceiptV1;
    receiptHeading: string;
    returnUrl: string;
    qrDetail: string;
    feedback: Feedback;
    onRefresh: () => void;
    onCopyLink: () => void;
    copy: OrderViewCopy;
    handoff: OrderHandoff;
  }>,
): React.ReactNode {
  return (
    <div className="checkout-shell">
      <section className="order-card">
        <div
          className={props.complete ? "status-orb complete" : "status-orb"}
          aria-hidden="true"
        >
          <span>{props.complete ? "✓" : "…"}</span>
        </div>
        <p className="eyebrow">{props.eyebrow}</p>
        <h1 tabIndex={-1}>{props.title}</h1>
        <p>{props.detail}</p>
        <section
          aria-atomic="true"
          aria-labelledby={
            props.paymentReview === undefined
              ? undefined
              : "payment-review-status-heading"
          }
          aria-live="polite"
          className="payment-review-status"
          role="status"
        >
          {props.paymentReview === undefined ? null : (
            <>
              <h2 id="payment-review-status-heading">
                {props.paymentReview.title}
              </h2>
              <p>{props.paymentReview.detail}</p>
              <p>{props.paymentReview.nextAction}</p>
            </>
          )}
        </section>
        {props.orderCode === undefined ? null : (
          <div className="order-code">
            <span>{props.orderCode.label}</span>
            <strong>{props.orderCode.value}</strong>
          </div>
        )}
        <p className="order-total">
          {props.copy.paid} {money(props.total)}
        </p>
        <div className="next-action">
          <span>{props.copy.nextAction}</span>
          <strong>{props.nextAction}</strong>
          <small>
            {props.copy.lastUpdated} {props.lastUpdated}
          </small>
        </div>
        <ol className="order-timeline" aria-label={props.copy.progress}>
          {props.timeline.map(renderBuyerTimelineItem)}
        </ol>
        {props.facts === undefined || props.facts.length === 0 ? null : (
          <dl className="checkout-facts order-facts">
            {props.facts.map(renderCheckoutFact)}
          </dl>
        )}
        {props.receipt === undefined ||
        props.receipt.lines.length === 0 ? null : (
          <section className="order-receipt" aria-label={props.receiptHeading}>
            <h2>{props.receiptHeading}</h2>
            <ul className="checkout-review">
              {props.receipt.lines.map(renderReceiptLine)}
            </ul>
          </section>
        )}
        <div className="return-link">
          <span className="return-link-label" id="return-order-url-label">
            {props.copy.returnUrl}
          </span>
          <div className="order-link-share">
            <div
              className="order-qr"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: orderQrSvg(props.returnUrl) }}
            />
            <div className="order-link-copy">
              <p>{props.qrDetail}</p>
              <input
                aria-labelledby="return-order-url-label"
                id="return-order-url"
                readOnly
                value={props.returnUrl}
                onFocus={selectReturnUrl}
              />
              <button
                className="secondary-button order-copy-button"
                type="button"
                onClick={props.onCopyLink}
              >
                {props.copy.copyLink}
              </button>
            </div>
          </div>
          <p>{props.copy.returnUrlDetail}</p>
        </div>
        <KioskHandoffView handoff={props.handoff} />
        {props.complete ? null : (
          <button
            className="secondary-button"
            type="button"
            onClick={props.onRefresh}
          >
            {props.copy.refresh}
          </button>
        )}
        <FeedbackView feedback={props.feedback} />
      </section>
    </div>
  );
}

function renderReceiptLine(
  line: StoredReceiptLineV1,
  index: number,
): React.ReactNode {
  return renderCheckoutReviewLine({
    key: `receipt_${index}`,
    label: line.label,
    detail: line.detail ?? "",
    quantity: line.quantity,
    total: { amountMinor: line.totalMinor, currency: line.currency },
    imageUrl: line.imageUrl,
  });
}

function selectReturnUrl(event: React.FocusEvent<HTMLInputElement>): void {
  event.currentTarget.select();
}

class KioskHandoffView extends React.Component<
  Readonly<{ handoff: OrderHandoff }>,
  Readonly<{ confirming: boolean }>
> {
  state = { confirming: false };

  requestClear = (): void => {
    this.setState({ confirming: true });
  };

  keepOrder = (): void => {
    this.setState({ confirming: false });
  };

  confirmClear = (): void => {
    const handoff = this.props.handoff;
    if (handoff.kind !== "pickup_kiosk") return;
    this.setState({ confirming: false });
    handoff.onClear();
  };

  render(): React.ReactNode {
    const handoff = this.props.handoff;
    switch (handoff.kind) {
      case "standard":
        return null;
      case "pickup_kiosk":
        if (this.state.confirming) {
          return (
            <section className="kiosk-handoff kiosk-handoff-confirming">
              <div>
                <h2>{handoff.confirmHeading}</h2>
                <p>{handoff.confirmDetail}</p>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={this.confirmClear}
              >
                {handoff.confirmClear}
              </button>
              <button
                className="text-button"
                type="button"
                onClick={this.keepOrder}
              >
                {handoff.confirmKeep}
              </button>
            </section>
          );
        }
        return (
          <section className="kiosk-handoff">
            <div>
              <h2>{handoff.heading}</h2>
              <p>{handoff.detail}</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={this.requestClear}
            >
              {handoff.clearLabel}
            </button>
          </section>
        );
      default:
        return assertNever(handoff, "Unhandled storefront state");
    }
  }
}

export function StatusView(
  props: Readonly<{
    title: string;
    detail: string;
    busy?: boolean;
    actionLabel?: string;
    onAction?: () => void;
  }>,
): React.ReactNode {
  return (
    <div className="checkout-shell">
      <section className="status-card" aria-busy={props.busy === true}>
        {props.busy === true ? (
          <div className="progress-line" aria-hidden="true" />
        ) : null}
        <h1 tabIndex={-1}>{props.title}</h1>
        <p>{props.detail}</p>
        {props.actionLabel === undefined ||
        props.onAction === undefined ? null : (
          <button
            className="primary-button"
            type="button"
            onClick={props.onAction}
          >
            {props.actionLabel}
          </button>
        )}
      </section>
    </div>
  );
}

export function EmptyCatalog(
  props: Readonly<{
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  }>,
): React.ReactNode {
  return (
    <section className="empty-card">
      <h2>Today’s selection is unavailable</h2>
      <p>{props.message} Try again when the café has replenished stock.</p>
      {props.actionLabel === undefined ||
      props.onAction === undefined ? null : (
        <button
          className="secondary-button"
          type="button"
          onClick={props.onAction}
        >
          {props.actionLabel}
        </button>
      )}
    </section>
  );
}

export function FeedbackView(
  props: Readonly<{ feedback: Feedback }>,
): React.ReactNode {
  switch (props.feedback.kind) {
    case "none":
      return null;
    case "error":
      return (
        <p className="error-message" role="alert">
          {props.feedback.message}
        </p>
      );
    case "notice":
      return (
        <p className="notice-message" role="status">
          {props.feedback.message}
        </p>
      );
    default:
      return assertNever(props.feedback, "Unhandled storefront state");
  }
}

function renderBuyerTimelineItem(item: BuyerTimelineItem): React.ReactNode {
  return (
    <li
      className={`timeline-${item.state}`}
      key={item.label}
      aria-current={item.state === "current" ? "step" : undefined}
    >
      <span aria-hidden="true">{item.state === "complete" ? "✓" : ""}</span>
      <strong>{item.label}</strong>
    </li>
  );
}
