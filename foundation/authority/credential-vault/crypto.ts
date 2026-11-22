import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { VaultHandle } from "./domain";
import type { VaultKeyVersion } from "./keyring";
import { decodeBase64, encodeBase64 } from "@purin-labs/std";

export type VaultCiphertext = {
  readonly nonceB64: string;
  readonly ciphertextB64: string;
};

const AES_GCM_IV_LENGTH = 12;
const textEncoder = new TextEncoder();

export async function encryptVaultPayload(input: {
  readonly key: CryptoKey;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly keyVersion: VaultKeyVersion;
  readonly plaintext: Uint8Array;
}): Promise<VaultCiphertext> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: vaultAad(
        input.organisationId,
        input.handle,
        input.keyVersion,
      ),
    },
    input.key,
    input.plaintext,
  );

  return {
    nonceB64: encodeBase64(nonce),
    ciphertextB64: encodeBase64(new Uint8Array(encrypted)),
  };
}

export async function decryptVaultPayload(input: {
  readonly key: CryptoKey;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly keyVersion: VaultKeyVersion;
  readonly nonceB64: string;
  readonly ciphertextB64: string;
}): Promise<Result<Uint8Array, { readonly code: "vault_ciphertext_invalid" }>> {
  const nonce = parseBase64(input.nonceB64);
  const ciphertext = parseBase64(input.ciphertextB64);

  if (
    !nonce.ok ||
    !ciphertext.ok ||
    nonce.value.byteLength !== AES_GCM_IV_LENGTH
  ) {
    return { ok: false, error: { code: "vault_ciphertext_invalid" } };
  }

  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce.value,
        additionalData: vaultAad(
          input.organisationId,
          input.handle,
          input.keyVersion,
        ),
      },
      input.key,
      ciphertext.value,
    );

    return { ok: true, value: new Uint8Array(decrypted) };
  } catch {
    return { ok: false, error: { code: "vault_ciphertext_invalid" } };
  }
}

export function vaultPayloadsEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

function vaultAad(
  organisationId: OrganisationId,
  handle: VaultHandle,
  keyVersion: VaultKeyVersion,
): Uint8Array {
  return textEncoder.encode(`${organisationId}:${handle}:${keyVersion}`);
}

/** Standard base64, as a Result for the vault's parsers. */
export function parseBase64(
  value: string,
): Result<Uint8Array, { readonly code: "invalid_base64" }> {
  const bytes = decodeBase64(value);
  return bytes === null
    ? { ok: false, error: { code: "invalid_base64" } }
    : { ok: true, value: bytes };
}
