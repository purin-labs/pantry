import type {
  CommerceBuyerShippingAddressV1,
  CommerceBuyerShippingDestinationV1,
} from "./index.ts";

const japanAddress: CommerceBuyerShippingAddressV1 = {
  countryCode: "JP",
  recipientName: "Pantry Buyer",
  addressLine1: "1-2-3 Marunouchi",
  locality: "Chiyoda-ku",
  administrativeArea: "Tokyo",
  postalCode: "100-0005",
};

const singaporeAddress: CommerceBuyerShippingAddressV1 = {
  countryCode: "SG",
  recipientName: "Pantry Buyer",
  addressLine1: "1 Raffles Quay",
  locality: "Singapore",
  postalCode: "018956",
};

// @ts-expect-error Singapore addresses cannot carry Japan-only administrative state.
const mixedAddress: CommerceBuyerShippingAddressV1 = {
  countryCode: "SG",
  recipientName: "Pantry Buyer",
  addressLine1: "1 Raffles Quay",
  locality: "Singapore",
  postalCode: "018956",
  administrativeArea: "Tokyo",
};

// @ts-expect-error Japan addresses require an administrative area.
const incompleteJapanAddress: CommerceBuyerShippingAddressV1 = {
  countryCode: "JP",
  recipientName: "Pantry Buyer",
  addressLine1: "1-2-3 Marunouchi",
  locality: "Chiyoda-ku",
  postalCode: "100-0005",
  administrativeArea: undefined,
};

const acceptedProvidedAddress: CommerceBuyerShippingDestinationV1 = {
  kind: "provided_address",
  address: singaporeAddress,
  acceptance: {
    kind: "accepted_as_entered",
    addressValidationReference: "address_validation_fixture",
  },
};

// @ts-expect-error Provided addresses require an exact address-validation acceptance.
const unvalidatedProvidedAddress: CommerceBuyerShippingDestinationV1 = {
  kind: "provided_address",
  address: singaporeAddress,
};

const invalidSavedAddressAcceptance: CommerceBuyerShippingDestinationV1 = {
  kind: "saved_address",
  savedAddressReference: "saved_address_fixture",
  acceptance: {
    // @ts-expect-error Saved addresses carry their trusted validation reference internally.
    kind: "accepted_as_entered",
    addressValidationReference: "address_validation_fixture",
  },
};

void japanAddress;
void singaporeAddress;
void mixedAddress;
void incompleteJapanAddress;
void acceptedProvidedAddress;
void unvalidatedProvidedAddress;
void invalidSavedAddressAcceptance;
