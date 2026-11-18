import { createHash } from "node:crypto";

import type {
  CommerceBuyerContactV1,
  CommerceProtectedBuyerContactV1,
} from "@seams/commerce-client";
import { assertNever } from "@seams/std";

export function protectBuyerContact(
  input: Readonly<{
    merchantId: string;
    sessionId: string;
    contact: CommerceBuyerContactV1;
  }>,
): CommerceProtectedBuyerContactV1 {
  switch (input.contact.kind) {
    case "email":
      return {
        kind: "email",
        emailDigest: buyerContactDigest(input, "email", input.contact.email),
      };
    case "email_and_phone":
      return {
        kind: "email_and_phone",
        emailDigest: buyerContactDigest(input, "email", input.contact.email),
        phoneDigest: buyerContactDigest(input, "phone", input.contact.phone),
      };
    default:
      return assertNever(input.contact, "Unsupported buyer contact");
  }
}

function buyerContactDigest(
  input: Readonly<{ merchantId: string; sessionId: string }>,
  field: "email" | "phone",
  value: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([input.merchantId, input.sessionId, field, value]))
    .digest("hex");
}
