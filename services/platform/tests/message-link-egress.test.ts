import { describe, expect, it } from "vitest";

import {
  createWorkerMessageLinkEgress,
  parseMessageLinkFetchResponse,
  type MessageLinkFetchNamespace,
  type MessageLinkFetchTransport,
} from "../src/messages/link-egress";
import {
  MESSAGE_LINK_POLICY,
  readMessageLink,
  type MessageLinkEgress,
} from "../src/messages/link-reader";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "@purin-labs/tenancy/placement";
import { isRecord } from "@purin-labs/std";

describe("worker message link egress", function egressSuite() {
  it("resolves A and AAAA records over DNS-over-HTTPS without starting the container", async function resolvesBoth() {
    let lookedUp = false;
    const namespace = namespaceFor(
      function containerFetch(): Promise<Response> {
        lookedUp = true;
        return Promise.resolve(
          serviceResponse(servicePayload("text/plain", null, "unused")),
        );
      },
    );
    const asked: string[] = [];
    const egress = egressFor(
      namespace,
      dohFetcherFor(asked, ["93.184.216.34"], ["2606:2800:220:1::1"]),
    );

    expect(await egress.resolve("example.com", testDeadline())).toEqual([
      "93.184.216.34",
      "2606:2800:220:1::1",
    ]);
    expect(asked.sort()).toEqual(["example.com/A", "example.com/AAAA"]);
    expect(lookedUp).toBe(false);
  });

  it("ignores CNAME hops and keeps only terminal addresses", async function ignoresCname() {
    const egress = egressFor(
      namespaceFor(unexpectedContainerFetch),
      dohFetcherFor([], ["93.184.216.34"], []),
    );

    const result = await egress.resolve("www.example.com", testDeadline());

    expect(result).toEqual(["93.184.216.34"]);
  });

  it("treats a silent resolver as no answer, not as permission", async function silentResolver() {
    const egress = egressFor(
      namespaceFor(unexpectedContainerFetch),
      failingDohFetcher,
    );

    expect(await egress.resolve("example.com", testDeadline())).toEqual([]);
    expect(
      await readMessageLink({ url: "https://example.com/x", egress }),
    ).toEqual({
      ok: false,
      error: { code: "destination_not_public", reason: "unresolvable" },
    });
  });

  it("refuses a name the resolver answers with a private address before starting the container", async function refusesPrivateAnswer() {
    let lookedUp = false;
    const namespace = namespaceFor(
      function containerFetch(): Promise<Response> {
        lookedUp = true;
        return Promise.resolve(
          serviceResponse(servicePayload("text/plain", null, "secret")),
        );
      },
    );
    const egress = egressFor(namespace, dohFetcherFor([], ["10.0.0.5"], []));

    expect(
      await readMessageLink({ url: "https://rebind.example.com/", egress }),
    ).toEqual({
      ok: false,
      error: { code: "destination_not_public", reason: "private" },
    });
    expect(lookedUp).toBe(false);
  });

  it("does not ask a resolver about an address literal", async function skipsLiteral() {
    let asked = false;
    const egress = egressFor(
      namespaceFor(unexpectedContainerFetch),
      function unexpectedDoh(): Promise<Response> {
        asked = true;
        return Promise.resolve(
          dohResponse([{ type: 1, data: "93.184.216.34" }]),
        );
      },
    );

    expect(await egress.resolve("127.0.0.1", testDeadline())).toEqual([
      "127.0.0.1",
    ]);
    expect(await egress.resolve("[::1]", testDeadline())).toEqual(["::1"]);
    expect(asked).toBe(false);
  });

  it("passes the validated address to the pinned service and reconstructs only approved fields", async function passesPinnedRequest() {
    const requests: RequestRecord[] = [];
    const namespace = namespaceFor(
      recordingContainerFetch.bind(undefined, requests),
    );
    const egress = egressFor(
      namespace,
      dohFetcherFor([], ["93.184.216.34"], []),
    );

    const result = await readMessageLink({
      url: "https://example.com/page?token=secret",
      egress,
    });

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);

    const request = requests[0];

    if (request === undefined) {
      throw new Error("expected one container request");
    }

    expect(request.input).toBe("http://container/v1/fetch");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({
      "content-type": "application/json",
    });
    expect(request.body).toEqual({
      url: "https://example.com/page?token=secret",
      address: "93.184.216.34",
      deadlineAtUnixMs: expect.any(Number),
      maxBytes: 5 * 1024 * 1024,
    });
    expect(request.body.deadlineAtUnixMs).toBeGreaterThanOrEqual(Date.now());
    expect(request.body.deadlineAtUnixMs - Date.now()).toBeLessThanOrEqual(
      10_000,
    );

    if (!result.ok) {
      throw new Error("expected a successful link read");
    }

    expect(result.value.content).toEqual({
      kind: "text",
      text: "Quote is 3.50 per unit",
      truncated: false,
    });
    expect(result.value.receipt.requestedOrigin).toBe("https://example.com");
    expect(JSON.stringify(result.value.receipt)).not.toContain("secret");
  });

  it("preserves a service redirect for reader-side revalidation", async function preservesRedirect() {
    let calls = 0;
    const egress = egressFor(
      namespaceFor(function redirectingContainerFetch(): Promise<Response> {
        calls += 1;

        return calls === 1
          ? Promise.resolve(
              serviceResponse({
                status: 302,
                contentType: null,
                location: "https://example.com/final",
                bodyBase64: "",
              }),
            )
          : Promise.resolve(
              serviceResponse(servicePayload("text/plain", null, "final")),
            );
      }),
      dohFetcherFor([], ["93.184.216.34"], []),
    );

    const result = await readMessageLink({
      url: "https://example.com/start",
      egress,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);

    if (!result.ok) {
      throw new Error("expected a successful redirected read");
    }

    expect(result.value.content).toEqual({
      kind: "text",
      text: "final",
      truncated: false,
    });
    expect(result.value.receipt.redirectCount).toBe(1);
  });

  it("does not forward service cookies or unrelated headers", async function dropsUnapprovedHeaders() {
    const egress = egressFor(
      namespaceFor(function containerFetch(): Promise<Response> {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 200,
              contentType: "text/plain",
              location: null,
              bodyBase64: encodeBytes(new TextEncoder().encode("hello")),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "set-cookie": "service=secret",
              },
            },
          ),
        );
      }),
      dohFetcherFor([], ["93.184.216.34"], []),
    );

    const response = await egress.fetchValidated(
      new URL("https://example.com/page"),
      "93.184.216.34",
      testDeadline(),
    );

    expect([...response.headers.keys()]).toEqual(["content-type"]);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("hello");
  });

  it("rejects malformed or expanded service envelopes", function rejectsMalformedResponses() {
    const valid = {
      status: 200,
      contentType: "text/plain",
      location: null,
      bodyBase64: encodeBytes(new TextEncoder().encode("hello")),
    };

    expect(
      parseMessageLinkFetchResponse(JSON.stringify({ ...valid, extra: true })),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "response" },
    });
    expect(
      parseMessageLinkFetchResponse(
        JSON.stringify({ ...valid, bodyBase64: "%%%" }),
      ),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "bodyBase64" },
    });
    expect(
      parseMessageLinkFetchResponse(
        JSON.stringify({
          ...valid,
          status: 204,
          bodyBase64: encodeBytes(new TextEncoder().encode("body")),
        }),
      ),
    ).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "bodyBase64" },
    });
  });

  it("accepts a service body at the five MiB boundary", function acceptsMaximumBody() {
    const bytes = new Uint8Array(MESSAGE_LINK_POLICY.maxTransferBytes);
    bytes.fill(65);
    const parsed = parseMessageLinkFetchResponse(
      JSON.stringify({
        status: 200,
        contentType: "application/octet-stream",
        location: null,
        bodyBase64: encodeBytes(bytes),
      }),
    );

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      throw new Error("expected maximum bounded body to parse");
    }

    expect(parsed.value.body.byteLength).toBe(
      MESSAGE_LINK_POLICY.maxTransferBytes,
    );
  });

  it("reports a service response-size rejection as response_too_large", async function mapsResponseLimit() {
    const egress = egressFor(
      namespaceFor(function containerFetch(): Promise<Response> {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "response_too_large" }), {
            status: 413,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
      dohFetcherFor([], ["93.184.216.34"], []),
    );

    expect(
      await readMessageLink({ url: "https://example.com/page", egress }),
    ).toEqual({
      ok: false,
      error: {
        code: "response_too_large",
        limitBytes: MESSAGE_LINK_POLICY.maxTransferBytes,
      },
    });
  });
});

