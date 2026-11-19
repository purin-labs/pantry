import {
  type CreateCommerceBuyerPaymentSessionV1,
  type CommerceBuyerPaymentResultV1,
  type CommerceBuyerPaymentSessionV1,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

type ReadyPaymentSession = VariantBy<
  CommerceBuyerPaymentSessionV1,
  "state",
  "ready"
>;

export type PunterPaymentSessionIdentity = Readonly<{
  checkoutId: string;
  checkoutRevision: number;
  paymentAttemptId: string;
  providerSessionReference: string;
}>;

type PunterPaymentResolution = Readonly<{
  session: PunterPaymentSessionIdentity;
  payment: CommerceBuyerPaymentResultV1;
}>;

type PunterPaymentResult =
  | Readonly<{ ok: true; value: PunterPaymentResolution }>
  | Readonly<{ ok: false; message: string }>;

type PaymentInput = Readonly<{
  client: CommerceStorefrontClient;
  merchantId: string;
  storefrontId: string;
  checkoutId: string;
  sessionToken: string;
  command: Omit<CreateCommerceBuyerPaymentSessionV1, "returnUrl">;
}>;

export async function collectAndReconcilePayment(
  input: PaymentInput &
    Readonly<{
      returnUrl: string;
    }>,
): Promise<PunterPaymentResult> {
  const session = await input.client.createPaymentSession(
    input.merchantId,
    input.storefrontId,
    input.checkoutId,
    input.sessionToken,
    { ...input.command, returnUrl: input.returnUrl },
  );
  if (!session.ok) return { ok: false, message: session.error.message };
  if (session.value.state !== "ready") {
    return {
      ok: false,
      message: `Payment collection unavailable until ${session.value.retryAfter}`,
    };
  }
  return reconcilePayment(input, paymentSessionIdentity(session.value));
}

export async function replayAndReconcilePayment(
  input: PaymentInput &
    Readonly<{
      returnUrl: string;
      expectedSession: PunterPaymentSessionIdentity;
    }>,
): Promise<PunterPaymentResult> {
  const session = await input.client.createPaymentSession(
    input.merchantId,
    input.storefrontId,
    input.checkoutId,
    input.sessionToken,
    { ...input.command, returnUrl: input.returnUrl },
  );
  if (!session.ok) {
    if (!isAlreadyBoundPaymentSession(session)) {
      return { ok: false, message: session.error.message };
    }
    return reconcilePayment(input, input.expectedSession);
  }
  if (session.value.state !== "ready") {
    return {
      ok: false,
      message: `Payment collection unavailable until ${session.value.retryAfter}`,
    };
  }
  const identity = paymentSessionIdentity(session.value);
  if (!samePaymentSessionIdentity(identity, input.expectedSession)) {
    return {
      ok: false,
      message: "Payment session replay changed payment attempt identity",
    };
  }
  return reconcilePayment(input, identity);
}

async function reconcilePaymentAfterIndeterminate(
  input: Readonly<{
    client: CommerceStorefrontClient;
    merchantId: string;
    storefrontId: string;
    checkoutId: string;
    sessionToken: string;
    command: Omit<CreateCommerceBuyerPaymentSessionV1, "returnUrl">;
    session: PunterPaymentSessionIdentity;
  }>,
): Promise<PunterPaymentResult> {
  return reconcilePayment(input, input.session);
}

export async function recoverPunterPayment(
  input: Readonly<{
    client: CommerceStorefrontClient;
    merchantId: string;
    storefrontId: string;
    checkoutId: string;
    sessionToken: string;
    command: Omit<CreateCommerceBuyerPaymentSessionV1, "returnUrl">;
    session: PunterPaymentSessionIdentity;
    payment: CommerceBuyerPaymentResultV1;
    intervalMs: number;
    wait: (milliseconds: number) => Promise<void>;
  }>,
): Promise<PunterPaymentResult> {
  switch (input.payment.state) {
    case "placed":
    case "declined":
      return {
        ok: true,
        value: { session: input.session, payment: input.payment },
      };
    case "processing":
    case "indeterminate":
      await input.wait(input.intervalMs);
      return reconcilePaymentAfterIndeterminate(input);
    default:
      return assertNever(input.payment, "Unsupported Punter payment branch");
  }
}

async function reconcilePayment(
  input: Readonly<{
    client: CommerceStorefrontClient;
    merchantId: string;
    storefrontId: string;
    checkoutId: string;
    sessionToken: string;
    command: Omit<CreateCommerceBuyerPaymentSessionV1, "returnUrl">;
  }>,
  session: PunterPaymentSessionIdentity,
): Promise<PunterPaymentResult> {
  if (
    session.checkoutId !== input.checkoutId ||
    session.checkoutRevision !== input.command.checkoutRevision
  ) {
    return {
      ok: false,
      message: "Payment session does not match checkout revision",
    };
  }
  const payment = await input.client.reconcilePayment(
    input.merchantId,
    input.storefrontId,
    input.checkoutId,
    input.sessionToken,
    {
      schemaVersion: "underclerk.reconcile-buyer-payment.v1",
      idempotencyKey: input.command.idempotencyKey,
      checkoutRevision: input.command.checkoutRevision,
      quoteDigest: input.command.quoteDigest,
      confirmation: { kind: "provider_ui_completed" },
    },
  );
  return payment.ok
    ? { ok: true, value: { session, payment: payment.value } }
    : { ok: false, message: payment.error.message };
}

function paymentSessionIdentity(
  session: ReadyPaymentSession,
): PunterPaymentSessionIdentity {
  return {
    checkoutId: session.checkoutId,
    checkoutRevision: session.checkoutRevision,
    paymentAttemptId: session.paymentAttemptId,
    providerSessionReference: session.session.providerSessionReference,
  };
}

function samePaymentSessionIdentity(
  left: PunterPaymentSessionIdentity,
  right: PunterPaymentSessionIdentity,
): boolean {
  return (
    left.checkoutId === right.checkoutId &&
    left.checkoutRevision === right.checkoutRevision &&
    left.paymentAttemptId === right.paymentAttemptId &&
    left.providerSessionReference === right.providerSessionReference
  );
}

// Commerce rejects a new payment session once the checkout has left
// payment; the replay then reconciles the session it already holds.
function isAlreadyBoundPaymentSession(
  result: Readonly<{
    ok: false;
    error: Readonly<{
      kind: string;
      error?: Readonly<{ code: string; field?: string }>;
    }>;
  }>,
): boolean {
  return (
    result.error.kind === "rejected" &&
    result.error.error?.code === "resource_relationship_invalid" &&
    result.error.error.field === "buyerCheckout.paymentSession"
  );
}
