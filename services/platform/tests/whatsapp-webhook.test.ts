import { describe, expect, it } from "vitest";

import {
  parseWhatsAppWebhookBody,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
} from "../src/whatsapp/webhook";
import {
  FIXTURE_APP_SECRET,
  FIXTURE_CUSTOMER_WA_ID,
  FIXTURE_PHONE_NUMBER_ID,
  FIXTURE_VERIFY_TOKEN,
  FIXTURE_WABA_ID,
  canonicalBody,
  invalidSignature,
  malformedMessagePayload,
  signFixtureBody,
  statusPayload,
  textMessagePayload,
  unsupportedMessagePayload,
} from "./whatsapp/fixtures";

describe("whatsapp webhook boundary", whatsappWebhookSuite);

function whatsappWebhookSuite(): void {
  it(
    "echoes the challenge only for the exact mode and verify token",
    challengeTest,
  );
  it(
    "accepts a signature over the exact bytes and rejects everything else",
    signatureTest,
  );
  it("parses text messages into the closed event union", textParseTest);
  it("records non-text messages content-free", unsupportedParseTest);
  it(
    "parses delivery statuses including the failure code only",
    statusParseTest,
  );
  it("rejects malformed payloads at the boundary", malformedParseTest);
  it(
    "ignores changes for fields this version does not handle",
    unrelatedFieldTest,
  );
}

function challengeTest(): void {
  const ok = verifyWhatsAppWebhookChallenge({
    url: new URL(
      `https://edge.test/hook/whatsapp?hub.mode=subscribe&hub.verify_token=${FIXTURE_VERIFY_TOKEN}&hub.challenge=12345`,
    ),
    verifyToken: FIXTURE_VERIFY_TOKEN,
  });
  expect(ok.ok && ok.value.challenge).toBe("12345");

  const wrongToken = verifyWhatsAppWebhookChallenge({
    url: new URL(
      "https://edge.test/hook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345",
    ),
    verifyToken: FIXTURE_VERIFY_TOKEN,
  });
  expect(!wrongToken.ok && wrongToken.error.code).toBe(
    "whatsapp_challenge_token_invalid",
  );

  const wrongMode = verifyWhatsAppWebhookChallenge({
    url: new URL(
      `https://edge.test/hook/whatsapp?hub.mode=unsubscribe&hub.verify_token=${FIXTURE_VERIFY_TOKEN}&hub.challenge=1`,
    ),
    verifyToken: FIXTURE_VERIFY_TOKEN,
  });
  expect(!wrongMode.ok && wrongMode.error.code).toBe(
    "whatsapp_challenge_mode_invalid",
  );

  const unconfigured = verifyWhatsAppWebhookChallenge({
    url: new URL("https://edge.test/hook/whatsapp?hub.mode=subscribe"),
    verifyToken: undefined,
  });
  expect(!unconfigured.ok && unconfigured.error.code).toBe(
    "whatsapp_verify_token_missing",
  );
}