type ServicePayload = {
  readonly status: number;
  readonly contentType: string | null;
  readonly location: string | null;
  readonly bodyBase64: string;
};

type RequestBody = {
  readonly url: string;
  readonly address: string;
  readonly deadlineAtUnixMs: number;
  readonly maxBytes: number;
};

type RequestRecord = {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit;
  readonly body: RequestBody;
};

function egressFor(
  namespace: MessageLinkFetchNamespace,
  dohFetcher: Parameters<typeof createWorkerMessageLinkEgress>[2],
): MessageLinkEgress {
  return createWorkerMessageLinkEgress(namespace, placement(), dohFetcher);
}

function placement(): OrganisationPlacement {
  const parsed = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "link-egress",
    locationHint: "apac",
  });

  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }

  return parsed.value;
}

function namespaceFor(
  fetcher: MessageLinkFetchTransport["fetch"],
): MessageLinkFetchNamespace {
  return { getByName: getNamedTransport.bind(undefined, fetcher) };
}

function getNamedTransport(
  fetcher: MessageLinkFetchTransport["fetch"],
  name: string,
  options?: { readonly locationHint?: string },
): MessageLinkFetchTransport {
  if (name !== "public-links:apac" || options?.locationHint !== "apac") {
    throw new Error(`unexpected container address: ${name}`);
  }

  return { fetch: fetcher };
}

