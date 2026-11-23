/**
 * Sanitized WhatsApp webhook fixtures captured from Meta's development app
 * and rewritten with synthetic identifiers and synthetic customer text. No
 * real customer, business, WABA, or phone-number value appears here, and no
 * secret value is embedded: signatures are computed from a fixture-only app
 * secret at test time.
 */

export const FIXTURE_WABA_ID = "102290129340398";
export const FIXTURE_PHONE_NUMBER_ID = "106540352242922";
export const FIXTURE_DISPLAY_PHONE_NUMBER = "+15550001111";
export const FIXTURE_CUSTOMER_WA_ID = "15550002222";
export const FIXTURE_APP_SECRET = "fixture-app-secret-not-a-real-credential";
export const FIXTURE_VERIFY_TOKEN =
  "fixture-verify-token-not-a-real-credential";

export type TextMessageFixtureInput = {
  readonly providerMessageId?: string;
  readonly body?: string;
  readonly timestampSeconds?: number;
  readonly customerWaId?: string;
  readonly wabaId?: string;
  readonly phoneNumberId?: string;
};

export function textMessagePayload(
  input: TextMessageFixtureInput = {},
): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId ?? FIXTURE_WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: FIXTURE_DISPLAY_PHONE_NUMBER,
                phone_number_id: input.phoneNumberId ?? FIXTURE_PHONE_NUMBER_ID,
              },
              contacts: [
                {
                  profile: { name: "Synthetic Customer" },
                  wa_id: input.customerWaId ?? FIXTURE_CUSTOMER_WA_ID,
                },
              ],
              messages: [
                {
                  from: input.customerWaId ?? FIXTURE_CUSTOMER_WA_ID,
                  id: input.providerMessageId ?? "wamid.TEST0001",
                  timestamp: String(input.timestampSeconds ?? 1_784_016_000),
                  type: "text",
                  text: { body: input.body ?? "Is the bakery open on Sunday?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function unsupportedMessagePayload(
  input: {
    readonly messageType?: string;
    readonly providerMessageId?: string;
  } = {},
): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: FIXTURE_WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: FIXTURE_DISPLAY_PHONE_NUMBER,
                phone_number_id: FIXTURE_PHONE_NUMBER_ID,
              },
              messages: [
                {
                  from: FIXTURE_CUSTOMER_WA_ID,
                  id: input.providerMessageId ?? "wamid.TESTIMAGE1",
                  timestamp: "1784016100",
                  type: input.messageType ?? "image",
                  image: {
                    id: "media-id",
                    mime_type: "image/jpeg",
                    sha256: "digest",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload(
  input: {
    readonly whatsappMessageId?: string;
    readonly status?: "sent" | "delivered" | "read" | "failed";
    readonly timestampSeconds?: number;
    readonly errorCode?: number;
  } = {},
): unknown {
  const status = input.status ?? "delivered";
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: FIXTURE_WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: FIXTURE_DISPLAY_PHONE_NUMBER,
                phone_number_id: FIXTURE_PHONE_NUMBER_ID,
              },
              statuses: [
                {
                  id: input.whatsappMessageId ?? "wamid.TESTOUT0001",
                  status,
                  timestamp: String(input.timestampSeconds ?? 1_784_016_200),
                  recipient_id: FIXTURE_CUSTOMER_WA_ID,
                  conversation: { id: "conv-1", origin: { type: "service" } },
                  pricing: { billable: false, category: "service" },
                  ...(status === "failed"
                    ? {
                        errors: [
                          {
                            code: input.errorCode ?? 131_047,
                            title: "Re-engagement message",
                            message: "Message failed to send.",
                          },
                        ],
                      }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** A payload whose envelope is intact but whose message shape is unusable. */
export function malformedMessagePayload(): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: FIXTURE_WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: FIXTURE_DISPLAY_PHONE_NUMBER,
                phone_number_id: FIXTURE_PHONE_NUMBER_ID,
              },
              messages: [
                {
                  from: FIXTURE_CUSTOMER_WA_ID,
                  id: "not-a-wamid",
                  timestamp: "x",
                  type: "text",
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function canonicalBody(payload: unknown): string {
  return JSON.stringify(payload);
}

export async function signFixtureBody(
  rawBody: string,
  appSecret: string = FIXTURE_APP_SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256=${hex}`;
}

/** A signature that is well-formed but produced by the wrong secret. */
export function invalidSignature(): string {
  return `sha256=${"0".repeat(64)}`;
}
