import type { CommerceDemoProfile } from "@seams/commerce-client";
import { jsonResponse } from "./responses.ts";

type JsonBodyResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; response: Response }>;

export type ParsedBody<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; response: Response }>;

export function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer "))
    return undefined;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 && token === token.trim() ? token : undefined;
}

export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return {
      ok: false,
      response: jsonResponse(415, {
        message: "Content-Type must be application/json",
      }),
    };
  }
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return {
      ok: false,
      response: jsonResponse(400, {
        message: "Request body must be valid JSON",
      }),
    };
  }
}

/**
 * The fields that a write body never names: the server gives the version and
 * the time, the header gives the key, and the merchant's owner and the
 * action nonce are not part of a command (Plan 80 step 2).
 */
export const SERVER_COMMAND_FIELDS = [
  "schemaVersion",
  "organisationId",
  "idempotencyKey",
  "actionNonce",
  "requestedAt",
] as const;

export function hasMerchantId(value: unknown, merchantId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "merchantId" in value &&
    value.merchantId === merchantId
  );
}

export function hasProductId(value: unknown, productId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, "productId") === productId
  );
}

export function hasDemoProfile(
  value: unknown,
  profile: CommerceDemoProfile,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, "profile") === profile
  );
}

export function hasDeliveryId(value: unknown, deliveryId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "deliveryId" in value &&
    value.deliveryId === deliveryId
  );
}

export function hasCheckoutId(value: unknown, checkoutId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "checkoutId" in value &&
    value.checkoutId === checkoutId
  );
}

export function hasPaymentAttemptId(
  value: unknown,
  paymentAttemptId: string,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "paymentAttemptId" in value &&
    value.paymentAttemptId === paymentAttemptId
  );
}

export function hasOrderId(value: unknown, orderId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "orderId" in value &&
    value.orderId === orderId
  );
}

export function hasFulfillmentId(
  value: unknown,
  fulfillmentId: string,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "fulfillmentId" in value &&
    value.fulfillmentId === fulfillmentId
  );
}

export function hasShipmentId(value: unknown, shipmentId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "shipmentId" in value &&
    value.shipmentId === shipmentId
  );
}

export function requireToken(value: string): string {
  if (value.length < 16 || value !== value.trim()) {
    throw new Error(
      "serviceToken must contain at least 16 normalized characters",
    );
  }
  return value;
}

export function parseNonNegativeQueryNumber(
  value: string | null,
  field: string,
): number {
  if (value === null || !/^\d+$/u.test(value))
    throw new Error(`${field} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is too large`);
  return parsed;
}

export function parsePositiveQueryNumber(
  value: string | null,
  field: string,
): number {
  const parsed = parseNonNegativeQueryNumber(value, field);
  if (parsed < 1 || parsed > 100)
    throw new Error(`${field} must be between 1 and 100`);
  return parsed;
}
