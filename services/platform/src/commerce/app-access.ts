// Pantry calls Commerce as an installed app (Plan 76 phase 2). Each request
// carries Pantry's installation token for the request's merchant. The token is
// derived from the operator token and the organisation that Pantry acts for,
// so a request for another organisation's merchant is refused. A merchant
// with no Pantry installation yet gets one on its first request, and one whose
// installation lacks a newer scope gets it again; Commerce refuses that
// install unless the merchant belongs to the same organisation.
//
// An operator's install after a revoke gives the installation a random nonce
// (Refactor 15), so the derived token stays refused. When Commerce refuses
// it, Pantry reads the token of its active installation for the same
// organisation and keeps it in memory. A revoked installation has no token,
// so an uninstall keeps Pantry out; Pantry never installs itself again.
//
// The operator token stays for the routes that only the operator may call:
// merchant provisioning and the payment authorities.
import { isRecord } from "@seams/std";
import {
  COMMERCE_API_SCOPES,
  COMMERCE_APP_TOKEN_PREFIX,
  commerceAppInstallationToken,
  type CommerceAdminClient,
  type CommerceCredential,
} from "@seams/commerce-client";

const SATYR_UNDERCLERK_APP_ID = "satyr";

/**
 * Whom a Platform client acts for: the operator (provisioning and payment
 * authorities only) or one organisation, through Pantry's installation.
 */
export type CommerceCaller =
  | Readonly<{ kind: "operator" }>
  | Readonly<{
      kind: "organisation";
      organisationId: string;
      /** The member who acts, named on each receipt (Plan 80 step 3). */
      actor?: string;
    }>;

/** The client settings for `caller`, or null when Commerce is not configured. */
export function commerceClientConfig(
  env: Readonly<{
    UNDERCLERK_BASE_URL?: string;
    UNDERCLERK_SERVICE_TOKEN?: string;
    UNDERCLERK: Readonly<{ fetch: CommerceFetch }>;
  }>,
  fetcher: CommerceFetch | undefined,
  caller: CommerceCaller,
): Readonly<{
  baseUrl: string;
  serviceToken: CommerceCredential;
  fetch: CommerceFetch;
  actor?: string;
}> | null {
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  )
    return null;
  const commerceFetch = fetcher ?? env.UNDERCLERK.fetch.bind(env.UNDERCLERK);
  return caller.kind === "operator"
    ? {
        baseUrl: env.UNDERCLERK_BASE_URL,
        serviceToken: env.UNDERCLERK_SERVICE_TOKEN,
        fetch: commerceFetch,
      }
    : {
        baseUrl: env.UNDERCLERK_BASE_URL,
        ...pantryCommerceAccess(
          env.UNDERCLERK_SERVICE_TOKEN,
          caller.organisationId,
          commerceFetch,
          caller.actor,
        ),
      };
}

type CommerceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The credential and fetch for a client that acts for one organisation, and
 * the member who acts, when one does (Plan 80 step 3): Commerce names them
 * on each receipt.
 */
