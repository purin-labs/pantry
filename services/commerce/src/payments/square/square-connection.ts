// A merchant's connection to its Square seller account (Plan 80 step 4).
// Commerce exchanges the OAuth authorization code with the Square
// application's client secret, keeps the tokens sealed with the merchant key
// of the customer vault, refreshes them and revokes them. Locations that take
// payments, Terminals and their device codes are read through it. A partner
// may hand over tokens that the same application issued instead of a code.
// The connection keeps the scopes that Square granted and why it stopped
// working (`SQUARE_CONNECTION_MACHINE`); `#move` is its one writer.
import { isRecord } from "@seams/std";
import { machineTransition } from "@seams/std/state-machine";

import type { CommerceDatabase } from "../../database.ts";
import type { CustomerVault } from "../../plugins/customers/index.ts";
import {
  SquareApi,
  type SquareEnvironment,
  type SquareOAuthClient,
  type SquareResponse,
} from "./square-api.ts";
import {
  SQUARE_CONNECTION_MACHINE,
  type SquareConnectionEvent,
  type SquareConnectionState,
} from "./square-connection.machine.ts";

/** A token this close to its expiry is refreshed before use. */
const REFRESH_BEFORE_MS = 24 * 60 * 60 * 1_000;

/** The scopes that Commerce's own Square calls use. */
const SQUARE_SCOPES_IN_USE: readonly string[] = [
  "DEVICE_CREDENTIAL_MANAGEMENT",
  "DEVICES_READ",
  "MERCHANT_PROFILE_READ",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
  "PAYOUTS_READ",
];

export type SquareConnectionV1 = Readonly<{
  provider: "square";
  environment: SquareEnvironment;
  applicationId: string;
  providerAccountId: string;
  businessName: string | null;
  country: string | null;
  currency: string | null;
  state: SquareConnectionState;
  /** The scopes that Square granted; null when Square did not show them. */
  scopes: readonly string[] | null;
  connectedAt: string;
  updatedAt: string;
}>;

type SquareLocationV1 = Readonly<{
  locationId: string;
  name: string;
  country: string;
  currency: string;
  status: string;
  cardPayments: boolean;
}>;

type SquareDeviceV1 = Readonly<{
  deviceId: string;
  name: string;
  locationId: string | null;
  status: string;
}>;

type SquareDeviceCodeV1 = Readonly<{
  deviceCodeId: string;
  code: string;
  name: string;
  locationId: string;
  status: string;
  pairBy: string | null;
  deviceId: string | null;
}>;

export type SquareResult<Value> =
  | Readonly<{ kind: "ok"; value: Value }>
  | Readonly<{ kind: "error"; status: 404 | 409 | 422 | 503; message: string }>;

type SquareCredential = Readonly<{
  environment: SquareEnvironment;
  applicationId: string;
  providerAccountId: string;
  accessToken: string;
}>;

type Tokens = Readonly<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}>;

type ConnectionRow = Readonly<{
  environment: SquareEnvironment;
  applicationId: string;
  providerAccountId: string;
  businessName: string | null;
  country: string | null;
  currency: string | null;
  sealedAccessToken: string;
  sealedRefreshToken: string | null;
  tokenExpiresAt: string | null;
  connectedAt: string;
  updatedAt: string;
  state: SquareConnectionState;
  scopesJson: string | null;
}>;

type Grant =
  | Readonly<{
      kind: "authorization_code";
      code: string;
      redirectUri: string | null;
    }>
  | Readonly<{ kind: "tokens"; tokens: Tokens }>;

/** Each merchant's Square connection, in the merchant's own database. */
export class SquareConnections {
  readonly #database: CommerceDatabase;
  readonly #vault: CustomerVault;
  readonly #api: SquareApi;
  readonly #oauth: SquareOAuthClient | undefined;
  readonly #now: () => string;
  // One refresh at a time for each merchant: Square answers a second
  // refresh of the same token with the same new token, but a request that
  // reads the old row while the first refresh writes would keep a stale one.
  readonly #refreshing = new Map<string, Promise<Tokens | undefined>>();

