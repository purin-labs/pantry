import type {
  CommerceClientError,
  CommerceBuyerOrderV1,
  CommerceBuyerPaymentDisputeStatusV1,
  CommerceBuyerSessionV4,
} from "@purin-labs/commerce-client";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type { CafeLanguage } from "./checkout-errors.ts";
import type {
  BuyerContactPolicy,
  BuyerFulfillment,
  BuyerTimelineItem,
  CafeInterfaceCopy,
  ShippingCountryCode,
  StorefrontConfiguration,
  StorefrontFailure,
  StorefrontState,
} from "./storefront-types.ts";
import { locationHasOrderAccessIntent } from "./checkout-recovery.ts";
import { cafeInterfaceCopy, money } from "./storefront-basket.tsx";
import type { OrderStatusPresentation } from "./storefront-views.tsx";

export function configurationFulfillment(
  config: StorefrontConfiguration,
): BuyerFulfillment {
  switch (config.kind) {
    case "cafe":
      return "pickup";
    case "shipping":
      return "shipping";
  }
}

export function profileAllowsFulfillment(
  session: CommerceBuyerSessionV4,
  fulfillment: BuyerFulfillment,
): boolean {
  switch (session.checkoutProfileConfiguration.fulfillmentPolicy.kind) {
    case "pickup_only":
      return fulfillment === "pickup";
    case "shipping_only":
      return fulfillment === "shipping";
    case "buyer_choice":
      return true;
    default:
      return assertNever(
        session.checkoutProfileConfiguration.fulfillmentPolicy,
        "Unhandled storefront state",
      );
  }
}

export function buyerContactPolicy(
  session: CommerceBuyerSessionV4,
): BuyerContactPolicy {
  return session.checkoutProfileConfiguration.buyerPolicy.requiredContact;
}

export function languageFromLocale(locale: string): CafeLanguage {
  return locale.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function buyerContactPolicyCopy(
  policy: BuyerContactPolicy,
  language: CafeLanguage,
): string {
  if (language === "ja") {
    switch (policy) {
      case "email_required":
        return "メールアドレスは必須です。電話番号は収集しません。";
      case "email_required_phone_optional":
        return "メールアドレスは必須です。電話番号は任意です。";
      case "email_and_phone_required":
        return "メールアドレスと電話番号は必須です。";
      default:
        return assertNever(policy, "Unhandled storefront state");
    }
  }
  switch (policy) {
    case "email_required":
      return "Email is required. Phone is not collected.";
    case "email_required_phone_optional":
      return "Email is required. Phone is optional.";
    case "email_and_phone_required":
      return "Email and phone are required.";
    default:
      return assertNever(policy, "Unhandled storefront state");
  }
}

export function buyerPhoneIsVisible(policy: BuyerContactPolicy): boolean {
  return policy !== "email_required";
}

export function buyerPhoneIsRequired(policy: BuyerContactPolicy): boolean {
  return policy === "email_and_phone_required";
}

type FailureViewCopy = Readonly<{ title: string; action: string }>;

export function failureViewCopy(
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage,
  failure: StorefrontFailure["kind"],
): FailureViewCopy {
  if (kind === "cafe" && language === "ja") {
    return failure === "order_access"
      ? { title: "注文状況を開けませんでした", action: "メニューに戻る" }
      : { title: "ストアを開けませんでした", action: "もう一度試す" };
  }
  return failure === "order_access"
    ? {
        title: "This order status link isn’t available",
        action: "Return to the store",
      }
    : { title: "The storefront didn’t open", action: "Try again" };
}

export function invalidOrderAccessMessage(
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage,
  belongsToAnotherStorefront: boolean,
): string {
  if (kind === "cafe" && language === "ja") {
    return belongsToAnotherStorefront
      ? "この注文は別のストアのものです。"
      : "注文リンクが無効か、有効期限が切れています。";
  }
  return belongsToAnotherStorefront
    ? "This order belongs to another storefront."
    : "This order link is invalid or has expired.";
}

export function isTerminalOrderAccessError(error: CommerceClientError): boolean {
  switch (error.kind) {
    case "http":
      return error.status >= 400 && error.status < 500;
    case "rejected":
      return true;
    case "network":
    case "invalid_response":
      return false;
    default:
      return assertNever(error, "Unhandled storefront state");
  }
}

export function statePresentsPageHeading(state: StorefrontState): boolean {
  switch (state.kind) {
    case "booting":
    case "quoting":
    case "paying_pickup":
    case "paying_shipping":
      return false;
    case "catalog":
    case "shipping_address_correction":
    case "pickup_quote":
    case "shipping_quote":
    case "payment_pickup":
    case "payment_shipping":
    case "declined":
    case "indeterminate_pickup":
    case "indeterminate_shipping":
    case "pickup_order":
    case "shipping_order":
    case "failed":
      return true;
    default:
      return assertNever(state, "Unhandled storefront state");
  }
}

export function focusPageHeading(): void {
  window.requestAnimationFrame(focusRenderedHeading);
}

export function scrollToLocationAnchor(): void {
  if (
    window.location.hash.length <= 1 ||
    locationHasOrderAccessIntent(window.location)
  )
    return;
  window.requestAnimationFrame(scrollToRenderedAnchor);
}

function scrollToRenderedAnchor(): void {
  try {
    const id = decodeURIComponent(window.location.hash.slice(1));
    document.getElementById(id)?.scrollIntoView();
  } catch {
    // Ignore malformed non-order fragments and keep the storefront usable.
  }
}

function focusRenderedHeading(): void {
  window.scrollTo(0, 0);
  document
    .querySelector<HTMLElement>("main h1")
    ?.focus({ preventScroll: true });
}

function dateTimeLocale(
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage,
): string {
  if (kind === "shipping") return "en-SG";
  return language === "ja" ? "ja-JP" : "en-JP";
}

function storefrontTimeZone(kind: StorefrontConfiguration["kind"]): string {
  return kind === "cafe" ? "Asia/Tokyo" : "Asia/Singapore";
}

export function formatDate(
  value: string,
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage = "en",
): string {
  return new Intl.DateTimeFormat(dateTimeLocale(kind, language), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: storefrontTimeZone(kind),
  }).format(new Date(value));
}

