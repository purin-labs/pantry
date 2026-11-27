import { describe, expect, it, vi } from "vitest";
import { probeTypeSafeConnection } from "@purin-labs/agent/typesafe/connection-probe";

describe("TypeSafe connection probe", suite);

function suite(): void {
  it(
    "sends only fixed synthetic text and verifies connectivity independently of semantic confidence",
    probesConnection,
  );
  it.each([
    { model: "jev-latest" },
    { answers: {} },
    { answers: { in_transit: { type: "choice", choice: "yes" } } },
    { answers: { in_transit: { type: "noul", noul: -0.1 } } },
    { answers: { in_transit: { type: "noul", noul: 1.1 } } },
    { answers: { in_transit: { type: "noul", noul: "0.95" } } },
    {
      answers: {
        in_transit: { type: "noul", noul: 1 },
        extra: { type: "noul", noul: 1 },
      },
    },
    { usage: { input_tokens: -1, output_tokens: 1 } },
    { usage: { input_tokens: 1, output_tokens: 0.5 } },
  ])("rejects malformed provider contracts: %j", rejectsResponse);
}

function response() {
  return {
    model: "jev-1.13.0",
    answers: { in_transit: { type: "noul", noul: 0 } },
    usage: { input_tokens: 50, output_tokens: 5 },
  };
}

async function probesConnection(): Promise<void> {
  const apiKey = "apikey_synthetic-probe-test-credential";
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(response()));
  await expect(
    probeTypeSafeConnection({
      apiKey,
      fetcher,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ ok: true, value: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  const body = String(init?.body);
  expect(body).not.toContain(apiKey);
  expect(JSON.parse(body)).toMatchObject({
    model: "jev-1.13.0",
    state: expect.stringContaining("synthetic connection test"),
    questions: { in_transit: { type: "noul" } },
  });
}

async function rejectsResponse(patch: Record<string, unknown>): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...response(), ...patch }));
  await expect(
    probeTypeSafeConnection({
      apiKey: "apikey_synthetic-probe-test-credential",
      fetcher,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ ok: false, error: { code: "jev_response_invalid" } });
}
