import type { Result } from "@purin-labs/kernel/result";
import { decodeCanonicalBase64 } from "@purin-labs/std";

declare const nearAccountIdBrand: unique symbol;
declare const nearEd25519PublicKeyBrand: unique symbol;
declare const seamsIdentityIdBrand: unique symbol;

type NearAccountId = string & {
  readonly [nearAccountIdBrand]: "NearAccountId";
};
export type NearEd25519PublicKey = string & {
  readonly [nearEd25519PublicKeyBrand]: "NearEd25519PublicKey";
};
export type SeamsIdentityId = string & {
  readonly [seamsIdentityIdBrand]: "SeamsIdentityId";
};

type Nep413Proof = {
  accountId: NearAccountId;
  publicKey: NearEd25519PublicKey;
  signature: string;
  nonce: string;
  state: string;
};

type VerifiedSeamsIdentity = {
  id: SeamsIdentityId;
  accountId: NearAccountId;
  publicKey: NearEd25519PublicKey;
};

type Nep413ProofError =
  | { code: "invalid_account_id" }
  | { code: "invalid_public_key" }
  | { code: "invalid_signature" }
  | { code: "invalid_nonce" }
  | { code: "invalid_state" }
  | { code: "signature_mismatch" };

type RawNep413Proof = {
  accountId: unknown;
  publicKey: unknown;
  signature: unknown;
  nonce: unknown;
  state: unknown;
};

export type Nep413Challenge = {
  message: string;
  recipient: string;
  state: string;
};

const NEP413_PREFIX = 2_147_484_061;
const ED25519_PUBLIC_KEY_PREFIX = "ed25519:";
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  Array.from(BASE58_ALPHABET, buildBase58IndexEntry),
);
const MAX_CHALLENGE_TEXT_BYTES = 16 * 1024;

export function parseNep413Proof(
  raw: RawNep413Proof,
): Result<Nep413Proof, Nep413ProofError> {
  const accountId = parseNearAccountId(raw.accountId);

  if (accountId === null) {
    return { ok: false, error: { code: "invalid_account_id" } };
  }

  const publicKey = parseNearEd25519PublicKey(raw.publicKey);

  if (publicKey === null) {
    return { ok: false, error: { code: "invalid_public_key" } };
  }

  const signature = parseBase64Field(raw.signature, 64);

  if (signature === null) {
    return { ok: false, error: { code: "invalid_signature" } };
  }

  const nonce = parseBase64Field(raw.nonce, 32);

  if (nonce === null) {
    return { ok: false, error: { code: "invalid_nonce" } };
  }

  if (typeof raw.state !== "string" || raw.state.length === 0) {
    return { ok: false, error: { code: "invalid_state" } };
  }

  return {
    ok: true,
    value: {
      accountId,
      publicKey,
      signature,
      nonce,
      state: raw.state,
    },
  };
}

export async function verifyNep413Proof(
  challenge: Nep413Challenge,
  proof: Nep413Proof,
): Promise<Result<VerifiedSeamsIdentity, Nep413ProofError>> {
  if (proof.state !== challenge.state) {
    return { ok: false, error: { code: "invalid_state" } };
  }

  const publicKeyBytes = decodeNearPublicKey(proof.publicKey);
  const signatureBytes = decodeCanonicalBase64(proof.signature);
  const nonceBytes = decodeCanonicalBase64(proof.nonce);

  if (publicKeyBytes === null) {
    return { ok: false, error: { code: "invalid_public_key" } };
  }

  if (signatureBytes === null || signatureBytes.byteLength !== 64) {
    return { ok: false, error: { code: "invalid_signature" } };
  }

  if (nonceBytes === null || nonceBytes.byteLength !== 32) {
    return { ok: false, error: { code: "invalid_nonce" } };
  }

  const digest = await buildNep413Digest(challenge, nonceBytes);
  const valid = await verifyEd25519(publicKeyBytes, signatureBytes, digest);

  if (!valid) {
    return { ok: false, error: { code: "signature_mismatch" } };
  }

  return {
    ok: true,
    value: {
      id: buildSeamsIdentityId(proof.accountId, proof.publicKey),
      accountId: proof.accountId,
      publicKey: proof.publicKey,
    },
  };
}

