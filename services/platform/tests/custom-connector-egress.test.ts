import { describe, expect, it } from "vitest";

import {
  executeCustomConnectorTransport,
  type CustomConnectorFetchNamespace,
  type CustomConnectorFetchTransport,
  type CustomConnectorTransportRequest,
} from "../src/custom-connectors/egress";
import { parseOrganisationId } from "../src/ids";
import { encodeBase64, isRecord } from "@seams/std";

const TEST_SECRET = "fixture-secret-93fa8f7821";

describe("custom connector credentialed egress", function egressSuite() {
  it("pins the container request to the public address selected during validation", async function pinsSelectedAddress() {
    const calls: RecordedCall[] = [];
    const result = await executeCustomConnectorTransport({
      signal: new AbortController().signal,
      authorizeDispatch: allowFixtureDispatch,
      onDispatch: recordFixtureDispatch,
      namespace: recordingNamespace(calls, successfulServiceResponse),
      request: transportRequest(new URL("https://api.example.net/v1/items")),
      dohFetcher: dohFetcherFor(["93.184.216.34"], ["2606:2800:220:1::1"]),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode('{"ok":true}'),
        sessionId: null,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("organisation_custom_connector_fixture");
    expect(calls[0]?.input).toBe("http://container/v1/fetch");
    expect(calls[0]?.body).toEqual({
      address: "93.184.216.34",
      authentication: { kind: "bearer", value: TEST_SECRET },
      operation: {
        kind: "get",
        url: "https://api.example.net/v1/items",
      },
      timeoutMs: expect.any(Number),
      maxWireBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
    });
    expect(calls[0]?.body.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.body.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(calls[0]?.body).not.toHaveProperty("deadlineAtUnixMs");
  });

  it("denies mixed public and private DNS answers before serializing the credential", async function deniesMixedAnswers() {
    const calls: RecordedCall[] = [];
    const result = await executeCustomConnectorTransport({
      signal: new AbortController().signal,
      authorizeDispatch: allowFixtureDispatch,
      onDispatch: recordFixtureDispatch,
      namespace: recordingNamespace(calls, successfulServiceResponse),
      request: transportRequest(new URL("https://rebind.example.net/v1/items")),
      dohFetcher: dohFetcherFor(["93.184.216.34", "10.0.0.7"], []),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "destination_not_public" },
    });
    expect(calls).toEqual([]);
  });

  it("denies private, metadata, and IPv4 or IPv6 transition destinations before transport", async function deniesSpecialDestinations() {
    const destinations = [
      "https://127.0.0.1/",
      "https://169.254.169.254/",
      "https://[::1]/",
      "https://[64:ff9b::7f00:1]/",
      "https://[2001:db8::1]/",
      "https://[2002:7f00:1::1]/",
      "https://metadata.google.internal/",
    ];

    for (const destination of destinations) {
      const calls: RecordedCall[] = [];
      const result = await executeCustomConnectorTransport({
        signal: new AbortController().signal,
        authorizeDispatch: allowFixtureDispatch,
        onDispatch: recordFixtureDispatch,
        namespace: recordingNamespace(calls, successfulServiceResponse),
        request: transportRequest(new URL(destination)),
        dohFetcher: dohFetcherFor([], []),
      });

      expect(result, destination).toEqual({
        ok: false,
        error: { code: "destination_not_public" },
      });
      expect(calls, destination).toEqual([]);
    }
  });

  it("rejects redirects and secret-exposure signals without returning service details", async function mapsSafeErrors() {
    const redirects = await executeCustomConnectorTransport({
      signal: new AbortController().signal,
      authorizeDispatch: allowFixtureDispatch,
      onDispatch: recordFixtureDispatch,
      namespace: fixedNamespace(
        new Response(JSON.stringify({ error: "redirect_denied" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
      ),
      request: transportRequest(new URL("https://api.example.net/v1/items")),
      dohFetcher: dohFetcherFor(["93.184.216.34"], []),
    });
    const exposed = await executeCustomConnectorTransport({
      signal: new AbortController().signal,
      authorizeDispatch: allowFixtureDispatch,
      onDispatch: recordFixtureDispatch,
      namespace: fixedNamespace(
        new Response(JSON.stringify({ error: "credential_exposed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
      ),
      request: transportRequest(new URL("https://api.example.net/v1/items")),
      dohFetcher: dohFetcherFor(["93.184.216.34"], []),
    });

    expect(redirects).toEqual({
      ok: false,
      error: { code: "redirect_denied" },
    });
    expect(exposed).toEqual({
      ok: false,
      error: { code: "credential_exposed" },
    });
    expect(JSON.stringify([redirects, exposed])).not.toContain(TEST_SECRET);
  });

  it("rejects oversized and expanded service envelopes", async function rejectsInvalidEnvelopes() {
    const oversizedBody = new Uint8Array(1024 * 1024 + 1);
    const result = await executeCustomConnectorTransport({
      signal: new AbortController().signal,
      authorizeDispatch: allowFixtureDispatch,
      onDispatch: recordFixtureDispatch,
      namespace: fixedNamespace(
        serviceResponse(200, "application/json", oversizedBody),
      ),
      request: transportRequest(new URL("https://api.example.net/v1/items")),
      dohFetcher: dohFetcherFor(["93.184.216.34"], []),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "response_too_large" },
    });

    const expanded = await executeCustomConnectorTransport({
      signal: new AbortController().signal,
      authorizeDispatch: allowFixtureDispatch,
      onDispatch: recordFixtureDispatch,
      namespace: fixedNamespace(
        new Response(
          JSON.stringify({
            status: 200,
            contentType: "application/json",
            bodyBase64: "e30=",
            extra: TEST_SECRET,
          }),
          { status: 200 },
        ),
      ),
      request: transportRequest(new URL("https://api.example.net/v1/items")),
      dohFetcher: dohFetcherFor(["93.184.216.34"], []),
    });

    expect(expanded).toEqual({
      ok: false,
      error: { code: "transport_unavailable" },
    });
    expect(JSON.stringify(expanded)).not.toContain(TEST_SECRET);
  });

  it("rejects an expired deadline before DNS or container activity", async function rejectsExpiredDeadline() {
    const calls: RecordedCall[] = [];
    let resolved = false;
    const request = transportRequest(
      new URL("https://api.example.net/v1/items"),
    );
    const result = await executeCustomConnectorTransport({
      signal: new AbortController().signal,
      authorizeDispatch: allowFixtureDispatch,
      onDispatch: recordFixtureDispatch,
      namespace: recordingNamespace(calls, successfulServiceResponse),
      request: { ...request, deadlineAtUnixMs: Date.now() - 1 },
      dohFetcher: function unexpectedResolver(): Promise<Response> {
        resolved = true;
        return Promise.resolve(dnsResponse([]));
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "deadline_expired" },
    });
    expect(resolved).toBe(false);
    expect(calls).toEqual([]);
  });
});

type RecordedCall = {
  readonly name: string;
  readonly input: RequestInfo | URL;
  readonly body: Record<string, unknown>;
};

function transportRequest(url: URL): CustomConnectorTransportRequest {
  return {
    organisationId: fixtureOrganisationId(),
    authentication: { kind: "bearer", value: TEST_SECRET },
    operation: { kind: "get", url },
    deadlineAtUnixMs: Date.now() + 10_000,
    maxWireBytes: 1024 * 1024,
    maxDecodedBytes: 1024 * 1024,
  };
}

function fixtureOrganisationId() {
  const parsed = parseOrganisationId("organisation_custom_connector_fixture");

  if (!parsed.ok) {
    throw new Error("fixture organisation id must be valid");
  }

  return parsed.value;
}

function recordingNamespace(
  calls: RecordedCall[],
  response: Response,
): CustomConnectorFetchNamespace {
  return {
    containerOf: getRecordingTransport.bind(undefined, calls, response),
  };
}

function getRecordingTransport(
  calls: RecordedCall[],
  response: Response,
  name: string,
): CustomConnectorFetchTransport {
  return {
    fetch: recordContainerFetch.bind(undefined, calls, response, name),
  };
}

function recordContainerFetch(
  calls: RecordedCall[],
  response: Response,
  name: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (init === undefined || typeof init.body !== "string") {
    throw new Error("expected a JSON container request");
  }

  const raw: unknown = JSON.parse(init.body);

  if (!isRecord(raw)) {
    throw new Error("expected a JSON object container request");
  }

  calls.push({ name, input, body: raw });
  return Promise.resolve(response.clone());
}

function fixedNamespace(response: Response): CustomConnectorFetchNamespace {
  return {
    containerOf: getFixedTransport.bind(undefined, response),
  };
}

function getFixedTransport(
  response: Response,
  _name: string,
): CustomConnectorFetchTransport {
  return { fetch: fixedContainerFetch.bind(undefined, response) };
}

function fixedContainerFetch(
  response: Response,
  _input: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(response.clone());
}

function dohFetcherFor(
  ipv4: readonly string[],
  ipv6: readonly string[],
): (input: RequestInfo | URL) => Promise<Response> {
  return resolveDohFixture.bind(undefined, ipv4, ipv6);
}

function resolveDohFixture(
  ipv4: readonly string[],
  ipv6: readonly string[],
  input: RequestInfo | URL,
): Promise<Response> {
  const url = new URL(input.toString());
  const type = url.searchParams.get("type");
  const recordType = type === "AAAA" ? 28 : 1;
  const addresses = type === "AAAA" ? ipv6 : ipv4;
  return Promise.resolve(
    dnsResponse(addresses.map(buildAddressRecord.bind(undefined, recordType))),
  );
}

function buildAddressRecord(
  recordType: number,
  address: string,
): Record<string, unknown> {
  return { type: recordType, data: address };
}

function dnsResponse(answers: readonly unknown[]): Response {
  return new Response(JSON.stringify({ Answer: answers }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

function serviceResponse(
  status: number,
  contentType: string | null,
  body: Uint8Array,
): Response {
  return new Response(
    JSON.stringify({
      status,
      contentType,
      bodyBase64: encodeBase64(body),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const successfulServiceResponse = serviceResponse(
  200,
  "application/json",
  new TextEncoder().encode('{"ok":true}'),
);

async function allowFixtureDispatch(): Promise<boolean> {
  return true;
}

function recordFixtureDispatch(): void {}