  constructor(
    options: Readonly<{
      database: CommerceDatabase;
      vault: CustomerVault;
      api: SquareApi;
      oauth?: SquareOAuthClient;
      now: () => string;
    }>,
  ) {
    this.#database = options.database;
    this.#vault = options.vault;
    this.#api = options.api;
    this.#oauth = options.oauth;
    this.#now = options.now;
  }

  get api(): SquareApi {
    return this.#api;
  }

  /**
   * Connects the merchant's Square account from an authorization code or
   * from tokens of this application. A new account replaces the old one,
   * and the old account's locations stop taking payments here.
   */
  async connect(
    merchantId: string,
    body: unknown,
  ): Promise<SquareResult<SquareConnectionV1>> {
    const oauth = this.#oauth;
    if (oauth === undefined)
      return { kind: "error", status: 409, message: "Square is not configured" };
    const request = parseConnect(body);
    if (request === undefined)
      return invalid(
        "A Square connection needs its environment and an authorization code or tokens",
      );
    if (!this.#merchantExists(merchantId))
      return { kind: "error", status: 404, message: "Merchant not found" };
    let tokens: Tokens;
    if (request.grant.kind === "authorization_code") {
      const exchanged = await this.#token(request.environment, oauth, {
        code: request.grant.code,
        grant_type: "authorization_code",
        ...(request.grant.redirectUri === null
          ? {}
          : { redirect_uri: request.grant.redirectUri }),
      });
      if (exchanged.kind === "unavailable") return unavailable();
      if (exchanged.kind === "refused")
        return {
          kind: "error",
          status: 409,
          message: "Square refused the authorization code",
        };
      tokens = exchanged.tokens;
    } else tokens = request.grant.tokens;
    const account = await this.#api.request(
      request.environment,
      tokens.accessToken,
      "GET",
      "/v2/merchants/me",
    );
    if (account.kind === "unavailable") return unavailable();
    const seller =
      account.kind === "ok" && isRecord(account.body.merchant)
        ? account.body.merchant
        : undefined;
    const providerAccountId =
      typeof seller?.id === "string" ? seller.id : undefined;
    if (seller === undefined || providerAccountId === undefined)
      return {
        kind: "error",
        status: 409,
        message: "Square does not show a seller account to this token",
      };
    const scopes = await this.#grantedScopes(
      request.environment,
      tokens.accessToken,
    );
    const now = this.#now();
    const current = this.#row(merchantId);
    const state =
      nextState(current?.state ?? "connected", grantEvent(scopes)) ??
      "connected";
    this.#database.transaction(() => {
      if (
        current !== undefined &&
        (current.providerAccountId !== providerAccountId ||
          current.environment !== request.environment)
      )
        this.#database
          .prepare("DELETE FROM square_payment_account WHERE merchant_id = ?")
          .run(merchantId);
      this.#database
        .prepare(
          `INSERT INTO square_connection (
             merchant_id, environment, application_id, provider_account_id,
             business_name, country, currency,
             sealed_access_token, sealed_refresh_token, token_expires_at,
             connected_at, updated_at, state, scopes_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (merchant_id) DO UPDATE SET
             environment = excluded.environment,
             application_id = excluded.application_id,
             provider_account_id = excluded.provider_account_id,
             business_name = excluded.business_name,
             country = excluded.country,
             currency = excluded.currency,
             sealed_access_token = excluded.sealed_access_token,
             sealed_refresh_token = excluded.sealed_refresh_token,
             token_expires_at = excluded.token_expires_at,
             connected_at = excluded.connected_at,
             updated_at = excluded.updated_at,
             state = excluded.state,
             scopes_json = excluded.scopes_json`,
        )
        .run(
          merchantId,
          request.environment,
          oauth.clientId,
          providerAccountId,
          sellerText(seller.business_name, 255),
          sellerCode(seller.country, /^[A-Z]{2}$/u),
          sellerCode(seller.currency, /^[A-Z]{3}$/u),
          ...this.#sealed(merchantId, tokens),
          now,
          now,
          state,
          scopes === null ? null : JSON.stringify(scopes),
        );
    });
    return { kind: "ok", value: summary(requireRow(this.#row(merchantId))) };
  }

  read(merchantId: string): SquareConnectionV1 | undefined {
    const row = this.#row(merchantId);
    return row === undefined ? undefined : summary(row);
  }

  /**
   * Revokes the application's tokens for the seller at Square and forgets
   * the connection and its locations. A connection that Square already
   * forgot is forgotten here too.
   */
  async disconnect(merchantId: string): Promise<SquareResult<null>> {
    const row = this.#row(merchantId);
    if (row === undefined)
      return { kind: "error", status: 404, message: "Square is not connected" };
    const oauth = this.#oauth;
    if (oauth === undefined || oauth.clientId !== row.applicationId)
      return {
        kind: "error",
        status: 409,
        message: "Another Square application issued this connection",
      };
    const revoked = await this.#api.request(
      row.environment,
      null,
      "POST",
      "/oauth2/revoke",
      { client_id: oauth.clientId, merchant_id: row.providerAccountId },
      `Client ${oauth.clientSecret}`,
    );
    if (revoked.kind === "unavailable") return unavailable();
    if (revoked.kind === "refused" && revoked.status !== 404)
      return {
        kind: "error",
        status: 409,
        message: "Square refused to revoke the connection",
      };
    this.#database.transaction(() => {
      this.#database
        .prepare("DELETE FROM square_payment_account WHERE merchant_id = ?")
        .run(merchantId);
      this.#database
        .prepare("DELETE FROM square_connection WHERE merchant_id = ?")
        .run(merchantId);
    });
    return { kind: "ok", value: null };
  }

  /**
   * The connection's environment, account and a token that is valid now: a
   * token close to its expiry is refreshed first, and the new tokens are kept.
   */
  async credential(merchantId: string): Promise<SquareCredential | undefined> {
    return (await this.#current(merchantId))?.credential;
  }

  /**
   * The credential and the stored token that it came from. Square refuses a
   * revoked connection's token, so it is not sent again.
   */
  async #current(
    merchantId: string,
  ): Promise<
    | Readonly<{ credential: SquareCredential; sealedAccessToken: string }>
    | undefined
  > {
    const row = this.#row(merchantId);
    if (row === undefined || row.state === "revoked") return undefined;
    let tokens = this.#open(merchantId, row);
    let sealedAccessToken = row.sealedAccessToken;
    if (expiring(tokens, this.#now())) {
      const refreshed = await this.#refreshOnce(merchantId, row, tokens);
      if (refreshed !== undefined) {
        tokens = refreshed;
        sealedAccessToken =
          this.#row(merchantId)?.sealedAccessToken ?? sealedAccessToken;
      } else if (
        tokens.expiresAt !== null &&
        Date.parse(tokens.expiresAt) <= Date.parse(this.#now())
      )
        return undefined;
    }
    return {
      credential: {
        environment: row.environment,
        applicationId: row.applicationId,
        providerAccountId: row.providerAccountId,
        accessToken: tokens.accessToken,
      },
      sealedAccessToken,
    };
  }

  async locations(
    merchantId: string,
  ): Promise<SquareResult<readonly SquareLocationV1[]>> {
    const read = await this.#call(merchantId, "GET", "/v2/locations");
    if (read.kind !== "ok") return read;
    const raw = read.value.locations;
    return {
      kind: "ok",
      value: (Array.isArray(raw) ? raw : []).flatMap((location) => {
        const parsed = parseLocation(location);
        return parsed === undefined ? [] : [parsed];
      }),
    };
  }

  async location(
    merchantId: string,
    locationId: string,
  ): Promise<SquareResult<SquareLocationV1>> {
    const read = await this.#call(
      merchantId,
      "GET",
      `/v2/locations/${encodeURIComponent(locationId)}`,
    );
    if (read.kind !== "ok") return read;
    const location = parseLocation(read.value.location);
    return location === undefined || location.locationId !== locationId
      ? {
          kind: "error",
          status: 404,
          message: "Square does not show this location to the connection",
        }
      : { kind: "ok", value: location };
  }

  async devices(
    merchantId: string,
    locationId: string | null,
  ): Promise<SquareResult<readonly SquareDeviceV1[]>> {
    const query =
      locationId === null
        ? ""
        : `?location_id=${encodeURIComponent(locationId)}`;
    const read = await this.#call(merchantId, "GET", `/v2/devices${query}`);
    if (read.kind !== "ok") return read;
    const raw = read.value.devices;
    return {
      kind: "ok",
      value: (Array.isArray(raw) ? raw : []).flatMap((device) => {
        const parsed = parseDevice(device);
        return parsed === undefined ? [] : [parsed];
      }),
    };
  }

  /** A code that pairs a Square Terminal with the location for Terminal API checkouts. */
  async createDeviceCode(
    merchantId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<SquareResult<SquareDeviceCodeV1>> {
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "locationId" && key !== "name") ||
      !isReference(body.locationId) ||
      typeof body.name !== "string" ||
      body.name.trim().length === 0 ||
      body.name.length > 128
    )
      return invalid("A device code needs a location id and a name");
    const created = await this.#call(merchantId, "POST", "/v2/devices/codes", {
      idempotency_key: `${merchantId}:${idempotencyKey}`.slice(0, 128),
      device_code: {
        name: body.name.trim(),
        product_type: "TERMINAL_API",
        location_id: body.locationId,
      },
    });
    if (created.kind !== "ok") return created;
    const code = parseDeviceCode(created.value.device_code);
    return code === undefined ? unavailable() : { kind: "ok", value: code };
  }

  async deviceCode(
    merchantId: string,
    deviceCodeId: string,
  ): Promise<SquareResult<SquareDeviceCodeV1>> {
    const read = await this.#call(
      merchantId,
      "GET",
      `/v2/devices/codes/${encodeURIComponent(deviceCodeId)}`,
    );
    if (read.kind !== "ok") return read;
    const code = parseDeviceCode(read.value.device_code);
    return code === undefined
      ? { kind: "error", status: 404, message: "Device code not found" }
      : { kind: "ok", value: code };
  }

  /** A read with the merchant's token, for a caller that sorts the answer. */
  async readProvider(
    merchantId: string,
    path: string,
  ): Promise<SquareResponse> {
    return (
      (await this.#send(merchantId, "GET", path)) ?? { kind: "unavailable" }
    );
  }

  async #call(
    merchantId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<SquareResult<Record<string, unknown>>> {
    const response = await this.#send(merchantId, method, path, body);
    if (response === undefined) {
      const state = this.#row(merchantId)?.state;
      return state === undefined
        ? { kind: "error", status: 404, message: "Square is not connected" }
        : {
            kind: "error",
            status: 409,
            message: `Square no longer accepts this connection (${state})`,
          };
    }
    return response.kind === "ok"
      ? { kind: "ok", value: response.body }
      : refusedOrUnavailable(response);
  }

  /**
   * One call with the connection's token; undefined when there is no token
   * to send. A refusal that names the token or its scopes moves the
   * connection.
   */
  async #send(
    merchantId: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<SquareResponse | undefined> {
    const current = await this.#current(merchantId);
    if (current === undefined) return undefined;
    const { credential } = current;
    const response = await this.#api.request(
      credential.environment,
      credential.accessToken,
      method,
      path,
      body,
    );
    const event = refusalEvent(response);
    if (event !== undefined)
      this.#move(merchantId, current.sealedAccessToken, event);
    return response;
  }

  /**
   * The one writer of the connection's state after it is stored: the move
   * that the machine allows from the stored state, kept only while the
   * stored token is the one that Square answered for. `scopes` replaces the
   * kept scope list.
   */
  #move(
    merchantId: string,
    sealedAccessToken: string,
    event: SquareConnectionEvent,
    scopes?: readonly string[],
  ): void {
    const row = this.#row(merchantId);
    if (row === undefined || row.sealedAccessToken !== sealedAccessToken)
      return;
    const state = nextState(row.state, event);
    if (state === undefined) return;
    this.#database
      .prepare(
        `UPDATE square_connection
         SET state = ?, scopes_json = ?, updated_at = ?
         WHERE merchant_id = ? AND state = ? AND sealed_access_token = ?`,
      )
      .run(
        state,
        scopes === undefined ? row.scopesJson : JSON.stringify(scopes),
        this.#now(),
        merchantId,
        row.state,
        sealedAccessToken,
      );
  }

  /** The scopes that Square shows for a token; null when it does not say. */
  async #grantedScopes(
    environment: SquareEnvironment,
    accessToken: string,
  ): Promise<readonly string[] | null> {
    const status = await this.#api.request(
      environment,
      accessToken,
      "POST",
      "/oauth2/token/status",
    );
    if (status.kind !== "ok" || !Array.isArray(status.body.scopes))
      return null;
    return status.body.scopes.filter(
      (scope): scope is string => typeof scope === "string",
    );
  }

  #refreshOnce(
    merchantId: string,
    row: ConnectionRow,
    tokens: Tokens,
  ): Promise<Tokens | undefined> {
    const running = this.#refreshing.get(merchantId);
    if (running !== undefined) return running;
    const refresh = this.#refresh(merchantId, row, tokens).finally(() => {
      this.#refreshing.delete(merchantId);
    });
    this.#refreshing.set(merchantId, refresh);
    return refresh;
  }

  async #refresh(
    merchantId: string,
    row: ConnectionRow,
    tokens: Tokens,
  ): Promise<Tokens | undefined> {
    const oauth = this.#oauth;
    if (
      oauth === undefined ||
      oauth.clientId !== row.applicationId ||
      tokens.refreshToken === null
    ) {
      this.#move(merchantId, row.sealedAccessToken, "refresh_refused");
      return undefined;
    }
    const refreshed = await this.#token(row.environment, oauth, {
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    });
    if (refreshed.kind === "unavailable") return undefined;
    if (refreshed.kind === "refused") {
      this.#move(merchantId, row.sealedAccessToken, "refresh_refused");
      return undefined;
    }
    const next: Tokens = {
      ...refreshed.tokens,
      refreshToken: refreshed.tokens.refreshToken ?? tokens.refreshToken,
    };
    // Kept only while the connection is the one that was refreshed.
    this.#database
      .prepare(
        `UPDATE square_connection
         SET sealed_access_token = ?, sealed_refresh_token = ?, token_expires_at = ?, updated_at = ?
         WHERE merchant_id = ? AND provider_account_id = ? AND sealed_access_token = ?`,
      )
      .run(
        ...this.#sealed(merchantId, next),
        this.#now(),
        merchantId,
        row.providerAccountId,
        row.sealedAccessToken,
      );
    const stored = this.#row(merchantId);
    if (
      stored !== undefined &&
      stored.sealedAccessToken !== row.sealedAccessToken
    ) {
      const scopes = await this.#grantedScopes(
        row.environment,
        next.accessToken,
      );
      this.#move(
        merchantId,
        stored.sealedAccessToken,
        grantEvent(scopes ?? parseScopes(stored.scopesJson)),
        scopes ?? undefined,
      );
    }
    return next;
  }

  async #token(
    environment: SquareEnvironment,
    oauth: SquareOAuthClient,
    grant: Readonly<Record<string, string>>,
  ): Promise<
    | Readonly<{ kind: "ok"; tokens: Tokens }>
    | Readonly<{ kind: "refused" }>
    | Readonly<{ kind: "unavailable" }>
  > {
    const response = await this.#api.request(
      environment,
      null,
      "POST",
      "/oauth2/token",
      {
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        ...grant,
      },
    );
    if (response.kind === "unavailable") return { kind: "unavailable" };
    if (response.kind === "refused") return { kind: "refused" };
    const tokens = parseTokens(response.body);
    return tokens === undefined ? { kind: "refused" } : { kind: "ok", tokens };
  }

  #sealed(
    merchantId: string,
    tokens: Tokens,
  ): [string, string | null, string | null] {
    return [
      this.#vault.sealForMerchant(
        merchantId,
        "square_access_token",
        tokens.accessToken,
      ),
      tokens.refreshToken === null
        ? null
        : this.#vault.sealForMerchant(
            merchantId,
            "square_refresh_token",
            tokens.refreshToken,
          ),
      tokens.expiresAt,
    ];
  }

  #open(merchantId: string, row: ConnectionRow): Tokens {
    const accessToken = this.#vault.openForMerchant(
      merchantId,
      "square_access_token",
      row.sealedAccessToken,
    );
    const refreshToken =
      row.sealedRefreshToken === null
        ? null
        : this.#vault.openForMerchant(
            merchantId,
            "square_refresh_token",
            row.sealedRefreshToken,
          );
    if (
      typeof accessToken !== "string" ||
      (refreshToken !== null && typeof refreshToken !== "string")
    )
      throw new Error("Square tokens are invalid");
    return { accessToken, refreshToken, expiresAt: row.tokenExpiresAt };
  }

  #row(merchantId: string): ConnectionRow | undefined {
    return this.#database
      .prepare(
        `SELECT environment, application_id AS applicationId,
           provider_account_id AS providerAccountId,
           business_name AS businessName, country, currency,
           sealed_access_token AS sealedAccessToken,
           sealed_refresh_token AS sealedRefreshToken,
           token_expires_at AS tokenExpiresAt,
           connected_at AS connectedAt, updated_at AS updatedAt,
           state, scopes_json AS scopesJson
         FROM square_connection WHERE merchant_id = ?`,
      )
      .get<ConnectionRow>(merchantId);
  }

  #merchantExists(merchantId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 AS found FROM merchant WHERE merchant_id = ?")
        .get<Readonly<{ found: number }>>(merchantId) !== undefined
    );
  }
}

