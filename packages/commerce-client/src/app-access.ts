// Admin API access for Commerce callers (Plan 76 phase 2).
//
// Three credentials open the admin routes of a merchant:
// - the operator token of the deployment, for every route of every merchant;
// - an API key (`uck_<id>_<secret>`) that the operator issued for one
//   merchant, for the routes of its scopes;
// - an app installation token (`uca_<id>_<secret>`) for one app on one
//   merchant, for the routes of its scopes.
//
// An installation token is derived from the operator token and the
// installation's facts, so an operator-run app (Pantry) computes it again
// instead of storing it. A different external reference gives a different
// token, so an app that names the wrong organisation for a merchant is
// refused. An app installed again after its revocation gets a random nonce
// (Refactor 15, refactor 11), so its new token differs from the revoked one;
// only the install answer shows it.
import { encodeBase64Url, sha256Hex } from "@seams/std";
import {
  COMMERCE_API_SCOPES,
  type CommerceApiScope,
} from "@seams/commerce-contracts/records/api-access";

export {
  COMMERCE_API_SCOPES,
  type CommerceApiScope,
} from "@seams/commerce-contracts/records/api-access";

export const COMMERCE_API_KEY_PREFIX = "uck";
export const COMMERCE_APP_TOKEN_PREFIX = "uca";

export function isCommerceApiScope(
  value: unknown,
): value is CommerceApiScope {
  return COMMERCE_API_SCOPES.some((scope) => scope === value);
}

/** The credential id of one app's installation on one merchant. */
export async function commerceAppInstallationId(
  appId: string,
  merchantId: string,
): Promise<string> {
  return (
    await sha256Hex(`underclerk.app-installation.v1\n${appId}\n${merchantId}`)
  ).slice(0, 24);
}

/** The bearer token of one app's installation on one merchant. */
export async function commerceAppInstallationToken(
  operatorToken: string,
  installation: Readonly<{
    appId: string;
    merchantId: string;
    externalReference: string;
    /** The installation's nonce; none for an app's first installation. */
    nonce?: string;
  }>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(operatorToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      commerceAppTokenMessage(
        installation.appId,
        installation.merchantId,
        installation.externalReference,
        installation.nonce,
      ),
    ),
  );
  const id = await commerceAppInstallationId(
    installation.appId,
    installation.merchantId,
  );
  return `${COMMERCE_APP_TOKEN_PREFIX}_${id}_${encodeBase64Url(new Uint8Array(secret))}`;
}

/** The text that an installation token signs. */
export function commerceAppTokenMessage(
  appId: string,
  merchantId: string,
  externalReference: string,
  nonce: string | undefined,
): string {
  return nonce === undefined
    ? `underclerk.app-token.v1\n${appId}\n${merchantId}\n${externalReference}`
    : `underclerk.app-token.v2\n${appId}\n${merchantId}\n${externalReference}\n${nonce}`;
}

/**
 * What a client sends as its bearer token: one token, or a token for each
 * merchant, such as an app's installation tokens.
 */
export type CommerceCredential =
  string | ((merchantId: string) => Promise<string>);

/** The bearer token for a request to `path` (an `/v1/...` path). */
export async function commerceBearerToken(
  credential: CommerceCredential,
  path: string,
): Promise<string> {
  if (typeof credential === "string") return credential;
  const segment = /^\/v1\/(?:admin|internal|public)\/merchants\/([^/?]+)/u.exec(
    path,
  )?.[1];
  if (segment === undefined) throw new Error("The request names no merchant");
  return credential(decodeURIComponent(segment));
}

const encoder = new TextEncoder();