function formatTimeOnly(
  value: string,
  kind: StorefrontConfiguration["kind"],
  language: CafeLanguage,
): string {
  return new Intl.DateTimeFormat(dateTimeLocale(kind, language), {
    timeStyle: "short",
    timeZone: storefrontTimeZone(kind),
  }).format(new Date(value));
}

export function formatDateRange(
  earliest: string,
  latest: string,
  countryCode: ShippingCountryCode,
): string {
  return new Intl.DateTimeFormat(`en-${countryCode}`, {
    dateStyle: "medium",
    timeZone: destinationTimeZone(countryCode),
  }).formatRange(new Date(earliest), new Date(latest));
}

/** A time zone of the destination, for delivery dates. */
function destinationTimeZone(countryCode: ShippingCountryCode): string {
  switch (countryCode) {
    case "JP":
      return "Asia/Tokyo";
    case "SG":
      return "Asia/Singapore";
    case "AU":
      return "Australia/Sydney";
    case "US":
      return "America/New_York";
    case "IE":
    case "PT":
      return "Europe/Lisbon";
    case "BG":
    case "CY":
    case "EE":
    case "FI":
    case "GR":
    case "LT":
    case "LV":
    case "RO":
      return "Europe/Helsinki";
    default:
      return "Europe/Paris";
  }
}

function calendarDayInTokyo(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(value);
}

export function formatPickupMoment(value: string, language: CafeLanguage): string {
  const moment = new Date(value);
  if (calendarDayInTokyo(moment) === calendarDayInTokyo(new Date())) {
    return cafeInterfaceCopy(language).todayAt.replace(
      "{time}",
      formatTimeOnly(value, "cafe", language),
    );
  }
  return formatDate(value, "cafe", language);
}

export function cafeOrderTitle(
  state: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">["state"],
  copy: CafeInterfaceCopy,
): string {
  switch (state) {
    case "placed":
      return copy.preparingOrder;
    case "ready_for_pickup":
      return copy.readyForPickup;
    case "completed":
      return copy.pickedUp;
    case "cancelled":
      return copy.orderCancelled;
  }
}

