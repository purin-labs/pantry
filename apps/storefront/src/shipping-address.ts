import {
  isCommerceInternationalShippingCountry,
  isCommercePostalCode,
  commerceAddressNeedsState,
  type CommerceBuyerCatalogV1,
  type CommerceBuyerContactV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceBuyerQuotedShippingCheckoutV1,
  type CommerceBuyerShippingAddressV1,
} from "@purin-labs/commerce-client";
import { assertNever } from "@purin-labs/std";
import type {
  BuyerContactDraft,
  BuyerContactPolicy,
  BuyerOrderAccess,
  ShippingAddressDraft,
  ShippingCountryCode,
} from "./storefront-types.ts";
import { hasText, shippingCountryCopy } from "./storefront-basket.tsx";

export type ShippingCountryCopy = Readonly<{
  name: string;
  heroDetail: string;
  deliveryHeading: string;
  deliveryDetail: string;
  destinationDetail: string;
  noServices: string;
  correctionDetail: string;
  localityLabel: string;
  areaLabel: string;
  postalLabel: string;
  postalInputMode: "numeric" | undefined;
  /** An HTML pattern; absent where postal codes have letters. */
  postalPattern: string | undefined;
  postalHint: string;
  quoteEyebrow: string;
  quoteTitle: string;
  quoteDetail: string;
  orderEyebrow: string;
}>;

export function parseShippingCountry(value: string): ShippingCountryCode | undefined {
  return value === "JP" ||
    value === "SG" ||
    isCommerceInternationalShippingCountry(value)
    ? value
    : undefined;
}

/**
 * The delivery countries to offer: Japan and Singapore first, then every
 * country with a published service, by name, and the current choice.
 */
export function shippingCountryOptions(
  catalog: CommerceBuyerCatalogV1,
  current: ShippingCountryCode,
): readonly ShippingCountryCode[] {
  const published = new Set<ShippingCountryCode>([current]);
  if (catalog.storefront.fulfillment === "shipping")
    for (const service of catalog.storefront.shippingServices) {
      const country = parseShippingCountry(service.destinationCountry);
      if (country !== undefined) published.add(country);
    }
  const others = [...published]
    .filter((country) => country !== "JP" && country !== "SG")
    .sort((left, right) =>
      shippingCountryCopy(left).name.localeCompare(
        shippingCountryCopy(right).name,
      ),
    );
  return ["JP", "SG", ...others];
}

export function shippingAddressWithField(
  address: ShippingAddressDraft,
  field: ShippingAddressField,
  value: string,
): ShippingAddressDraft | undefined {
  switch (address.countryCode) {
    case "JP":
      switch (field) {
        case "recipientName":
          return { ...address, recipientName: value };
        case "addressLine1":
          return { ...address, addressLine1: value };
        case "locality":
          return { ...address, locality: value };
        case "administrativeArea":
          return { ...address, administrativeArea: value };
        case "postalCode":
          return { ...address, postalCode: value };
        default:
          return assertNever(field, "Unhandled storefront state");
      }
    case "SG":
      switch (field) {
        case "recipientName":
          return { ...address, recipientName: value };
        case "addressLine1":
          return { ...address, addressLine1: value };
        case "postalCode":
          return { ...address, postalCode: value };
        case "locality":
        case "administrativeArea":
          return undefined;
        default:
          return assertNever(field, "Unhandled storefront state");
      }
    default:
      switch (field) {
        case "recipientName":
          return { ...address, recipientName: value };
        case "addressLine1":
          return { ...address, addressLine1: value };
        case "locality":
          return { ...address, locality: value };
        case "administrativeArea":
          return commerceAddressNeedsState(address.countryCode)
            ? { ...address, administrativeArea: value }
            : undefined;
        case "postalCode":
          return { ...address, postalCode: value };
        default:
          return assertNever(field, "Unhandled storefront state");
      }
  }
}

export function normalizedShippingAddress(
  address: ShippingAddressDraft,
): CommerceBuyerShippingAddressV1 {
  switch (address.countryCode) {
    case "JP":
      return {
        countryCode: "JP",
        recipientName: address.recipientName.trim(),
        addressLine1: address.addressLine1.trim(),
        locality: address.locality.trim(),
        administrativeArea: address.administrativeArea.trim(),
        postalCode: normalizedJapanesePostalCode(address.postalCode),
      };
    case "SG":
      return {
        countryCode: "SG",
        recipientName: address.recipientName.trim(),
        addressLine1: address.addressLine1.trim(),
        locality: "Singapore",
        postalCode: address.postalCode.trim(),
      };
    default:
      return {
        countryCode: address.countryCode,
        recipientName: address.recipientName.trim(),
        addressLine1: address.addressLine1.trim(),
        locality: address.locality.trim(),
        ...(address.administrativeArea === undefined
          ? {}
          : {
              administrativeArea: address.administrativeArea
                .trim()
                .toUpperCase(),
            }),
        postalCode: address.postalCode.trim().toUpperCase(),
      };
  }
}

