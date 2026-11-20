import type {
  CheckoutSource,
  PointOfSaleBuyer,
} from "@purin-labs/commerce-contracts";

const buyerContact = { kind: "email", emailDigest: "cd".repeat(32) } as const;

const anonymousWithCustomer: PointOfSaleBuyer = {
  kind: "anonymous",
  // @ts-expect-error An anonymous sale owns no customer identity.
  customerId: "customer_fixture",
};

// @ts-expect-error An identified buyer must name the customer.
const identifiedWithoutCustomer: PointOfSaleBuyer = {
  kind: "identified_customer",
};

const posWithStorefront: CheckoutSource = {
  kind: "point_of_sale",
  satyrLocationId: "pantry_location_fixture",
  operatorIdentity: "operator_fixture",
  terminalAssignmentRevision: 1,
  buyer: { kind: "anonymous" },
  // @ts-expect-error An in-person Checkout has no storefront.
  storefrontId: "storefront_fixture",
};

const posWithBuyerSession: CheckoutSource = {
  kind: "point_of_sale",
  satyrLocationId: "pantry_location_fixture",
  operatorIdentity: "operator_fixture",
  terminalAssignmentRevision: 1,
  buyer: { kind: "anonymous" },
  // @ts-expect-error An in-person Checkout has no buyer session to digest.
  buyerSessionDigest: "ab".repeat(32),
};

const onlineWithLocation: CheckoutSource = {
  kind: "online",
  storefrontId: "storefront_fixture",
  buyerSessionDigest: "ab".repeat(32),
  buyerContact,
  // @ts-expect-error An online Checkout has no Pantry location or terminal.
  satyrLocationId: "pantry_location_fixture",
};

// @ts-expect-error An in-person Checkout binds an exact terminal assignment revision.
const posWithoutAssignmentRevision: CheckoutSource = {
  kind: "point_of_sale",
  satyrLocationId: "pantry_location_fixture",
  operatorIdentity: "operator_fixture",
  buyer: { kind: "anonymous" },
};

// @ts-expect-error An in-person Checkout records the operator who took payment.
const posWithoutOperator: CheckoutSource = {
  kind: "point_of_sale",
  satyrLocationId: "pantry_location_fixture",
  terminalAssignmentRevision: 1,
  buyer: { kind: "anonymous" },
};

void anonymousWithCustomer;
void identifiedWithoutCustomer;
void posWithStorefront;
void posWithBuyerSession;
void onlineWithLocation;
void posWithoutAssignmentRevision;
void posWithoutOperator;
