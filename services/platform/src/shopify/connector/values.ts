import type { JsonObject } from "@purin-labs/kernel/http";

export function shopifyProductDescription(product: JsonObject): string {
  if (typeof product.body_html === "string") {
    return product.body_html;
  }
  return typeof product.description === "string" ? product.description : "";
}

export function shopifyRevision(occurredAt: string): number {
  const milliseconds = Date.parse(occurredAt);
  const revision = Math.floor(milliseconds / 1_000);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}

export function normalizedShopifyTimestamp(
  raw: unknown,
  fallback: string,
): string {
  if (typeof raw !== "string") {
    return fallback;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) || parsed > Date.parse(fallback)
    ? fallback
    : new Date(parsed).toISOString();
}

export function safeSignedInteger(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : null;
}

export function providerId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value.toString()
    : null;
}

export function decimalToMinorUnits(
  value: string,
  currency: string,
): number | null {
  const digits = currencyMinorDigits(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);

  if (match === null) {
    return null;
  }

  const whole = match[1];
  const fraction = match[2] ?? "";

  if (whole === undefined || fraction.length > digits) {
    return null;
  }

  const paddedFraction = fraction.padEnd(digits, "0");
  const scale = 10 ** digits;
  const minor = Number(whole) * scale + Number(paddedFraction || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

function currencyMinorDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === "number" &&
      Number.isSafeInteger(digits) &&
      digits >= 0
      ? digits
      : 2;
  } catch {
    return 2;
  }
}

export function validShopDomain(value: string | null): value is string {
  return value !== null && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);
}

export function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function nullableSafeInteger(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isSafeInteger(value))
  );
}