/** A Square location as Square's location object describes it. */
function parseLocation(raw: unknown): SquareLocationV1 | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.country !== "string" ||
    !/^[A-Z]{2}$/u.test(raw.country) ||
    typeof raw.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currency)
  )
    return undefined;
  const status = typeof raw.status === "string" ? raw.status : "UNKNOWN";
  return {
    locationId: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    country: raw.country,
    currency: raw.currency,
    status,
    cardPayments:
      status === "ACTIVE" &&
      Array.isArray(raw.capabilities) &&
      raw.capabilities.includes("CREDIT_CARD_PROCESSING"),
  };
}

function parseDevice(raw: unknown): SquareDeviceV1 | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string") return undefined;
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  const status = isRecord(raw.status) ? raw.status : {};
  const location = Array.isArray(raw.components)
    ? raw.components
        .filter(isRecord)
        .map((component) =>
          isRecord(component.application_details)
            ? component.application_details.session_location
            : undefined,
        )
        .find((value): value is string => typeof value === "string")
    : undefined;
  return {
    deviceId: raw.id,
    name: typeof attributes.name === "string" ? attributes.name : raw.id,
    locationId:
      location ??
      (typeof attributes.location_id === "string"
        ? attributes.location_id
        : null),
    status: typeof status.category === "string" ? status.category : "UNKNOWN",
  };
}

