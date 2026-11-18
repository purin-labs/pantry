import { describe, expect, it, vi } from "vitest";

import {
  classifyAddress,
  MESSAGE_LINK_POLICY,
  normalizeLinkText,
  parseAdmissibleUrl,
  readMessageLink,
  type MessageLinkEgress,
} from "../src/messages/link-reader";

describe("public message link reader", function messageLinkReaderSuite() {
  it("refuses every scheme but http and https", function refusesSchemes() {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com/",
      "javascript:alert(1)",
      "data:text/plain,hello",
    ]) {
      expect(parseAdmissibleUrl(url)).toEqual({
        ok: false,
        error: { code: "scheme_unsupported" },
      });
    }
  });

  it("refuses credentials embedded in the URL", function refusesCredentials() {
    expect(parseAdmissibleUrl("https://user:secret@example.com/x")).toEqual({
      ok: false,
      error: { code: "credentials_present" },
    });
    expect(parseAdmissibleUrl("https://user@example.com/x")).toEqual({
      ok: false,
      error: { code: "credentials_present" },
    });
  });

  it("admits only the standard HTTP and HTTPS ports", function refusesPorts() {
    expect(parseAdmissibleUrl("https://example.com/x").ok).toBe(true);
    expect(parseAdmissibleUrl("http://example.com/x").ok).toBe(true);
    expect(parseAdmissibleUrl("https://example.com:443/x").ok).toBe(true);
    expect(parseAdmissibleUrl("http://example.com:8080/x")).toEqual({
      ok: false,
      error: { code: "port_not_allowed", port: 8080 },
    });
    expect(parseAdmissibleUrl("http://example.com:22/x")).toEqual({
      ok: false,
      error: { code: "port_not_allowed", port: 22 },
    });
  });

  it("classifies every non-public address range", function classifiesAddresses() {
    const cases: readonly (readonly [string, string])[] = [
      ["127.0.0.1", "loopback"],
      ["10.1.2.3", "private"],
      ["172.16.0.1", "private"],
      ["172.31.255.255", "private"],
      ["192.168.1.1", "private"],
      // The cloud metadata endpoint.
      ["169.254.169.254", "link_local"],
      ["100.64.0.1", "carrier_grade_nat"],
      ["0.0.0.0", "unspecified"],
      ["224.0.0.1", "multicast_or_reserved"],
      ["::1", "loopback"],
      ["fe80::1", "link_local"],
      ["fd00::1", "unique_local"],
      // An IPv4-mapped loopback must not launder itself through IPv6.
      ["::ffff:127.0.0.1", "loopback"],
      ["93.184.216.34", "public"],
      ["2606:2800:220:1::1", "public"],
    ];

    for (const [address, expected] of cases) {
      expect(classifyAddress(address)).toBe(expected);
    }

    // A name is not an address.
    expect(classifyAddress("example.com")).toBeNull();
  });

  it("refuses to read at all without a validating egress", async function failsClosed() {
    // There is no unvalidated fallback: a reader with no egress does not read.
    expect(await readMessageLink({ url: "https://example.com/page" })).toEqual({
      ok: false,
      error: { code: "destination_not_verifiable" },
    });
  });

  it("hands the transport the address it validated", async function handsAddress() {
    const pinned: string[] = [];
    const result = await readMessageLink({
      url: "https://example.com/page",
      egress: egressFor({
        pinned,
        addresses: ["93.184.216.34"],
        respond: () => textResponse("hello"),
      }),
    });

    expect(result.ok).toBe(true);
    // The transport receives the address that passed destination validation;
    // the transport implementation owns the connection-time binding.
    expect(pinned).toEqual(["93.184.216.34"]);
  });

  it("refuses private destinations before issuing a request", async function refusesPrivate() {
    const calls: string[] = [];
    const egress = egressFor({ calls, respond: () => textResponse("secret") });

    for (const url of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/admin",
      "http://[::1]/admin",
      "http://service.internal/",
      "http://printer.local/",
    ]) {
      const result = await readMessageLink({ url, egress });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.code).toBe("destination_not_public");
      }
    }

    expect(calls).toEqual([]);
  });

  it("refuses a name that resolves to a private address", async function refusesRebinding() {
    const calls: string[] = [];
    const result = await readMessageLink({
      url: "https://rebind.example.com/",
      egress: egressFor({
        calls,
        addresses: ["10.0.0.5"],
        respond: () => textResponse("secret"),
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "destination_not_public", reason: "private" },
    });
    expect(calls).toEqual([]);
  });

  it("refuses a name where any answer is private", async function refusesMixedAnswers() {
    const result = await readMessageLink({
      url: "https://mixed.example.com/",
      // The transport may pick either address, so one private answer is enough.
      egress: egressFor({
        addresses: ["93.184.216.34", "127.0.0.1"],
        respond: () => textResponse("ok"),
      }),
    });

    expect(result.ok).toBe(false);
  });

  it("refuses a name that resolves to nothing", async function refusesUnresolvable() {
    const result = await readMessageLink({
      url: "https://nowhere.example.com/",
      egress: egressFor({ addresses: [], respond: () => textResponse("ok") }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "destination_not_public", reason: "unresolvable" },
    });
  });

  it("revalidates every redirect and stops at the limit", async function revalidatesRedirects() {
    let hop = 0;
    const result = await readMessageLink({
      url: "https://example.com/0",
      egress: egressFor({
        respond: function redirectForever() {
          hop += 1;
          return new Response(null, {
            status: 302,
            headers: { location: `https://example.com/${hop}` },
          });
        },
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "redirect_limit_exceeded" },
    });
    expect(hop).toBe(MESSAGE_LINK_POLICY.maxRedirects + 1);
  });

  it("does not renew the deadline across a delayed redirect", async function doesNotRenewDeadline() {
    const start = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    let resolveCalls = 0;
    let fetchCalls = 0;

    try {
      const result = await readMessageLink({
        url: "https://example.com/start",
        egress: {
          resolve: async function resolve(_hostname, deadlineAtUnixMs) {
            resolveCalls += 1;
            expect(deadlineAtUnixMs).toBe(
              start + MESSAGE_LINK_POLICY.timeoutMs,
            );
            return ["93.184.216.34"];
          },
          fetchValidated: async function fetchValidated(
            _url,
            _address,
            deadlineAtUnixMs,
          ) {
            fetchCalls += 1;
            expect(deadlineAtUnixMs).toBe(
              start + MESSAGE_LINK_POLICY.timeoutMs,
            );
            clock.mockReturnValue(deadlineAtUnixMs);
            return new Response(null, {
              status: 302,
              headers: { location: "https://example.com/final" },
            });
          },
        },
      });

      expect(result).toEqual({ ok: false, error: { code: "request_failed" } });
      expect(resolveCalls).toBe(1);
      expect(fetchCalls).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses a redirect that reaches somewhere the first URL could not", async function refusesRedirectTarget() {
    const result = await readMessageLink({
      url: "https://example.com/start",
      egress: egressFor({
        respond: function redirectToMetadata(url) {
          return url.pathname === "/start"
            ? new Response(null, {
                status: 302,
                headers: {
                  location: "http://169.254.169.254/latest/meta-data/",
                },
              })
            : textResponse("credentials");
        },
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "redirect_target_rejected",
        rejection: "destination_not_public",
      },
    });
  });

  it("bounds the decoded body rather than trusting the declared length", async function boundsBody() {
    const oversized = new Uint8Array(
      MESSAGE_LINK_POLICY.maxTransferBytes + 1_024,
    );
    const result = await readMessageLink({
      url: "https://example.com/big",
      egress: egressFor({
        respond: function respondLarge() {
          return new Response(oversized, {
            status: 200,
            // A small declared length must not let a large body through.
            headers: { "content-type": "text/plain", "content-length": "10" },
          });
        },
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "response_too_large",
        limitBytes: MESSAGE_LINK_POLICY.maxTransferBytes,
      },
    });
  });

  it("returns bounded text and a redacted receipt", async function returnsText() {
    const result = await readMessageLink({
      url: "https://example.com/docs/spec?token=super-secret#part-3",
      egress: egressFor({
        respond: function respondHtml() {
          return new Response(
            "<html><head><style>p{}</style></head><body><p>Hello</p> <script>x=1</script>world</body></html>",
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        },
      }),
    });

    if (!result.ok) {
      throw new Error(
        `expected a successful read, got ${JSON.stringify(result)}`,
      );
    }

    expect(result.value.content).toEqual({
      kind: "text",
      text: "Hello world",
      truncated: false,
    });

    const receipt = result.value.receipt;
    const serialized = JSON.stringify(receipt);

    expect(receipt.requestedOrigin).toBe("https://example.com");
    expect(receipt.mediaType).toBe("text/html");
    expect(receipt.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    // The secret in the query string never reaches the receipt.
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("/docs/spec");
    expect(serialized).not.toContain("part-3");
  });

  it("reports binary content instead of decoding it as text", async function reportsBinary() {
    const result = await readMessageLink({
      url: "https://example.com/file.pdf",
      egress: egressFor({
        respond: function respondPdf() {
          return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          });
        },
      }),
    });

    if (!result.ok) {
      throw new Error("expected a successful read");
    }

    expect(result.value.content).toEqual({ kind: "binary" });
    expect(result.value.receipt.mediaType).toBe("application/pdf");
  });

  it("truncates text at the policy limit", async function truncatesText() {
    const result = await readMessageLink({
      url: "https://example.com/long",
      egress: egressFor({
        respond: function respondLong() {
          return textResponse(
            "a".repeat(MESSAGE_LINK_POLICY.maxTextChars + 500),
          );
        },
      }),
    });

    if (!result.ok || result.value.content.kind !== "text") {
      throw new Error("expected bounded text");
    }

    expect(result.value.content.text).toHaveLength(
      MESSAGE_LINK_POLICY.maxTextChars,
    );
    expect(result.value.content.truncated).toBe(true);
  });

  it("surfaces an error status rather than its body", async function surfacesStatus() {
    const result = await readMessageLink({
      url: "https://example.com/missing",
      egress: egressFor({
        respond: function respondNotFound() {
          return new Response("not found", { status: 404 });
        },
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "status_not_ok", status: 404 },
    });
  });

  it("strips markup and collapses whitespace", function normalizesText() {
    expect(normalizeLinkText("<p>a</p>\n\n<p>b</p>", "text/html")).toBe("a b");
    expect(normalizeLinkText("<script>evil()</script>safe", "text/html")).toBe(
      "safe",
    );
    expect(normalizeLinkText("a\n\n b", "text/plain")).toBe("a b");
    expect(
      normalizeLinkText('<a href="/api/authentication">API keys</a>', "text/html"),
    ).toBe("[link: /api/authentication] API keys");
  });
});

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/**
 * A recording egress for the tests.
 *
 * It records the address each request was validated against, so a test can
 * assert the reader passed the transport what it checked.
 */
function egressFor(input: {
  readonly respond: (url: URL) => Response;
  readonly addresses?: readonly string[];
  readonly calls?: string[];
  readonly pinned?: string[];
}): MessageLinkEgress {
  return {
    resolve: async function resolve(
      _hostname: string,
      _deadlineAtUnixMs: number,
    ): Promise<readonly string[]> {
      return input.addresses ?? ["93.184.216.34"];
    },
    fetchValidated: async function fetchValidated(
      url: URL,
      address: string,
      _deadlineAtUnixMs: number,
    ): Promise<Response> {
      input.calls?.push(url.toString());
      input.pinned?.push(address);
      return input.respond(url);
    },
  };
}