async function signatureTest(): Promise<void> {
  const rawBody = canonicalBody(textMessagePayload());
  const signature = await signFixtureBody(rawBody);
  const accepted = await verifyWhatsAppWebhookSignature({
    rawBody,
    signatureHeader: signature,
    appSecret: FIXTURE_APP_SECRET,
  });
  expect(accepted.ok).toBe(true);

  const wrongSecret = await verifyWhatsAppWebhookSignature({
    rawBody,
    signatureHeader: signature,
    appSecret: "another-secret",
  });
  expect(!wrongSecret.ok && wrongSecret.error.code).toBe(
    "whatsapp_signature_invalid",
  );

  const mutatedBody = await verifyWhatsAppWebhookSignature({
    rawBody: `${rawBody} `,
    signatureHeader: signature,
    appSecret: FIXTURE_APP_SECRET,
  });
  expect(!mutatedBody.ok && mutatedBody.error.code).toBe(
    "whatsapp_signature_invalid",
  );

  const wrongDigest = await verifyWhatsAppWebhookSignature({
    rawBody,
    signatureHeader: invalidSignature(),
    appSecret: FIXTURE_APP_SECRET,
  });
  expect(!wrongDigest.ok && wrongDigest.error.code).toBe(
    "whatsapp_signature_invalid",
  );

  const missing = await verifyWhatsAppWebhookSignature({
    rawBody,
    signatureHeader: null,
    appSecret: FIXTURE_APP_SECRET,
  });
  expect(!missing.ok && missing.error.code).toBe("whatsapp_signature_missing");

  const malformed = await verifyWhatsAppWebhookSignature({
    rawBody,
    signatureHeader: "sha1=abc",
    appSecret: FIXTURE_APP_SECRET,
  });
  expect(!malformed.ok && malformed.error.code).toBe(
    "whatsapp_signature_malformed",
  );

  const unconfigured = await verifyWhatsAppWebhookSignature({
    rawBody,
    signatureHeader: signature,
    appSecret: undefined,
  });
  expect(!unconfigured.ok && unconfigured.error.code).toBe(
    "whatsapp_app_secret_missing",
  );
}

function textParseTest(): void {
  const parsed = parseWhatsAppWebhookBody(
    textMessagePayload({
      providerMessageId: "wamid.ONE",
      body: "Do you have sourdough today?",
      timestampSeconds: 1_784_016_000,
    }),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toEqual([
    {
      kind: "text_message",
      wabaId: FIXTURE_WABA_ID,
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
      displayPhoneNumber: "+15550001111",
      customerWaId: FIXTURE_CUSTOMER_WA_ID,
      providerMessageId: "wamid.ONE",
      providerTimestamp: 1_784_016_000_000,
      body: "Do you have sourdough today?",
    },
  ]);
}

function unsupportedParseTest(): void {
  const parsed = parseWhatsAppWebhookBody(
    unsupportedMessagePayload({ messageType: "image" }),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const [event] = parsed.value;
  expect(event?.kind).toBe("unsupported_message");
  expect(JSON.stringify(event)).not.toContain("media-id");
  expect(JSON.stringify(event)).not.toContain("image/jpeg");
}

function statusParseTest(): void {
  const delivered = parseWhatsAppWebhookBody(
    statusPayload({ status: "delivered" }),
  );
  expect(delivered.ok && delivered.value[0]).toEqual({
    kind: "status",
    wabaId: FIXTURE_WABA_ID,
    phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
    whatsappMessageId: "wamid.TESTOUT0001",
    recipientWaId: FIXTURE_CUSTOMER_WA_ID,
    status: "delivered",
    statusAt: 1_784_016_200_000,
    failureCode: null,
  });

  const failed = parseWhatsAppWebhookBody(
    statusPayload({ status: "failed", errorCode: 131_047 }),
  );
  expect(failed.ok).toBe(true);
  if (!failed.ok) return;
  const event = failed.value[0];
  expect(event?.kind === "status" && event.failureCode).toBe("131047");
  expect(JSON.stringify(event)).not.toContain("Re-engagement");
}

function malformedParseTest(): void {
  const parsed = parseWhatsAppWebhookBody(malformedMessagePayload());
  expect(!parsed.ok && parsed.error.code).toBe("whatsapp_webhook_unparseable");

  const wrongObject = parseWhatsAppWebhookBody({ object: "page", entry: [] });
  expect(!wrongObject.ok && wrongObject.error.field).toBe("object");

  expect(parseWhatsAppWebhookBody("not-json-object").ok).toBe(false);
}

function unrelatedFieldTest(): void {
  const parsed = parseWhatsAppWebhookBody({
    object: "whatsapp_business_account",
    entry: [
      {
        id: FIXTURE_WABA_ID,
        changes: [
          { field: "account_update", value: { event: "PARTNER_ADDED" } },
        ],
      },
    ],
  });
  expect(parsed.ok && parsed.value).toEqual([]);
}
