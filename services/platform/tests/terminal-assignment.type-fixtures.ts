import type {
  TerminalAssignment,
  TerminalPairingAttemptState,
  TerminalPaymentObservation,
  TerminalTarget,
} from "@purin-labs/commerce-contracts";

const account = {
  integrationAccountId: "integration_square_fixture",
  providerAccountId: "provider_merchant_fixture",
  environment: "production" as const,
  capabilityRevision: 1,
  country: "JP",
  currency: "JPY",
};

const merchantId = "merchant_fixture" as TerminalAssignment["merchantId"];

const assignment = {
  assignmentId: "terminal_assignment_fixture",
  organisationId: "organisation_fixture",
  merchantId,
  satyrLocationId: "pantry_location_fixture",
  account,
  providerLocationId: "provider_location_fixture",
  target: {
    kind: "paired_physical",
    providerDeviceId: "device_fixture",
  } as const,
  transport: "server_terminal" as const,
  adapterVersion: "square_terminal@2026-08-19",
  revision: 1,
};

const simulatedWithProviderDevice: TerminalTarget = {
  kind: "sandbox_simulated",
  testDeviceId: "test_device_fixture",
  // @ts-expect-error A simulated target is never a provider device resource.
  providerDeviceId: "device_fixture",
};

const openAttemptWithDevice: TerminalPairingAttemptState = {
  kind: "open",
  pairingCodeId: "pairing_code_fixture",
  expiresAt: "2026-09-05T00:00:00Z",
  // @ts-expect-error An open pairing code is not a device: only a completed pairing names one.
  providerDeviceId: "device_fixture",
};

// @ts-expect-error A completed pairing must record when it paired.
const pairedWithoutTime: TerminalPairingAttemptState = {
  kind: "paired",
  providerDeviceId: "device_fixture",
};

const posAppHandoffAssignment: TerminalAssignment = {
  ...assignment,
  // @ts-expect-error Only server-controlled Square Terminal collection ships.
  transport: "pos_app_handoff",
  state: { kind: "active" },
};

const assignmentWithoutCapabilityRevision: TerminalAssignment = {
  ...assignment,
  // @ts-expect-error An assignment binds one exact capability revision.
  account: {
    integrationAccountId: "integration_square_fixture",
    providerAccountId: "provider_merchant_fixture",
    environment: "production",
    country: "JP",
    currency: "JPY",
  },
  state: { kind: "active" },
};

// @ts-expect-error Certification pins an exact adapter version.
const assignmentWithoutAdapterVersion: TerminalAssignment = {
  assignmentId: "terminal_assignment_fixture",
  organisationId: "organisation_fixture",
  merchantId,
  satyrLocationId: "pantry_location_fixture",
  account,
  providerLocationId: "provider_location_fixture",
  target: { kind: "paired_physical", providerDeviceId: "device_fixture" },
  transport: "server_terminal",
  revision: 1,
  state: { kind: "active" },
};

const assignmentWithUnbrandedMerchant: TerminalAssignment = {
  ...assignment,
  // @ts-expect-error A Pantry merchant identity is not an arbitrary string.
  merchantId: "merchant_fixture",
  state: { kind: "active" },
};

const assignmentWithHealth: TerminalAssignment = {
  ...assignment,
  state: { kind: "active" },
  // @ts-expect-error Device health is separate evidence and can never reach payment authority.
  health: { kind: "unavailable", observedAt: "2026-09-05T00:00:00Z" },
};

const assignmentWithCommerceData: TerminalAssignment = {
  ...assignment,
  state: { kind: "active" },
  // @ts-expect-error A terminal assignment is payment authority, never commerce authority.
  catalogObjectId: "catalog_object_fixture",
};

const retiredWithoutEvidence: TerminalAssignment = {
  ...assignment,
  // @ts-expect-error Retirement is an operator decision that records its reason and time.
  state: { kind: "retired" },
};

const observation = {
  providerDeliveryId: "delivery_fixture",
  providerAccountId: "provider_merchant_fixture",
  terminalCheckoutId: "terminal_checkout_fixture",
  providerLocationId: "provider_location_fixture",
  deviceId: "device_fixture",
  amount: { amountMinor: 1_200, currency: "JPY" },
  observedAt: "2026-09-05T00:00:00Z",
};

const pendingWithPaymentId: TerminalPaymentObservation = {
  ...observation,
  lifecycle: {
    kind: "pending",
    // @ts-expect-error Only a completed payment owns a provider payment identity.
    paymentId: "payment_fixture",
  },
};

const observationWithCommerceData: TerminalPaymentObservation = {
  ...observation,
  lifecycle: { kind: "completed", paymentId: "payment_fixture" },
  // @ts-expect-error Provider order facts cannot enter an observation.
  orderId: "provider_order_fixture",
};

void simulatedWithProviderDevice;
void openAttemptWithDevice;
void pairedWithoutTime;
void posAppHandoffAssignment;
void assignmentWithoutCapabilityRevision;
void assignmentWithoutAdapterVersion;
void assignmentWithUnbrandedMerchant;
void assignmentWithHealth;
void assignmentWithCommerceData;
void retiredWithoutEvidence;
void pendingWithPaymentId;
void observationWithCommerceData;
