import type {
  CreateCommerceBuyerShippingCheckoutV1,
  CommerceBuyerContactAuthorityV1,
  CommerceBuyerContactV1,
  CommerceCheckoutBuyerAuthorityV1,
} from "./index.ts";

const emailContact: CommerceBuyerContactV1 = {
  kind: "email",
  email: "buyer@example.test",
};

const emailAndPhoneContact: CommerceBuyerContactV1 = {
  kind: "email_and_phone",
  email: "buyer@example.test",
  phone: "+819012345678",
};

// @ts-expect-error The email-only branch cannot carry a phone number.
const mixedContact: CommerceBuyerContactV1 = {
  kind: "email",
  email: "buyer@example.test",
  phone: "+819012345678",
};

// @ts-expect-error The email-and-phone branch requires its phone evidence.
const incompleteContact: CommerceBuyerContactV1 = {
  kind: "email_and_phone",
  email: "buyer@example.test",
};

const retainedAuthority: CommerceBuyerContactAuthorityV1 = {
  kind: "retained_checkout",
  checkoutId: "checkout_existing",
  checkoutRevision: 1,
  quoteDigest: "a".repeat(64),
};

const mixedAuthority: CommerceBuyerContactAuthorityV1 = {
  ...retainedAuthority,
  // @ts-expect-error Retained checkout authority cannot inject new contact evidence.
  contact: { kind: "email", emailDigest: "b".repeat(64) },
};

// @ts-expect-error Identified customer authority cannot carry guest checkout evidence.
const mixedBuyerAuthority: CommerceCheckoutBuyerAuthorityV1 = {
  kind: "identified_customer",
  customerReference: "customer_ada",
  contact: { kind: "email", emailDigest: "c".repeat(64) },
  contactAuthority: retainedAuthority,
};

// @ts-expect-error A guest cannot select an account-owned saved address.
const guestSavedAddressCheckout: CreateCommerceBuyerShippingCheckoutV1 = {
  schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
  idempotencyKey: "guest_saved_address",
  cartId: "cart_guest",
  cartRevision: 1,
  buyer: { kind: "guest", contact: emailContact },
  shippingDestination: {
    kind: "saved_address",
    savedAddressReference: "saved_address_home",
  },
};

void emailContact;
void emailAndPhoneContact;
void mixedContact;
void incompleteContact;
void retainedAuthority;
void mixedAuthority;
void mixedBuyerAuthority;
void guestSavedAddressCheckout;