function normalizedJapanesePostalCode(value: string): string {
  const digits = value.trim().replace("-", "");
  return /^\d{7}$/u.test(digits)
    ? `${digits.slice(0, 3)}-${digits.slice(3)}`
    : value.trim();
}

export function shippingAddressForCountry(
  address: CommerceBuyerShippingAddressV1,
  countryCode: ShippingCountryCode,
): ShippingAddressDraft | undefined {
  switch (countryCode) {
    case "JP":
      return address.countryCode === "JP" ? address : undefined;
    case "SG":
      return address.countryCode === "SG" ? address : undefined;
    default:
      return address.countryCode === countryCode ? address : undefined;
  }
}

export function shippingAddressSummary(address: ShippingAddressDraft): string {
  switch (address.countryCode) {
    case "JP":
      return `${address.recipientName}, ${address.addressLine1}, ${address.locality}, ${address.administrativeArea} ${address.postalCode}`;
    case "SG":
      return `${address.recipientName}, ${address.addressLine1}, ${address.locality} ${address.postalCode}`;
    default:
      return [
        address.recipientName,
        address.addressLine1,
        address.locality,
        [address.administrativeArea, address.postalCode]
          .filter(hasText)
          .join(" "),
      ].join(", ");
  }
}

export function normalizedBuyerContact(
  contact: BuyerContactDraft,
  policy: BuyerContactPolicy,
): CommerceBuyerContactV1 {
  const email = contact.email.trim();
  const phone = contact.phone.trim();
  switch (policy) {
    case "email_required":
    case "email_required_phone_optional":
      return policy === "email_required" || phone.length === 0
        ? { kind: "email", email }
        : { kind: "email_and_phone", email, phone };
    case "email_and_phone_required":
      return { kind: "email_and_phone", email, phone };
    default:
      return assertNever(policy, "Unhandled storefront state");
  }
}

export function contactFieldError(
  submitted: boolean,
  field: keyof BuyerContactDraft,
  value: string,
  policy: BuyerContactPolicy,
): string | undefined {
  if (!submitted) return undefined;
  const normalized = value.trim();
  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    return "Enter an email address.";
  }
  if (field === "phone") {
    if (policy === "email_and_phone_required" && normalized.length === 0)
      return "Enter a phone number.";
    if (normalized.length > 0 && !/^\+[1-9]\d{7,14}$/u.test(normalized)) {
      return "Use international format, such as +819012345678.";
    }
  }
  return undefined;
}

export type ShippingAddressField =
  | "recipientName"
  | "addressLine1"
  | "locality"
  | "administrativeArea"
  | "postalCode";

export function shippingFieldError(
  submitted: boolean,
  field: ShippingAddressField,
  address: ShippingAddressDraft,
): string | undefined {
  if (!submitted) return undefined;
  if (field === "recipientName" && address.recipientName.trim().length === 0)
    return "Enter a recipient name.";
  if (field === "addressLine1" && address.addressLine1.trim().length === 0)
    return "Enter a street address.";
  switch (address.countryCode) {
    case "JP":
      if (field === "locality" && address.locality.trim().length === 0)
        return "Enter a city or ward.";
      if (
        field === "administrativeArea" &&
        address.administrativeArea.trim().length === 0
      )
        return "Enter a prefecture.";
      if (
        field === "postalCode" &&
        !/^\d{3}-?\d{4}$/u.test(address.postalCode.trim())
      )
        return "Enter a seven-digit Japanese postal code.";
      return undefined;
    case "SG":
      if (field === "postalCode" && !/^\d{6}$/u.test(address.postalCode.trim()))
        return "Enter a six-digit Singapore postal code.";
      return undefined;
    default:
      if (field === "locality" && address.locality.trim().length === 0)
        return "Enter a city.";
      if (
        field === "administrativeArea" &&
        commerceAddressNeedsState(address.countryCode) &&
        (address.administrativeArea ?? "").trim().length === 0
      )
        return "Enter a state.";
      if (
        field === "postalCode" &&
        !isCommercePostalCode(address.countryCode, address.postalCode)
      )
        return shippingCountryCopy(address.countryCode).postalHint;
      return undefined;
  }
}

export function focusFirstInvalidField(form: HTMLFormElement): void {
  form.querySelector<HTMLInputElement>(":invalid")?.focus();
}

export function quoteHasExpired(
  quote:
    CommerceBuyerQuotedCheckoutV1 | CommerceBuyerQuotedShippingCheckoutV1,
): boolean {
  return Date.parse(quote.quote.expiresAt) <= Date.now();
}

export function newRunId(): string {
  return `storefront_${crypto.randomUUID()}`;
}

export function createOrderAccess(
  checkoutId: string,
  token: string,
): BuyerOrderAccess {
  const fragment = new URLSearchParams({ order: checkoutId, access: token });
  const returnUrl = `${window.location.origin}${window.location.pathname}#${fragment.toString()}`;
  return { checkoutId, token, returnUrl };
}