export function pickupOrderDetail(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
  language: CafeLanguage,
): string {
  switch (order.state) {
    case "placed":
      return language === "ja"
        ? `${formatPickupMoment(order.pickup.expectedBy, language)}までにご用意します。`
        : `Expected ${formatPickupMoment(order.pickup.expectedBy, language)}.`;
    case "ready_for_pickup":
      return language === "ja"
        ? `${formatPickupMoment(order.readyAt, language)}にご用意できました。この画面をカウンターでお見せください。`
        : `Ready since ${formatPickupMoment(order.readyAt, language)}. Show this page at the counter.`;
    case "completed":
      return language === "ja"
        ? `${formatPickupMoment(order.completedAt, language)}にお受け取りいただきました。ありがとうございます。`
        : `Collected ${formatPickupMoment(order.completedAt, language)}. Thank you.`;
    case "cancelled":
      return cancelledPickupOrderDetail(order, language);
  }
}

function cancelledPickupOrderDetail(
  order: VariantBy<
    VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
    "state",
    "cancelled"
  >,
  language: CafeLanguage,
): string {
  const cancelledAt = formatPickupMoment(order.cancelledAt, language);
  switch (order.refund.state) {
    case "pending":
      return language === "ja"
        ? `${cancelledAt}にキャンセルしました。返金を処理しています。`
        : `Cancelled ${cancelledAt}. The refund is processing.`;
    case "refunded":
      return language === "ja"
        ? `${cancelledAt}にキャンセルしました。${money(order.refund.amount)}を返金しました。`
        : `Cancelled ${cancelledAt}. ${money(order.refund.amount)} was refunded.`;
    case "failed":
      return language === "ja"
        ? `${cancelledAt}にキャンセルしました。カフェが返金状況を確認しています。`
        : `Cancelled ${cancelledAt}. The café is reviewing the refund.`;
    default:
      return assertNever(order.refund, "Unhandled storefront state");
  }
}

export function shippingOrderTitle(
  state: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">["state"],
  destinationName: string,
): string {
  switch (state) {
    case "ready":
      return "Preparing the shipment";
    case "label_purchased":
      return "Waiting for carrier pickup";
    case "in_transit":
      return `On the way to ${destinationName}`;
    case "delivered":
      return "Delivered";
  }
}

export function shippingOrderDetail(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">,
): string {
  switch (order.state) {
    case "ready":
      return "The cookie box is packed. Carrier booking is next.";
    case "label_purchased":
      return "The shipping label is ready. The carrier collects the package next.";
    case "in_transit":
      return `Handed to the carrier ${formatDate(order.handedOverAt, "shipping")}.`;
    case "delivered":
      return `Delivered ${formatDate(order.deliveredAt, "shipping")}.`;
  }
}

export function buyerOrderLastUpdated(
  order: CommerceBuyerOrderV1,
  language: CafeLanguage,
): string {
  switch (order.fulfillment) {
    case "pickup":
      switch (order.state) {
        case "placed":
          return formatPickupMoment(order.placedAt, language);
        case "ready_for_pickup":
          return formatPickupMoment(order.readyAt, language);
        case "completed":
          return formatPickupMoment(order.completedAt, language);
        case "cancelled":
          return formatPickupMoment(order.cancelledAt, language);
      }
    case "shipping":
      switch (order.state) {
        case "ready":
          return formatDate(order.placedAt, "shipping");
        case "label_purchased":
          return formatDate(order.purchasedAt, "shipping");
        case "in_transit":
          return formatDate(order.handedOverAt, "shipping");
        case "delivered":
          return formatDate(order.deliveredAt, "shipping");
      }
  }
}

export function shippingOrderNextAction(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">,
): string {
  switch (order.state) {
    case "ready":
      return "Wait for the merchant to book the carrier.";
    case "label_purchased":
      return "Wait for the carrier to collect the package.";
    case "in_transit":
      return "Follow the tracking number for delivery updates.";
    case "delivered":
      return "No action needed. Delivery is complete.";
  }
}