function recordingContainerFetch(
  requests: RequestRecord[],
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (init === undefined || typeof init.body !== "string") {
    throw new Error("expected JSON request body");
  }

  const body = parseRequestBody(init.body);

  requests.push({ input, init, body });
  return Promise.resolve(
    serviceResponse(
      servicePayload("text/html", null, "<p>Quote is 3.50 per unit</p>"),
    ),
  );
}

function parseRequestBody(rawBody: string): RequestBody {
  const raw: unknown = JSON.parse(rawBody);

  if (
    !isRecord(raw) ||
    typeof raw.url !== "string" ||
    typeof raw.address !== "string" ||
    typeof raw.deadlineAtUnixMs !== "number" ||
    typeof raw.maxBytes !== "number"
  ) {
    throw new Error("invalid test request body");
  }

  return {
    url: raw.url,
    address: raw.address,
    deadlineAtUnixMs: raw.deadlineAtUnixMs,
    maxBytes: raw.maxBytes,
  };
}

function servicePayload(
  contentType: string | null,
  location: string | null,
  body: string,
): ServicePayload {
  return {
    status: 200,
    contentType,
    location,
    bodyBase64: encodeBytes(new TextEncoder().encode(body)),
  };
}

function serviceResponse(payload: ServicePayload): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function dohFetcherFor(
  asked: string[],
  aAnswers: readonly string[],
  aaaaAnswers: readonly string[],
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return resolveDoh.bind(undefined, asked, aAnswers, aaaaAnswers);
}

function resolveDoh(
  asked: string[],
  aAnswers: readonly string[],
  aaaaAnswers: readonly string[],
  input: RequestInfo | URL,
): Promise<Response> {
  const url = new URL(String(input));
  const type = url.searchParams.get("type");

  asked.push(`${url.searchParams.get("name")}/${type}`);

  if (type === "A") {
    return Promise.resolve(
      dohResponse([
        { type: 5, data: "alias.example.com." },
        ...aAnswers.map((data) => ({ type: 1, data })),
      ]),
    );
  }

  return Promise.resolve(
    dohResponse(aaaaAnswers.map((data) => ({ type: 28, data }))),
  );
}

function dohResponse(
  answers: readonly { readonly type: number; readonly data: string }[],
): Response {
  return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

function failingDohFetcher(): Promise<Response> {
  return Promise.reject(new Error("resolver unreachable"));
}

function unexpectedContainerFetch(): Promise<Response> {
  return Promise.reject(new Error("container should not be called"));
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function testDeadline(): number {
  return Date.now() + MESSAGE_LINK_POLICY.timeoutMs;
}