async function verifyEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey,
      "Ed25519",
      false,
      ["verify"],
    );
    return crypto.subtle.verify("Ed25519", key, signature, message);
  } catch {
    return false;
  }
}

export async function buildNep413Digest(
  challenge: Nep413Challenge,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.byteLength !== 32) {
    throw new Error("NEP-413 nonce must contain 32 bytes");
  }

  const message = encodeBoundedText(challenge.message);
  const recipient = encodeBoundedText(challenge.recipient);
  const state = encodeBoundedText(challenge.state);
  const payload = concatenateBytes([
    encodeU32LittleEndian(NEP413_PREFIX),
    encodeBorshString(message),
    encodeBorshString(recipient),
    nonce,
    new Uint8Array([1]),
    encodeBorshString(state),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return new Uint8Array(digest);
}

function parseNearAccountId(raw: unknown): NearAccountId | null {
  if (typeof raw !== "string") {
    return null;
  }

  const value = raw.trim();
  const validLength = value.length >= 2 && value.length <= 64;
  const validShape = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
  return validLength && validShape ? (value as NearAccountId) : null;
}

function parseNearEd25519PublicKey(raw: unknown): NearEd25519PublicKey | null {
  if (typeof raw !== "string" || !raw.startsWith(ED25519_PUBLIC_KEY_PREFIX)) {
    return null;
  }

  const bytes = decodeNearPublicKey(raw);
  return bytes?.byteLength === 32 ? (raw as NearEd25519PublicKey) : null;
}

function parseBase64Field(raw: unknown, expectedBytes: number): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) {
    return null;
  }

  const decoded = decodeCanonicalBase64(raw);
  return decoded?.byteLength === expectedBytes ? raw : null;
}

function decodeNearPublicKey(publicKey: string): Uint8Array | null {
  if (!publicKey.startsWith(ED25519_PUBLIC_KEY_PREFIX)) {
    return null;
  }

  const decoded = decodeBase58(
    publicKey.slice(ED25519_PUBLIC_KEY_PREFIX.length),
  );
  return decoded?.byteLength === 32 ? decoded : null;
}

function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) {
    return null;
  }

  const bytes = [0];

  for (const character of value) {
    const digit = BASE58_INDEX.get(character);

    if (digit === undefined) {
      return null;
    }

    let carry = digit;

    for (let index = 0; index < bytes.length; index += 1) {
      const next = (bytes[index] ?? 0) * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (
    let index = 0;
    index < value.length - 1 && value[index] === "1";
    index += 1
  ) {
    bytes.push(0);
  }

  bytes.reverse();
  return new Uint8Array(bytes);
}

function buildSeamsIdentityId(
  accountId: NearAccountId,
  publicKey: NearEd25519PublicKey,
): SeamsIdentityId {
  const key = publicKey.slice(ED25519_PUBLIC_KEY_PREFIX.length);
  return `seams:near:${accountId}:${key}` as SeamsIdentityId;
}

function encodeBoundedText(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHALLENGE_TEXT_BYTES) {
    throw new Error("NEP-413 challenge text is outside the accepted bounds");
  }

  return bytes;
}

function encodeBorshString(value: Uint8Array): Uint8Array {
  return concatenateBytes([encodeU32LittleEndian(value.byteLength), value]);
}

function encodeU32LittleEndian(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce(sumByteLengths, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}

function sumByteLengths(total: number, value: Uint8Array): number {
  return total + value.byteLength;
}

function buildBase58IndexEntry(
  character: string,
  index: number,
): readonly [string, number] {
  return [character, index] as const;
}
