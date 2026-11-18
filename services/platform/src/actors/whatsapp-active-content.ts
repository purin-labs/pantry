import type { Result } from "../result";
import { decodeBase64, encodeBase64 } from "@seams/std";

/**
 * Application encryption for the temporary WhatsApp active envelope and
 * proposal bodies. The key is derived per organisation and phone-number account
 * from the deployment data-encryption root, and every ciphertext is bound by
 * AAD to its Case and its exact slot, so a row cannot be replayed into a
 * different Case, message, or proposal version.
 *
 * This is the only place WhatsApp customer text is turned into bytes at rest.
 * Deleting the row deletes the content; there is no second copy.
 */

export type WhatsAppContentSlot =
  | { readonly kind: "message"; readonly providerMessageId: string }
  | {
      readonly kind: "proposal";
      readonly proposalId: string;
      readonly version: number;
    };

export type WhatsAppSealedContent = {
  readonly nonceB64: string;
  readonly ciphertextB64: string;
  readonly bytes: number;
};

export type WhatsAppContentError = {
  readonly code:
    "whatsapp_content_root_unavailable" | "whatsapp_content_undecryptable";
};

export type WhatsAppContentCipher = {
  seal(
    caseId: string,
    slot: WhatsAppContentSlot,
    plaintext: string,
  ): Promise<WhatsAppSealedContent>;
  open(
    caseId: string,
    slot: WhatsAppContentSlot,
    sealed: Readonly<{ nonceB64: string; ciphertextB64: string }>,
  ): Promise<Result<string, WhatsAppContentError>>;
  /**
   * A keyed digest of message text, for the durable metadata record. A bare
   * SHA-256 of a short customer message is trivially recoverable by guessing,
   * so the durable record would become a way back to content the envelope
   * had already deleted. Plan 32 asks for keyed digests for exactly this.
   */
  digest(plaintext: string): Promise<string>;
};

const CONTEXT = "satyr-whatsapp-active-content-v1";
const IV_BYTES = 12;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function createWhatsAppContentCipher(
  input: Readonly<{
    root: SecretsStoreSecret;
    organisationId: string;
    integrationAccountId: string;
  }>,
): Promise<Result<WhatsAppContentCipher, WhatsAppContentError>> {
  let encodedRoot: string;
  try {
    encodedRoot = (await input.root.get()).trim();
  } catch {
    return { ok: false, error: { code: "whatsapp_content_root_unavailable" } };
  }
  const rawRoot = decodeBase64(encodedRoot);
  if (rawRoot === null || rawRoot.byteLength === 0) {
    return { ok: false, error: { code: "whatsapp_content_root_unavailable" } };
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
  const aad = (caseId: string, slot: WhatsAppContentSlot): Uint8Array =>
    textEncoder.encode(
      `${CONTEXT}:${input.organisationId}:${input.integrationAccountId}:${caseId}:${slotLabel(slot)}`,
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
            error: { code: "whatsapp_content_undecryptable" },
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
            error: { code: "whatsapp_content_undecryptable" },
          };
        }
      },
    },
  };
}

function slotLabel(slot: WhatsAppContentSlot): string {
  return slot.kind === "message"
    ? `message:${slot.providerMessageId}`
    : `proposal:${slot.proposalId}:${slot.version}`;
}