export function pickupOrderNextAction(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
  language: CafeLanguage,
): string {
  switch (order.state) {
    case "placed":
      return language === "ja"
        ? "カフェでご注文をお作りしています。そのままお待ちください。"
        : "Wait while the café makes your order.";
    case "ready_for_pickup":
      return language === "ja"
        ? "この画面をカフェのカウンターでお見せください。"
        : "Show this page at the café counter.";
    case "completed":
      return language === "ja"
        ? "お受け取りは完了しました。"
        : "Your pickup is complete.";
    case "cancelled":
      return cancelledPickupOrderNextAction(order, language);
  }
}

function cancelledPickupOrderNextAction(
  order: VariantBy<
    VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
    "state",
    "cancelled"
  >,
  language: CafeLanguage,
): string {
  switch (order.refund.state) {
    case "pending":
      return language === "ja"
        ? "返金が完了するまでお待ちください。"
        : "Wait for the refund to complete.";
    case "refunded":
      return language === "ja"
        ? "返金は完了しました。"
        : "The refund is complete. No action is needed.";
    case "failed":
      return language === "ja"
        ? "カフェからの返金に関するご連絡をお待ちください。"
        : "Wait for the café to contact you about the refund.";
    default:
      return assertNever(order.refund, "Unhandled storefront state");
  }
}

export function pickupOrderTimeline(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "pickup">,
  language: CafeLanguage,
): readonly BuyerTimelineItem[] {
  if (order.state === "cancelled") {
    return timelineItems(
      language === "ja"
        ? ["注文を受け付けました", "キャンセル済み"]
        : ["Order placed", "Cancelled"],
      1,
    );
  }
  const currentIndex =
    order.state === "placed" ? 0 : order.state === "ready_for_pickup" ? 1 : 2;
  const labels =
    language === "ja"
      ? ["注文を受け付けました", "受け取り準備完了", "お受け取り済み"]
      : ["Order placed", "Ready for pickup", "Collected"];
  return timelineItems(labels, currentIndex);
}

export type PaymentReviewPresentation = Readonly<{
  title: string;
  detail: string;
  nextAction: string;
  timeline: readonly BuyerTimelineItem[];
  active: boolean;
}>;

type PaymentReviewCopy = Readonly<{
  activeTitle: string;
  activeTitlePlural: string;
  completeTitle: string;
  completeTitlePlural: string;
  activeDetail: string;
  completeDetail: string;
  multipleActiveDetail: string;
  multipleMixedDetail: string;
  multipleCompleteDetail: string;
  activeNextAction: string;
  activeNextActionPlural: string;
  completeNextAction: string;
  completeNextActionPlural: string;
  activeTimeline: string;
  completeTimeline: string;
}>;

const PAYMENT_REVIEW_COPY: Readonly<Record<CafeLanguage, PaymentReviewCopy>> = {
  en: {
    activeTitle: "Payment review in progress",
    activeTitlePlural: "Payment reviews in progress",
    completeTitle: "Payment review complete",
    completeTitlePlural: "Payment reviews complete",
    activeDetail: "Your payment review is in progress.",
    completeDetail: "The payment review is complete.",
    multipleActiveDetail: "{total} payment reviews are in progress.",
    multipleMixedDetail:
      "{total} payment reviews: {active} in progress, {complete} complete.",
    multipleCompleteDetail: "{total} payment reviews are complete.",
    activeNextAction:
      "Keep checking this page while the payment review is in progress.",
    activeNextActionPlural:
      "Keep checking this page while payment reviews are in progress.",
    completeNextAction: "The payment review is complete. No action is needed.",
    completeNextActionPlural:
      "The payment reviews are complete. No action is needed.",
    activeTimeline: "Payment review in progress",
    completeTimeline: "Payment review complete",
  },
  ja: {
    activeTitle: "お支払いを確認しています",
    activeTitlePlural: "お支払いを確認しています",
    completeTitle: "お支払いの確認が完了しました",
    completeTitlePlural: "お支払いの確認が完了しました",
    activeDetail: "お支払いの確認を進めています。",
    completeDetail: "お支払いの確認が完了しました。",
    multipleActiveDetail: "お支払いの確認中のものが{total}件あります。",
    multipleMixedDetail:
      "お支払いの確認は{total}件です。確認中{active}件、完了{complete}件。",
    multipleCompleteDetail: "お支払いの確認は{total}件すべて完了しました。",
    activeNextAction:
      "お支払いの確認が完了するまで、この画面をご確認ください。",
    activeNextActionPlural:
      "お支払いの確認が完了するまで、この画面をご確認ください。",
    completeNextAction:
      "お支払いの確認は完了しています。お手続きはありません。",
    completeNextActionPlural:
      "お支払いの確認は完了しています。お手続きはありません。",
    activeTimeline: "お支払いを確認中",
    completeTimeline: "お支払いの確認完了",
  },
};

