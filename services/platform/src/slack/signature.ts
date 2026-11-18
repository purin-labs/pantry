import { bytesToHex } from "@seams/std";

type SlackSignatureVerification =
  { ok: true } | { ok: false; reason: SlackSignatureFailure };

type SlackSignatureFailure =
  "missing_header" | "bad_timestamp" | "expired" | "bad_signature";

const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export async function verifySlackSignature(
  headers: Headers,
  rawBody: string,
  signingSecret: string,
  nowMs: number,
): Promise<SlackSignatureVerification> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");

  if (timestamp === null || signature === null) {
    return { ok: false, reason: "missing_header" };
  }

  const timestampSeconds = Number(timestamp);

  if (!Number.isInteger(timestampSeconds)) {
    return { ok: false, reason: "bad_timestamp" };
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const skew = Math.abs(nowSeconds - timestampSeconds);

  if (skew > SLACK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  const expected = await signSlackBody(signingSecret, timestamp, rawBody);

  if (!constantTimeEqual(expected, signature)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}

async function signSlackBody(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const base = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));

  return `${SLACK_SIGNATURE_VERSION}=${bytesToHex(new Uint8Array(signature))}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return diff === 0;
}
