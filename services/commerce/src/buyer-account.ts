import {
  isCommerceInternationalShippingCountry,
  parseInternationalShippingAddress,
  type CommerceBuyerContactV1,
  type CommerceBuyerShippingAddressV1,
  type CommerceCustomerAddressV1,
} from "@seams/commerce-client";

export type BuyerAccountIdentity = Readonly<{
  protectedCustomerReference: string;
  protectedCustomerSessionReference: string;
  contact: CommerceBuyerContactV1;
}>;

export type BuyerSavedAddress = Readonly<{
  address: CommerceBuyerShippingAddressV1;
  addressValidationReference: string;
}>;

export type BuyerAccountResult<T> =
  Readonly<{ kind: "resolved"; value: T }> | Readonly<{ kind: "unavailable" }>;

export type BuyerAccountGateway = Readonly<{
  identify: (
    input: Readonly<{
      merchantId: string;
      storefrontId: string;
      customerAccessToken: string;
    }>,
  ) => Promise<BuyerAccountResult<BuyerAccountIdentity>>;
  resolveSavedAddress: (
    input: Readonly<{
      merchantId: string;
      storefrontId: string;
      protectedCustomerReference: string;
      protectedCustomerSessionReference: string;
      savedAddressReference: string;
      /** The buyer session the address validation belongs to. */
      buyerSessionDigest: string;
    }>,
  ) => Promise<BuyerAccountResult<BuyerSavedAddress>>;
}>;

export const unavailableBuyerAccountGateway: BuyerAccountGateway = {
  identify: unavailableBuyerAccountResult,
  resolveSavedAddress: unavailableBuyerAccountResult,
};

async function unavailableBuyerAccountResult(): Promise<
  Readonly<{ kind: "unavailable" }>
> {
  return { kind: "unavailable" };
}

/**
 * A saved customer address as a shipping address, for the destinations
 * Commerce ships to: Japan needs a prefecture, Singapore has one locality,
 * Australia and the United States need the state, and an EU address has no
 * region.
 */
export function savedAddressForShipping(
  saved: CommerceCustomerAddressV1,
): CommerceBuyerShippingAddressV1 | undefined {
  const addressLine1 = saved.line2 === null ? saved.line1 : `${saved.line1} ${saved.line2}`;
  switch (saved.countryCode) {
    case "JP":
      return saved.region === null
        ? undefined
        : {
            countryCode: "JP",
            recipientName: saved.recipient,
            addressLine1,
            locality: saved.locality,
            administrativeArea: saved.region,
            postalCode: saved.postalCode,
          };
    case "SG":
      return {
        countryCode: "SG",
        recipientName: saved.recipient,
        addressLine1,
        locality: "Singapore",
        postalCode: saved.postalCode,
      };
    default: {
      const countryCode = saved.countryCode;
      if (!isCommerceInternationalShippingCountry(countryCode))
        return undefined;
      try {
        return parseInternationalShippingAddress(
          {
            countryCode,
            recipientName: saved.recipient,
            addressLine1,
            locality: saved.locality,
            ...(countryCode === "AU" || countryCode === "US"
              ? { administrativeArea: saved.region }
              : {}),
            postalCode: saved.postalCode,
          },
          countryCode,
        );
      } catch {
        return undefined;
      }
    }
  }
}
