import {
  type ControlMutationIntent,
  controlMutation,
  controlSignal,
  readCookie,
} from "@purin-labs/control/portal/control-client";
import type { CheckoutProfileMutationTransport } from "@purin-labs/area-commerce-contract/ui/features/checkout-profiles/transport";
import type { PayoutMutationTransport } from "@purin-labs/area-commerce-contract/ui/features/payouts/transport";

export function commerceEntityPlaneControlMutation(
  path: string,
  body: unknown,
  intent: ControlMutationIntent,
): Promise<unknown> {
  return controlMutation(path, "POST", body, undefined, intent);
}

export function supplierPayoutControlMutation(
  path: string,
  method: Parameters<PayoutMutationTransport>[1],
  body: unknown,
  intent: string,
): Promise<unknown> {
  return controlMutation(path, method, body, undefined, intent);
}

export function terminalControlMutation(
  path: string,
  method: "POST",
  body: unknown,
  intent: string,
): Promise<unknown> {
  return controlMutation(path, method, body, undefined, intent);
}

export function checkoutProfileControlMutation(
  path: string,
  method: Parameters<CheckoutProfileMutationTransport>[1],
  body: unknown,
  intent: string,
): Promise<unknown> {
  return controlMutation(path, method, body, undefined, intent);
}

export async function commerceBoardPresenceTransport(
  path: string,
  body: unknown,
): Promise<unknown> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) {
    throw new Error("Your control session expired. Sign in again.");
  }
  return controlSignal(path, body);
}
