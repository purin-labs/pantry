import {
  FIXTURE_DISPLAY_PHONE_NUMBER,
  FIXTURE_PHONE_NUMBER_ID,
  FIXTURE_WABA_ID,
} from "./fixtures";

/**
 * A fake Meta Graph API at the exact `fetcher` boundary the trusted adapter
 * uses. Nothing about it leaks into domain code: there is no sandbox
 * lifecycle, special provider id, test credential, or behavior flag anywhere
 * in `src/`. Every outcome the send ladder must handle is expressible here.
 */

type FakeSendOutcome =
  | { readonly kind: "accepted"; readonly whatsappMessageId?: string }
  | {
      readonly kind: "rejected";
      readonly status: number;
      readonly providerCode: number;
    }
  | { readonly kind: "server_error"; readonly status: number }
  | { readonly kind: "network_failure" }
  | { readonly kind: "timeout" }
  /** A 200 that carries no message id: accepted by HTTP, unprovable by Pantry. */
  | { readonly kind: "ambiguous_body" };

export type FakeGraphOptions = {
  readonly sendOutcomes?: readonly FakeSendOutcome[];
  readonly phoneNumbers?: readonly {
    readonly id: string;
    readonly display_phone_number: string;
    readonly verified_name: string;
  }[];
  readonly grantedWabaId?: string;
  readonly grantedPortfolioId?: string;
  readonly grantedScopes?: readonly string[];
  readonly subscribeFails?: boolean;
  /** The app ids Meta reports as subscribed to the WABA. */
  readonly subscribedAppIds?: readonly string[];
  readonly tokenRevoked?: boolean;
  readonly tokenExpiresAt?: number;
};

type FakeGraphCall = {
  readonly method: string;
  readonly path: string;
  readonly body: string | null;
  readonly authorization: string | null;
};

export type FakeGraph = {
  readonly fetcher: typeof fetch;
  calls(): readonly FakeGraphCall[];
  sentBodies(): readonly string[];
};

export function createFakeGraph(options: FakeGraphOptions = {}): FakeGraph {
  const calls: FakeGraphCall[] = [];
  const sent: string[] = [];
  const sendOutcomes = [
    ...(options.sendOutcomes ?? [{ kind: "accepted" as const }]),
  ];
  let sendIndex = 0;

  const fetcher = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      method,
      path: url.pathname,
      body,
      authorization: headers.get("authorization"),
    });
    if (options.tokenRevoked === true) {
      return jsonResponse(401, {
        error: { code: 190, type: "OAuthException" },
      });
    }
    if (url.pathname.endsWith("/oauth/access_token")) {
      return jsonResponse(200, {
        access_token: "fixture-signup-token",
        token_type: "bearer",
      });
    }
    if (url.pathname.endsWith("/debug_token")) {
      return jsonResponse(200, {
        data: {
          is_valid: true,
          expires_at: options.tokenExpiresAt ?? 1_800_000_000,
          scopes: options.grantedScopes ?? [
            "whatsapp_business_management",
            "whatsapp_business_messaging",
            "business_management",
          ],
          granular_scopes: [
            {
              scope: "whatsapp_business_management",
              target_ids: [options.grantedWabaId ?? FIXTURE_WABA_ID],
            },
            {
              scope: "business_management",
              target_ids: [options.grantedPortfolioId ?? "310000000000001"],
            },
          ],
        },
      });
    }
    if (url.pathname.endsWith("/phone_numbers")) {
      return jsonResponse(200, {
        data: options.phoneNumbers ?? [
          {
            id: FIXTURE_PHONE_NUMBER_ID,
            display_phone_number: FIXTURE_DISPLAY_PHONE_NUMBER,
            verified_name: "Synthetic Bakery",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/subscribed_apps")) {
      if (method === "GET") {
        const ids = options.subscribedAppIds ?? ["1000000000000001"];
        return jsonResponse(200, {
          data: ids.map((id) => ({ whatsapp_business_api_data: { id } })),
        });
      }
      return options.subscribeFails === true
        ? jsonResponse(400, { error: { code: 100 } })
        : jsonResponse(200, { success: true });
    }
    if (url.pathname.endsWith("/messages")) {
      if (body !== null) sent.push(body);
      const outcome = sendOutcomes[
        Math.min(sendIndex, sendOutcomes.length - 1)
      ] ?? { kind: "accepted" as const };
      sendIndex += 1;
      return sendResponse(outcome, init?.signal ?? null);
    }
    return jsonResponse(200, {});
  }) as typeof fetch;

  return {
    fetcher,
    calls: () => [...calls],
    sentBodies: () => [...sent],
  };
}

async function sendResponse(
  outcome: FakeSendOutcome,
  signal: AbortSignal | null,
): Promise<Response> {
  switch (outcome.kind) {
    case "accepted":
      return jsonResponse(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: "15550002222", wa_id: "15550002222" }],
        messages: [{ id: outcome.whatsappMessageId ?? "wamid.TESTOUT0001" }],
      });
    case "rejected":
      return jsonResponse(outcome.status, {
        error: { code: outcome.providerCode },
      });
    case "server_error":
      return jsonResponse(outcome.status, { error: { code: 1 } });
    case "network_failure":
      throw new TypeError("network failure");
    case "timeout":
      return new Promise<Response>((_resolve, reject) => {
        if (signal === null) return;
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    case "ambiguous_body":
      return jsonResponse(200, { messaging_product: "whatsapp", messages: [] });
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
