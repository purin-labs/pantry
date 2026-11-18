import type { Result } from "./result";
import { decodeBase64 } from "@seams/std";

export type HarnessCheckpointError =
  | { code: "checkpoint_invalid" }
  | { code: "checkpoint_root_unavailable" }
  | { code: "checkpoint_root_invalid" }
  | { code: "checkpoint_write_failed"; detail: string }
  | { code: "checkpoint_read_failed"; detail: string }
  | { code: "checkpoint_missing" }
  | { code: "checkpoint_corrupt" }
  | { code: "checkpoint_too_large" };

const CHECKPOINT_MAGIC = new TextEncoder().encode("SATYRCP1");
const CHECKPOINT_CONTEXT = "satyr-harness-checkpoint-v1";
const CHECKPOINT_IV_BYTES = 12;
const CHECKPOINT_ROOT_BYTES = 32;
export const MAX_CHECKPOINT_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_CIPHERTEXT_BYTES = MAX_CHECKPOINT_PLAINTEXT_BYTES + 64;
const textEncoder = new TextEncoder();

type SealedHarnessCheckpointPayload = {
  body: Uint8Array;
  sha256: string;
};

export async function sealHarnessCheckpointPayload(input: {
  root: SecretsStoreSecret;
  organisationId: string;
  derivationInfo: string;
  additionalData: string;
  checkpoint: ArrayBuffer;
}): Promise<Result<SealedHarnessCheckpointPayload, HarnessCheckpointError>> {
  if (
    input.organisationId.length === 0 ||
    input.derivationInfo.length === 0 ||
    input.additionalData.length === 0 ||
    input.checkpoint.byteLength === 0
  ) {
    return { ok: false, error: { code: "checkpoint_invalid" } };
  }
  if (input.checkpoint.byteLength > MAX_CHECKPOINT_PLAINTEXT_BYTES) {
    return { ok: false, error: { code: "checkpoint_too_large" } };
  }

  const key = await derivePayloadKey(
    input.root,
    input.organisationId,
    input.derivationInfo,
  );
  if (!key.ok) return key;

  const plaintext = new Uint8Array(input.checkpoint);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", plaintext),
  );
  const iv = crypto.getRandomValues(new Uint8Array(CHECKPOINT_IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: textEncoder.encode(input.additionalData),
    },
    key.value,
    plaintext,
  );
  return {
    ok: true,
    value: {
      body: checkpointEnvelope(iv, new Uint8Array(encrypted)),
      sha256: encodeHex(digest),
    },
  };
}

export async function unsealHarnessCheckpointPayload(input: {
  root: SecretsStoreSecret;
  organisationId: string;
  derivationInfo: string;
  additionalData: string;
  expectedSha256: string;
  body: ArrayBuffer;
}): Promise<Result<ArrayBuffer, HarnessCheckpointError>> {
  if (
    input.organisationId.length === 0 ||
    input.derivationInfo.length === 0 ||
    input.additionalData.length === 0 ||
    !/^[0-9a-f]{64}$/.test(input.expectedSha256) ||
    input.body.byteLength > MAX_CHECKPOINT_CIPHERTEXT_BYTES
  ) {
    return { ok: false, error: { code: "checkpoint_invalid" } };
  }

  const envelope = parseCheckpointEnvelope(input.body);
  if (!envelope.ok) return envelope;
  const key = await derivePayloadKey(
    input.root,
    input.organisationId,
    input.derivationInfo,
  );
  if (!key.ok) return key;

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: envelope.value.iv,
        additionalData: textEncoder.encode(input.additionalData),
      },
      key.value,
      envelope.value.ciphertext,
    );
  } catch {
    return { ok: false, error: { code: "checkpoint_corrupt" } };
  }

  if (
    decrypted.byteLength === 0 ||
    decrypted.byteLength > MAX_CHECKPOINT_PLAINTEXT_BYTES
  ) {
    return { ok: false, error: { code: "checkpoint_corrupt" } };
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", decrypted),
  );
  return equalBytes(digest, decodeHex(input.expectedSha256))
    ? { ok: true, value: decrypted }
    : { ok: false, error: { code: "checkpoint_corrupt" } };
}

async function derivePayloadKey(
  root: SecretsStoreSecret,
  organisationId: string,
  derivationInfo: string,
): Promise<Result<CryptoKey, HarnessCheckpointError>> {
  let encodedRoot: string;

  try {
    encodedRoot = (await root.get()).trim();
  } catch {
    return { ok: false, error: { code: "checkpoint_root_unavailable" } };
  }

  const rawRoot = decodeBase64(encodedRoot);

  if (rawRoot === null || rawRoot.byteLength !== CHECKPOINT_ROOT_BYTES) {
    return { ok: false, error: { code: "checkpoint_root_invalid" } };
  }

  const material = await crypto.subtle.importKey(
    "raw",
    rawRoot,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(`${CHECKPOINT_CONTEXT}:${organisationId}`),
      info: textEncoder.encode(derivationInfo),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { ok: true, value: key };
}

function encodeHex(value: Uint8Array): string {
  return Array.from(value, function encodeByte(byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

function decodeHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function checkpointEnvelope(
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const body = new Uint8Array(
    CHECKPOINT_MAGIC.byteLength + iv.byteLength + ciphertext.byteLength,
  );
  body.set(CHECKPOINT_MAGIC, 0);
  body.set(iv, CHECKPOINT_MAGIC.byteLength);
  body.set(ciphertext, CHECKPOINT_MAGIC.byteLength + iv.byteLength);
  return body;
}

function parseCheckpointEnvelope(
  raw: ArrayBuffer,
): Result<{ iv: Uint8Array; ciphertext: Uint8Array }, HarnessCheckpointError> {
  const bytes = new Uint8Array(raw);
  const minimum = CHECKPOINT_MAGIC.byteLength + CHECKPOINT_IV_BYTES + 16;

  if (bytes.byteLength < minimum || !equalPrefix(bytes, CHECKPOINT_MAGIC)) {
    return { ok: false, error: { code: "checkpoint_corrupt" } };
  }

  return {
    ok: true,
    value: {
      iv: bytes.slice(
        CHECKPOINT_MAGIC.byteLength,
        CHECKPOINT_MAGIC.byteLength + CHECKPOINT_IV_BYTES,
      ),
      ciphertext: bytes.slice(
        CHECKPOINT_MAGIC.byteLength + CHECKPOINT_IV_BYTES,
      ),
    },
  };
}

function equalPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.byteLength < prefix.byteLength) {
    return false;
  }

  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (value[index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}

function equalBytes(left: Uint8Array, right: Uint8Array | null): boolean {
  if (right === null || left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}