type PaymentReviewCounts = Readonly<{
  total: number;
  active: number;
  complete: number;
}>;

export function paymentReviewPresentation(
  disputes: readonly CommerceBuyerPaymentDisputeStatusV1[],
  language: CafeLanguage,
): PaymentReviewPresentation | undefined {
  if (disputes.length === 0) return undefined;
  const counts = paymentReviewCounts(disputes);
  const copy = PAYMENT_REVIEW_COPY[language];
  const plural = counts.total > 1;
  const active = counts.active > 0;
  return {
    title: paymentReviewTitle(counts, copy, plural),
    detail: paymentReviewDetail(counts, copy),
    nextAction: paymentReviewNextAction(counts, copy, plural),
    timeline: timelineItems([paymentReviewTimelineLabel(counts, copy)], 0),
    active,
  };
}

function paymentReviewCounts(
  disputes: readonly CommerceBuyerPaymentDisputeStatusV1[],
): PaymentReviewCounts {
  let active = 0;
  let complete = 0;
  for (const dispute of disputes) {
    switch (dispute.state) {
      case "action_required":
      case "under_review":
        active += 1;
        break;
      case "won":
      case "lost":
        complete += 1;
        break;
      default:
        assertNever(dispute, "Unhandled storefront state");
    }
  }
  return { total: disputes.length, active, complete };
}

function paymentReviewTitle(
  counts: PaymentReviewCounts,
  copy: PaymentReviewCopy,
  plural: boolean,
): string {
  if (counts.active > 0)
    return plural ? copy.activeTitlePlural : copy.activeTitle;
  return plural ? copy.completeTitlePlural : copy.completeTitle;
}

function paymentReviewDetail(
  counts: PaymentReviewCounts,
  copy: PaymentReviewCopy,
): string {
  if (counts.total === 1) {
    if (counts.active > 0) return copy.activeDetail;
    return copy.completeDetail;
  }
  if (counts.active === counts.total) {
    return copy.multipleActiveDetail.replace("{total}", String(counts.total));
  }
  if (counts.complete === counts.total) {
    return copy.multipleCompleteDetail.replace("{total}", String(counts.total));
  }
  return copy.multipleMixedDetail
    .replace("{total}", String(counts.total))
    .replace("{active}", String(counts.active))
    .replace("{complete}", String(counts.complete));
}

function paymentReviewNextAction(
  counts: PaymentReviewCounts,
  copy: PaymentReviewCopy,
  plural: boolean,
): string {
  if (counts.active > 0) {
    return plural ? copy.activeNextActionPlural : copy.activeNextAction;
  }
  return plural ? copy.completeNextActionPlural : copy.completeNextAction;
}

function paymentReviewTimelineLabel(
  counts: PaymentReviewCounts,
  copy: PaymentReviewCopy,
): string {
  if (counts.active > 0) return copy.activeTimeline;
  return copy.completeTimeline;
}

export function orderTimelineWithPaymentReview(
  base: OrderStatusPresentation,
  paymentReview: PaymentReviewPresentation | undefined,
  language: CafeLanguage,
): readonly BuyerTimelineItem[] {
  if (paymentReview === undefined) return base.timeline;
  const reviewItem = currentTimelineItem(paymentReview.timeline);
  if (reviewItem === undefined) return base.timeline;
  if (!base.complete) {
    if (!paymentReview.active) return base.timeline;
    return (
      combineActivePaymentReviewTimeline(base.timeline, reviewItem, language) ??
      base.timeline
    );
  }
  const timeline = completeTimelineItems(base.timeline);
  timeline.push({
    label: reviewItem.label,
    state: "current",
  });
  return timeline;
}

