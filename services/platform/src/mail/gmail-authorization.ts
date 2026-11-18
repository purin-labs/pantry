export type GmailAuthorizationProduct =
  | "full_mailbox_pilot"
  | "send_only";

export type ProviderAuthorizationProduct =
  | { readonly kind: "standard" }
  | { readonly kind: "gmail"; readonly product: GmailAuthorizationProduct };

export const GMAIL_FULL_MAILBOX_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export const GMAIL_SEND_ONLY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export function gmailScopesForProduct(
  product: GmailAuthorizationProduct,
): readonly string[] {
  switch (product) {
    case "full_mailbox_pilot":
      return GMAIL_FULL_MAILBOX_SCOPES;
    case "send_only":
      return GMAIL_SEND_ONLY_SCOPES;
  }
}

export function parseGmailAuthorizationProduct(
  value: unknown,
): GmailAuthorizationProduct | null {
  switch (value) {
    case "full_mailbox_pilot":
    case "send_only":
      return value;
    default:
      return null;
  }
}

export function gmailProductFromScopes(
  grantedScopes: readonly string[],
): GmailAuthorizationProduct | null {
  const granted = new Set(grantedScopes);
  const matches = (required: readonly string[]): boolean =>
    granted.size === required.length &&
    required.every((scope) => granted.has(scope));
  if (matches(GMAIL_FULL_MAILBOX_SCOPES)) return "full_mailbox_pilot";
  if (matches(GMAIL_SEND_ONLY_SCOPES)) return "send_only";
  return null;
}

export function providerAuthorizationProduct(
  provider: string,
  product: GmailAuthorizationProduct | null,
): ProviderAuthorizationProduct {
  return provider === "gmail" && product !== null
    ? { kind: "gmail", product }
    : { kind: "standard" };
}
