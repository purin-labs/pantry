import { bytesToHex } from "@seams/std";

export type CommerceLabSignatureFailure =
  | { code: "commerce_lab_signature_missing" }
  | { code: "commerce_lab_timestamp_invalid" }
  | { code: "commerce_lab_signature_expired" }
  | { code: "commerce_lab_signature_invalid" };

export type CommerceLabSignatureVerification =
  | { ok: true; timestampSeconds: number }
  | { ok: false; error: CommerceLabSignatureFailure };

const COMMERCE_LAB_SIGNATURE_VERSION = "v1";
const COMMERCE_LAB_SIGNATURE_TOLERANCE_SECONDS = 300;

export async function verifyCommerceLabSignature(input: {
  headers: Headers;
  rawBody: string;
  signingSecret: string;
  nowMs: number;
}): Promise<CommerceLabSignatureVerification> {
  const timestamp = input.headers.get("x-satyr-lab-timestamp");
  const signature = input.headers.get("x-satyr-lab-signature");

  if (timestamp === null || signature === null) {
    return { ok: false, error: { code: "commerce_lab_signature_missing" } };
  }

  const timestampSeconds = Number(timestamp);

  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    return { ok: false, error: { code: "commerce_lab_timestamp_invalid" } };
  }

  const nowSeconds = Math.floor(input.nowMs / 1000);

  if (
    Math.abs(nowSeconds - timestampSeconds) >
    COMMERCE_LAB_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return { ok: false, error: { code: "commerce_lab_signature_expired" } };
  }

  const expected = await signCommerceLabBody({
    signingSecret: input.signingSecret,
    timestamp,
    rawBody: input.rawBody,
  });

  return constantTimeEqual(expected, signature)
    ? { ok: true, timestampSeconds }
    : { ok: false, error: { code: "commerce_lab_signature_invalid" } };
}

async function signCommerceLabBody(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
}): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${COMMERCE_LAB_SIGNATURE_VERSION}:${input.timestamp}:${input.rawBody}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  return `${COMMERCE_LAB_SIGNATURE_VERSION}=${bytesToHex(new Uint8Array(signature))}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
}
