import type { SecretsStoreSecret } from "@cloudflare/workers-types";

import type { Result } from "../result";
import { decodeBase64, encodeBase64 } from "@seams/std";

/**
 * Short-lived application encryption for send-only operational proposals.
 * The proposal row stores only ciphertext and keyed digests; the Case and
 * provider projections never receive the subject or body.
 */
export type EmailContentSlot = Readonly<{
  readonly proposalId: string;
  readonly version: number;
}>;

export type EmailSealedContent = Readonly<{
  readonly nonceB64: string;
  readonly ciphertextB64: string;
  readonly bytes: number;
}>;

export type EmailContentError = Readonly<{
  readonly code:
    | "email_content_root_unavailable"
    | "email_content_undecryptable";
}>;

export type EmailContentCipher = Readonly<{
  seal(
    caseId: string,
    slot: EmailContentSlot,
    plaintext: string,
  ): Promise<EmailSealedContent>;
  open(
    caseId: string,
    slot: EmailContentSlot,
    sealed: Readonly<{
      readonly nonceB64: string;
      readonly ciphertextB64: string;
    }>,
  ): Promise<Result<string, EmailContentError>>;
  digest(plaintext: string): Promise<string>;
}>;

const CONTEXT = "satyr-email-operational-content-v1";
const IV_BYTES = 12;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function createEmailContentCipher(
  input: Readonly<{
    readonly root: SecretsStoreSecret;
    readonly organisationId: string;
    readonly integrationAccountId: string;
  }>,
): Promise<Result<EmailContentCipher, EmailContentError>> {
  let encodedRoot: string;
  try {
    encodedRoot = (await input.root.get()).trim();
  } catch {
    return { ok: false, error: { code: "email_content_root_unavailable" } };
  }
  const rawRoot = decodeBase64(encodedRoot);
  if (rawRoot === null || rawRoot.byteLength === 0) {
    return { ok: false, error: { code: "email_content_root_unavailable" } };
  }
  const material = await crypto.subtle.importKey(
    "raw",
    rawRoot,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const digestKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(`${CONTEXT}:digest:${input.organisationId}`),
      info: textEncoder.encode(input.integrationAccountId),
    },
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(`${CONTEXT}:${input.organisationId}`),
      info: textEncoder.encode(input.integrationAccountId),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const aad = (caseId: string, slot: EmailContentSlot): Uint8Array =>
    textEncoder.encode(
      `${CONTEXT}:${input.organisationId}:${input.integrationAccountId}:${caseId}:${slot.proposalId}:${slot.version}`,
    );
  return {
    ok: true,
    value: {
      async seal(caseId, slot, plaintext) {
        const bytes = textEncoder.encode(plaintext);
        const nonce = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aad(caseId, slot) },
          key,
          bytes,
        );
        return {
          nonceB64: encodeBase64(nonce),
          ciphertextB64: encodeBase64(new Uint8Array(ciphertext)),
          bytes: bytes.byteLength,
        };
      },
      async open(caseId, slot, sealed) {
        const nonce = decodeBase64(sealed.nonceB64);
        const ciphertext = decodeBase64(sealed.ciphertextB64);
        if (
          nonce === null ||
          ciphertext === null ||
          nonce.byteLength !== IV_BYTES
        ) {
          return {
            ok: false,
            error: { code: "email_content_undecryptable" },
          };
        }
        try {
          const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce, additionalData: aad(caseId, slot) },
            key,
            ciphertext,
          );
          return { ok: true, value: textDecoder.decode(plaintext) };
        } catch {
          return {
            ok: false,
            error: { code: "email_content_undecryptable" },
          };
        }
      },
      async digest(plaintext) {
        const signature = await crypto.subtle.sign(
          "HMAC",
          digestKey,
          textEncoder.encode(plaintext),
        );
        return Array.from(new Uint8Array(signature), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      },
    },
  };
}