function parseDeviceCode(raw: unknown): SquareDeviceCodeV1 | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.code !== "string" ||
    typeof raw.location_id !== "string" ||
    typeof raw.status !== "string"
  )
    return undefined;
  return {
    deviceCodeId: raw.id,
    code: raw.code,
    name: typeof raw.name === "string" ? raw.name : "",
    locationId: raw.location_id,
    status: raw.status,
    pairBy: typeof raw.pair_by === "string" ? raw.pair_by : null,
    deviceId: typeof raw.device_id === "string" ? raw.device_id : null,
  };
}

function parseConnect(
  body: unknown,
): Readonly<{ environment: SquareEnvironment; grant: Grant }> | undefined {
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "environment" && key !== "grant") ||
    (body.environment !== "development" && body.environment !== "production") ||
    !isRecord(body.grant)
  )
    return undefined;
  const grant = body.grant;
  if (grant.kind === "authorization_code") {
    if (
      Object.keys(grant).some(
        (key) => key !== "kind" && key !== "code" && key !== "redirectUri",
      ) ||
      !isToken(grant.code) ||
      (grant.redirectUri !== undefined && !isHttpsUrl(grant.redirectUri))
    )
      return undefined;
    return {
      environment: body.environment,
      grant: {
        kind: "authorization_code",
        code: grant.code,
        redirectUri:
          typeof grant.redirectUri === "string" ? grant.redirectUri : null,
      },
    };
  }
  if (grant.kind !== "tokens") return undefined;
  if (
    Object.keys(grant).some(
      (key) =>
        key !== "kind" &&
        key !== "accessToken" &&
        key !== "refreshToken" &&
        key !== "expiresAt",
    ) ||
    !isToken(grant.accessToken) ||
    (grant.refreshToken !== undefined &&
      grant.refreshToken !== null &&
      !isToken(grant.refreshToken)) ||
    (grant.expiresAt !== undefined &&
      grant.expiresAt !== null &&
      (typeof grant.expiresAt !== "string" ||
        Number.isNaN(Date.parse(grant.expiresAt))))
  )
    return undefined;
  return {
    environment: body.environment,
    grant: {
      kind: "tokens",
      tokens: {
        accessToken: grant.accessToken,
        refreshToken:
          typeof grant.refreshToken === "string" ? grant.refreshToken : null,
        expiresAt:
          typeof grant.expiresAt === "string"
            ? new Date(grant.expiresAt).toISOString()
            : null,
      },
    },
  };
}

