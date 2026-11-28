import type { Result } from "@purin-labs/kernel/result";
import { bytesToHex } from "@purin-labs/std";

/**
 * The check of a `Stripe-Signature` header. Each Stripe webhook of Pantry
 * uses it: the Connect and merchant webhooks of Commerce, and the billing
 * webhook of Pantry's own Stripe account (Plan 95 step 6).
 */
export type StripeSignatureError =
  | { code: "stripe_signature_missing" }
  | { code: "stripe_signature_invalid" }
  | { code: "stripe_signature_expired" };

const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const STRIPE_SIGNATURE_VERSION = "v1";

export async function verifyStripeWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  signingSecret: string;
  nowMs: number;
}): Promise<Result<null, StripeSignatureError>> {
  if (input.signatureHeader === null) {
    return { ok: false, error: { code: "stripe_signature_missing" } };
  }

  const parsed = parseStripeSignatureHeader(input.signatureHeader);

  if (!parsed.ok) {
    return parsed;
  }

  const nowSeconds = Math.floor(input.nowMs / 1000);

  if (
    Math.abs(nowSeconds - parsed.value.timestamp) >
    STRIPE_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return { ok: false, error: { code: "stripe_signature_expired" } };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${parsed.value.timestamp}.${input.rawBody}`),
  );
  const expected = bytesToHex(new Uint8Array(signature));
  const matched = parsed.value.signatures.some(
    constantTimeHexEqual.bind(null, expected),
  );

  return matched
    ? { ok: true, value: null }
    : { ok: false, error: { code: "stripe_signature_invalid" } };
}

function parseStripeSignatureHeader(
  raw: string,
): Result<
  { timestamp: number; signatures: readonly string[] },
  StripeSignatureError
> {
  const values = raw.split(",");
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const value of values) {
    const [key, content] = value.split("=", 2);

    if (key === "t" && content !== undefined) {
      const parsed = /^\d+$/u.test(content)
        ? Number.parseInt(content, 10)
        : Number.NaN;
      timestamp = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }

    if (
      key === STRIPE_SIGNATURE_VERSION &&
      content !== undefined &&
      /^[a-f0-9]{64}$/iu.test(content)
    ) {
      signatures.push(content.toLowerCase());
    }
  }

  return timestamp !== null && signatures.length > 0
    ? { ok: true, value: { timestamp, signatures } }
    : { ok: false, error: { code: "stripe_signature_invalid" } };
}

function constantTimeHexEqual(expected: string, candidate: string): boolean {
  if (expected.length !== candidate.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  }

  return difference === 0;
}
