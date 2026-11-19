import type {
  CheckoutPaymentProviderBinding,
  InPersonPaymentBinding,
  OnlinePaymentBinding,
} from "./commerce-domain";
import type {
  GmoSteraTransport,
  PaymentEnvironment,
  PaymentProviderAccountBinding,
  SquareTerminalTransport,
} from "./records/commerce-records.ts";
import { hasExactKeys, isRecord } from "@purin-labs/std";

const IDENTITY_MAX_LENGTH = 255;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

export type PaymentBindingParseError = Readonly<{
  code: "payment_binding_invalid";
  field: string;
}>;

type PaymentBindingParseResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; error: PaymentBindingParseError }>;

export function parseCheckoutPaymentProviderBinding(
  raw: unknown,
): PaymentBindingParseResult<CheckoutPaymentProviderBinding> {
  if (!isRecord(raw)) return invalidBinding("binding");
  const provider = readText(raw.provider, "binding.provider");
  if (!provider.ok) return provider;
  switch (provider.value) {
    case "stripe_online":
    case "gmo_pg_online":
    case "square_online":
      return parseOnlinePaymentBinding(raw);
    case "square_terminal":
    case "gmo_stera":
      return parseInPersonPaymentBinding(raw);
    default:
      return invalidBinding("binding.provider");
  }
}

export function isOnlinePaymentBinding(
  binding: CheckoutPaymentProviderBinding,
): binding is OnlinePaymentBinding {
  return binding.provider.endsWith("_online");
}

export function parseOnlinePaymentBinding(
  raw: unknown,
): PaymentBindingParseResult<OnlinePaymentBinding> {
  if (!isRecord(raw)) return invalidBinding("binding");
  const provider = readText(raw.provider, "binding.provider");
  if (!provider.ok) return provider;
  const account = parsePaymentProviderAccountBinding(raw.account);
  if (!account.ok) return account;
  switch (provider.value) {
    case "stripe_online": {
      if (!hasExactKeys(raw, ["provider", "account", "collection"])) {
        return invalidBinding("binding");
      }
      const collection = readEnum(raw.collection, "binding.collection", [
        "embedded_tokenization",
        "hosted_redirect",
      ]);
      return collection.ok
        ? {
            ok: true,
            value: {
              provider: provider.value,
              account: account.value,
              collection: collection.value,
            },
          }
        : collection;
    }
    case "gmo_pg_online": {
      if (!hasExactKeys(raw, ["provider", "account", "collection"])) {
        return invalidBinding("binding");
      }
      const collection = readEnum(raw.collection, "binding.collection", [
        "embedded_tokenization",
        "hosted_redirect",
      ]);
      return collection.ok
        ? {
            ok: true,
            value: {
              provider: provider.value,
              account: account.value,
              collection: collection.value,
            },
          }
        : collection;
    }
    case "square_online": {
      if (
        !hasExactKeys(raw, [
          "provider",
          "account",
          "applicationId",
          "locationId",
        ])
      ) {
        return invalidBinding("binding");
      }
      const applicationId = readText(
        raw.applicationId,
        "binding.applicationId",
      );
      if (!applicationId.ok) return applicationId;
      const locationId = readText(raw.locationId, "binding.locationId");
      return locationId.ok
        ? {
            ok: true,
            value: {
              provider: provider.value,
              account: account.value,
              applicationId: applicationId.value,
              locationId: locationId.value,
            },
          }
        : locationId;
    }
    default:
      return invalidBinding("binding.provider");
  }
}