function currentTimelineItem(
  timeline: readonly BuyerTimelineItem[],
): BuyerTimelineItem | undefined {
  for (const item of timeline) if (item.state === "current") return item;
  return undefined;
}

function combineActivePaymentReviewTimeline(
  timeline: readonly BuyerTimelineItem[],
  reviewItem: BuyerTimelineItem,
  language: CafeLanguage,
): readonly BuyerTimelineItem[] | undefined {
  const combined: BuyerTimelineItem[] = [];
  let foundCurrent = false;
  for (const item of timeline) {
    if (item.state !== "current") {
      combined.push(item);
      continue;
    }
    combined.push({
      ...item,
      label:
        language === "ja"
          ? `${item.label}・${reviewItem.label}`
          : `${item.label} · ${reviewItem.label}`,
    });
    foundCurrent = true;
  }
  return foundCurrent ? combined : undefined;
}

function completeTimelineItems(
  timeline: readonly BuyerTimelineItem[],
): BuyerTimelineItem[] {
  const completed: BuyerTimelineItem[] = [];
  for (const item of timeline) completed.push({ ...item, state: "complete" });
  return completed;
}

export function shippingOrderTimeline(
  order: VariantBy<CommerceBuyerOrderV1, "fulfillment", "shipping">,
): readonly BuyerTimelineItem[] {
  const currentIndex =
    order.state === "ready"
      ? 0
      : order.state === "label_purchased"
        ? 1
        : order.state === "in_transit"
          ? 2
          : 3;
  return timelineItems(
    ["Order placed", "Shipping label ready", "In transit", "Delivered"],
    currentIndex,
  );
}

function timelineItems(
  labels: readonly string[],
  currentIndex: number,
): readonly BuyerTimelineItem[] {
  const items: BuyerTimelineItem[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    if (label === undefined) continue;
    items.push({
      label,
      state:
        index < currentIndex
          ? "complete"
          : index === currentIndex
            ? "current"
            : "upcoming",
    });
  }
  return items;
}

export function orderNeedsPolling(order: CommerceBuyerOrderV1): boolean {
  if (paymentReviewIsActive(order.paymentDisputes)) return true;
  switch (order.fulfillment) {
    case "pickup":
      return order.state !== "completed";
    case "shipping":
      return order.state !== "delivered";
    default:
      return assertNever(order, "Unhandled storefront state");
  }
}

function paymentReviewIsActive(
  disputes: readonly CommerceBuyerPaymentDisputeStatusV1[],
): boolean {
  for (const dispute of disputes) {
    switch (dispute.state) {
      case "action_required":
      case "under_review":
        return true;
      case "won":
      case "lost":
        break;
      default:
        return assertNever(dispute, "Unhandled storefront state");
    }
  }
  return false;
}

export function statusMessage(state: StorefrontState): string {
  switch (state.kind) {
    case "booting":
      return "Loading storefront.";
    case "quoting":
      return "Preparing your quote.";
    case "paying_pickup":
    case "paying_shipping":
      return "Placing your order.";
    case "payment_pickup":
    case "payment_shipping":
      return "Secure payment details ready.";
    case "pickup_quote":
    case "shipping_quote":
      return "Quote ready.";
    case "shipping_address_correction":
      return "Address correction ready for review.";
    case "pickup_order":
      return `Pickup status: ${state.order.state.replaceAll("_", " ")}.`;
    case "shipping_order":
      return `Delivery status: ${state.order.state.replaceAll("_", " ")}.`;
    case "declined":
      return "Payment declined.";
    case "indeterminate_pickup":
    case "indeterminate_shipping":
      return "Payment status is still being checked.";
    case "catalog":
      return "Storefront loaded.";
    case "failed":
      return state.failure.message;
  }
}

/** An unreadable reply shows a fixed sentence, not the parser's reason. */
