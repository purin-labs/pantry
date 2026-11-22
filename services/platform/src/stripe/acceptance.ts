import type { Result } from "@purin-labs/kernel/result";
import type { VaultSecret } from "../credential-vault";
import { isRecord } from "@purin-labs/std";

type StripeFailedChargeTrigger = {
  kind: "charge_failed_triggered";
  provider: "stripe";
  errorCode: "card_declined";
  declineCode: string;
  chargeId: string | null;
  requestId: string | null;
};

export type StripeFailedChargeTriggerError =
  | { code: "stripe_test_credential_invalid" }
  | { code: "stripe_test_failure_transport" }
  | { code: "stripe_test_failure_response_invalid" };

export async function triggerStripeFailedCharge(input: {
  credential: VaultSecret;
  fetcher: typeof fetch;
}): Promise<Result<StripeFailedChargeTrigger, StripeFailedChargeTriggerError>> {
  const key = readStripeTestKey(input.credential);

  if (!key.ok) {
    return key;
  }

  const body = new URLSearchParams();
  body.set("amount", "100");
  body.set("currency", "usd");
  body.set("payment_method", "pm_card_visa_chargeDeclined");
  body.append("payment_method_types[]", "card");
  body.set("confirm", "true");
  body.set("description", "Pantry M8 charge.failed acceptance");
  let response: Response;

  try {
    const fetcher = input.fetcher;
    response = await fetcher("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.value}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    return { ok: false, error: { code: "stripe_test_failure_transport" } };
  }

  const raw = await readJsonObject(response);
  const providerError = raw !== null && isRecord(raw.error) ? raw.error : null;

  if (
    response.ok ||
    providerError === null ||
    providerError.code !== "card_declined" ||
    typeof providerError.decline_code !== "string"
  ) {
    console.error("stripe.test_failure_response_invalid", {
      status: response.status,
      requestId: response.headers.get("request-id"),
      errorType: nullableString(providerError?.type),
      errorCode: nullableString(providerError?.code),
      declineCode: nullableString(providerError?.decline_code),
    });
    return {
      ok: false,
      error: { code: "stripe_test_failure_response_invalid" },
    };
  }

  return {
    ok: true,
    value: {
      kind: "charge_failed_triggered",
      provider: "stripe",
      errorCode: "card_declined",
      declineCode: providerError.decline_code,
      chargeId:
        typeof providerError.charge === "string" ? providerError.charge : null,
      requestId: response.headers.get("request-id"),
    },
  };
}

function readStripeTestKey(
  credential: VaultSecret,
): Result<string, StripeFailedChargeTriggerError> {
  return credential.kind === "bearer" && credential.value.startsWith("sk_test_")
    ? { ok: true, value: credential.value }
    : { ok: false, error: { code: "stripe_test_credential_invalid" } };
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = await response.json();
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