export function parseInPersonPaymentBinding(
  raw: unknown,
): PaymentBindingParseResult<InPersonPaymentBinding> {
  if (!isRecord(raw)) return invalidBinding("binding");
  const provider = readText(raw.provider, "binding.provider");
  if (!provider.ok) return provider;
  const account = parsePaymentProviderAccountBinding(raw.account);
  if (!account.ok) return account;
  const locationId = readText(raw.locationId, "binding.locationId");
  if (!locationId.ok) return locationId;
  switch (provider.value) {
    case "square_terminal": {
      if (
        !hasExactKeys(raw, [
          "provider",
          "account",
          "locationId",
          "deviceId",
          "transport",
        ])
      ) {
        return invalidBinding("binding");
      }
      const deviceId = readText(raw.deviceId, "binding.deviceId");
      if (!deviceId.ok) return deviceId;
      const transport = readEnum(raw.transport, "binding.transport", [
        "server_terminal",
      ] satisfies readonly SquareTerminalTransport[]);
      return transport.ok
        ? {
            ok: true,
            value: {
              provider: provider.value,
              account: account.value,
              locationId: locationId.value,
              deviceId: deviceId.value,
              transport: transport.value,
            },
          }
        : transport;
    }
    case "gmo_stera": {
      if (
        !hasExactKeys(raw, [
          "provider",
          "account",
          "locationId",
          "gatewayId",
          "deviceSourceKey",
          "transport",
        ])
      ) {
        return invalidBinding("binding");
      }
      const gatewayId = readText(raw.gatewayId, "binding.gatewayId");
      if (!gatewayId.ok) return gatewayId;
      const deviceSourceKey = readText(
        raw.deviceSourceKey,
        "binding.deviceSourceKey",
      );
      if (!deviceSourceKey.ok) return deviceSourceKey;
      const transport = readEnum(raw.transport, "binding.transport", [
        "lan_gateway",
      ] satisfies readonly GmoSteraTransport[]);
      return transport.ok
        ? {
            ok: true,
            value: {
              provider: provider.value,
              account: account.value,
              locationId: locationId.value,
              gatewayId: gatewayId.value,
              deviceSourceKey: deviceSourceKey.value,
              transport: transport.value,
            },
          }
        : transport;
    }
    default:
      return invalidBinding("binding.provider");
  }
}

export function parsePaymentProviderAccountBinding(
  raw: unknown,
): PaymentBindingParseResult<PaymentProviderAccountBinding> {
  if (!isRecord(raw)) return invalidBinding("binding.account");
  if (
    !hasExactKeys(raw, [
      "integrationAccountId",
      "providerAccountId",
      "environment",
      "capabilityRevision",
      "country",
      "currency",
    ])
  )
    return invalidBinding("binding.account");
  const integrationAccountId = readText(
    raw.integrationAccountId,
    "binding.account.integrationAccountId",
  );
  if (!integrationAccountId.ok) return integrationAccountId;
  const providerAccountId = readText(
    raw.providerAccountId,
    "binding.account.providerAccountId",
  );
  if (!providerAccountId.ok) return providerAccountId;
  const environment = readEnum(raw.environment, "binding.account.environment", [
    "development",
    "production",
  ] satisfies readonly PaymentEnvironment[]);
  if (!environment.ok) return environment;
  if (
    !Number.isSafeInteger(raw.capabilityRevision) ||
    Number(raw.capabilityRevision) <= 0
  ) {
    return invalidBinding("binding.account.capabilityRevision");
  }
  if (typeof raw.country !== "string" || !COUNTRY_PATTERN.test(raw.country)) {
    return invalidBinding("binding.account.country");
  }
  if (
    typeof raw.currency !== "string" ||
    !CURRENCY_PATTERN.test(raw.currency)
  ) {
    return invalidBinding("binding.account.currency");
  }
  return {
    ok: true,
    value: {
      integrationAccountId: integrationAccountId.value,
      providerAccountId: providerAccountId.value,
      environment: environment.value,
      capabilityRevision: Number(raw.capabilityRevision),
      country: raw.country,
      currency: raw.currency,
    },
  };
}

function readText(
  raw: unknown,
  field: string,
): PaymentBindingParseResult<string> {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= IDENTITY_MAX_LENGTH &&
    raw.trim() === raw
    ? { ok: true, value: raw }
    : invalidBinding(field);
}

function readEnum<const TValue extends string>(
  raw: unknown,
  field: string,
  values: readonly TValue[],
): PaymentBindingParseResult<TValue> {
  if (typeof raw !== "string") return invalidBinding(field);
  for (const value of values) {
    if (raw === value) return { ok: true, value };
  }
  return invalidBinding(field);
}

function invalidBinding(field: string): PaymentBindingParseResult<never> {
  return { ok: false, error: { code: "payment_binding_invalid", field } };
}
