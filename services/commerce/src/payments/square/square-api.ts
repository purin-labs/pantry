// Square's HTTP API as Commerce calls it: one version for every call,
// and answers sorted into success, refusal and unavailability.
import { isRecord } from "@seams/std";

export const SQUARE_API_VERSION = "2026-08-19";

export type SquareEnvironment = "development" | "production";

export type SquareResponse =
  | Readonly<{ kind: "ok"; body: Record<string, unknown> }>
  | Readonly<{
      kind: "refused";
      status: number;
      code: string | null;
      category: string | null;
    }>
  | Readonly<{ kind: "unavailable" }>;

/** Square's API for one access token. */
export class SquareApi {
  readonly #fetch: typeof fetch;

  constructor(options: Readonly<{ fetch?: typeof fetch }> = {}) {
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
  }

  async request(
    environment: SquareEnvironment,
    accessToken: string | null,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    // The OAuth revoke call names the application (`Client <secret>`).
    authorization?: string,
  ): Promise<SquareResponse> {
    const headers = new Headers({ "square-version": SQUARE_API_VERSION });
    if (authorization !== undefined) headers.set("authorization", authorization);
    else if (accessToken !== null)
      headers.set("authorization", `Bearer ${accessToken}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.#fetch(`${squareOrigin(environment)}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return { kind: "unavailable" };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { kind: "unavailable" };
    }
    if (response.ok && isRecord(payload)) return { kind: "ok", body: payload };
    if (
      response.status >= 500 ||
      response.status === 408 ||
      response.status === 429
    )
      return { kind: "unavailable" };
    const first =
      isRecord(payload) && Array.isArray(payload.errors)
        ? payload.errors[0]
        : undefined;
    return {
      kind: "refused",
      status: response.status,
      code:
        isRecord(first) && typeof first.code === "string" ? first.code : null,
      category:
        isRecord(first) && typeof first.category === "string"
          ? first.category
          : null,
    };
  }
}

/** The client of the Square application that issued merchants' OAuth tokens. */
export type SquareOAuthClient = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

function squareOrigin(environment: SquareEnvironment): string {
  return environment === "development"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}