function parseTokens(body: Record<string, unknown>): Tokens | undefined {
  const accessToken = body.access_token;
  const expiresAt = body.expires_at;
  if (
    !isToken(accessToken) ||
    typeof expiresAt !== "string" ||
    Number.isNaN(Date.parse(expiresAt))
  )
    return undefined;
  return {
    accessToken,
    refreshToken: isToken(body.refresh_token) ? body.refresh_token : null,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function summary(row: ConnectionRow): SquareConnectionV1 {
  return {
    provider: "square",
    environment: row.environment,
    applicationId: row.applicationId,
    providerAccountId: row.providerAccountId,
    businessName: row.businessName,
    country: row.country,
    currency: row.currency,
    state: row.state,
    scopes: parseScopes(row.scopesJson),
    connectedAt: row.connectedAt,
    updatedAt: row.updatedAt,
  };
}

/** The state that `event` moves `state` to; undefined when it may not move. */
function nextState(
  state: SquareConnectionState,
  event: SquareConnectionEvent,
): SquareConnectionState | undefined {
  const move = machineTransition(SQUARE_CONNECTION_MACHINE, state, event);
  return move.allowed ? move.to : undefined;
}

/** A grant with no known scope list counts as a grant of every scope. */
function grantEvent(
  scopes: readonly string[] | null,
): "grant" | "grant_without_scope" {
  return scopes === null ||
    SQUARE_SCOPES_IN_USE.every((scope) => scopes.includes(scope))
    ? "grant"
    : "grant_without_scope";
}

/**
 * Square answers 401 for a token that it no longer accepts, and 403 with
 * INSUFFICIENT_SCOPES for a scope that the seller did not grant. An expired
 * token is refreshed, not revoked.
 */
function refusalEvent(
  response: SquareResponse,
): "token_refused" | "scope_refused" | undefined {
  if (response.kind !== "refused") return undefined;
  if (response.status === 401 && response.code !== "ACCESS_TOKEN_EXPIRED")
    return "token_refused";
  if (response.status === 403 && response.code === "INSUFFICIENT_SCOPES")
    return "scope_refused";
  return undefined;
}

function parseScopes(raw: string | null): readonly string[] | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.filter((scope): scope is string => typeof scope === "string")
    : null;
}

function sellerText(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, limit)
    : null;
}

function sellerCode(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function requireRow(row: ConnectionRow | undefined): ConnectionRow {
  if (row === undefined) throw new Error("Square connection was not stored");
  return row;
}

function expiring(tokens: Tokens, now: string): boolean {
  return (
    tokens.expiresAt !== null &&
    Date.parse(tokens.expiresAt) - Date.parse(now) < REFRESH_BEFORE_MS
  );
}

function refusedOrUnavailable(
  response: Exclude<SquareResponse, { kind: "ok" }>,
): SquareResult<never> {
  if (response.kind === "unavailable") return unavailable();
  return response.status === 404
    ? { kind: "error", status: 404, message: "Square did not find it" }
    : {
        kind: "error",
        status: 409,
        message: `Square refused the request${response.code === null ? "" : ` (${response.code})`}`,
      };
}

function unavailable(): SquareResult<never> {
  return { kind: "error", status: 503, message: "Square is unavailable" };
}

function invalid(message: string): SquareResult<never> {
  return { kind: "error", status: 422, message };
}

export function isReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