export function pantryCommerceAccess(
  operatorToken: string,
  organisationId: string,
  commerceFetch: CommerceFetch,
  actor?: string,
): Readonly<{
  serviceToken: CommerceCredential;
  fetch: CommerceFetch;
  actor?: string;
}> {
  return {
    ...(actor === undefined ? {} : { actor }),
    serviceToken: async (merchantId) =>
      readInstallationToken(organisationId, merchantId) ??
      commerceAppInstallationToken(operatorToken, {
        appId: SATYR_UNDERCLERK_APP_ID,
        merchantId,
        externalReference: organisationId,
      }),
    // The clients send string or byte bodies, which can be sent again.
    fetch: async (input, init) => {
      const retry = input instanceof Request ? input.clone() : input;
      const response = await commerceFetch(input, init);
      if (response.status !== 401 && response.status !== 403) return response;
      const url = new URL(input instanceof Request ? input.url : input);
      const merchant = /^\/v1\/(?:admin|internal)\/merchants\/([^/]+)/u.exec(
        url.pathname,
      )?.[1];
      if (merchant === undefined) return response;
      if (await refusedToken(response)) {
        const token = await readActiveInstallationToken(
          commerceFetch,
          url.origin,
          operatorToken,
          organisationId,
          merchant,
        );
        return token === null || token === sentToken(input, init)
          ? response
          : commerceFetch(...withBearerToken(retry, init, token));
      }
      if (!(await needsInstall(response))) return response;
      const installed = await commerceFetch(
        `${url.origin}/v1/admin/merchants/${merchant}/app-installations/${SATYR_UNDERCLERK_APP_ID}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${operatorToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            scopes: COMMERCE_API_SCOPES,
            externalReference: organisationId,
            label: "Satyr",
          }),
        },
      );
      return installed.ok ? commerceFetch(retry, init) : response;
    },
  };
}

/**
 * Installs Pantry on a merchant that Platform just provisioned, so its first
 * command needs no install round trip. Needs an operator client.
 */
export async function installPantryCommerceApp(
  operator: CommerceAdminClient,
  organisationId: string,
  merchantId: string,
): Promise<boolean> {
  const installed = await operator.installApp(
    merchantId,
    SATYR_UNDERCLERK_APP_ID,
    {
      scopes: COMMERCE_API_SCOPES,
      externalReference: organisationId,
      label: "Satyr",
    },
  );
  return installed.ok;
}

/**
 * The tokens of installations made again after a revoke, by organisation and
 * merchant, for this isolate. A refused token is read again from Commerce.
 */
const INSTALLATION_TOKENS = new Map<string, string>();
const MAX_INSTALLATION_TOKENS = 256;

function installationTokenKey(organisationId: string, merchantId: string) {
  return `${organisationId}\n${merchantId}`;
}

function readInstallationToken(
  organisationId: string,
  merchantId: string,
): string | undefined {
  return INSTALLATION_TOKENS.get(
    installationTokenKey(organisationId, merchantId),
  );
}

/**
 * The token of Pantry's active installation on `merchant` for
 * `organisationId`, from the operator read; null when there is none, such as
 * after an uninstall, or when this Commerce has no such read.
 */
async function readActiveInstallationToken(
  commerceFetch: CommerceFetch,
  origin: string,
  operatorToken: string,
  organisationId: string,
  merchant: string,
): Promise<string | null> {
  const key = installationTokenKey(
    organisationId,
    decodeURIComponent(merchant),
  );
  INSTALLATION_TOKENS.delete(key);
  const read = await commerceFetch(
    `${origin}/v1/admin/merchants/${merchant}/app-installations/${SATYR_UNDERCLERK_APP_ID}?externalReference=${encodeURIComponent(organisationId)}`,
    { headers: { authorization: `Bearer ${operatorToken}` } },
  );
  if (!read.ok) return null;
  let body: unknown;
  try {
    body = await read.json();
  } catch {
    return null;
  }
  if (
    !isRecord(body) ||
    typeof body.token !== "string" ||
    !body.token.startsWith(`${COMMERCE_APP_TOKEN_PREFIX}_`)
  )
    return null;
  if (INSTALLATION_TOKENS.size >= MAX_INSTALLATION_TOKENS)
    INSTALLATION_TOKENS.clear();
  INSTALLATION_TOKENS.set(key, body.token);
  return body.token;
}

/** Whether Commerce refused the token itself, not a missing installation. */
async function refusedToken(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body: unknown = await response.clone().json();
    return isRecord(body) && body.code === "unauthorized";
  } catch {
    return false;
  }
}

function sentToken(
  input: string | URL | Request,
  init: RequestInit | undefined,
): string | null {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  return /^Bearer (.+)$/u.exec(headers.get("authorization") ?? "")?.[1] ?? null;
}

function withBearerToken(
  input: string | URL | Request,
  init: RequestInit | undefined,
  token: string,
): [string | URL | Request, RequestInit | undefined] {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("authorization", `Bearer ${token}`);
  return [input, { ...init, headers }];
}

/**
 * Whether Pantry's installation is missing, or lacks a scope that a newer
 * Commerce added (Plan 80 step 3): installing again grants every scope.
 */
async function needsInstall(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      ((response.status === 401 && body.code === "app_not_installed") ||
        (response.status === 403 && body.code === "missing_scope"))
    );
  } catch {
    return false;
  }
}
