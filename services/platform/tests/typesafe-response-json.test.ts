import { describe, expect, it, vi } from "vitest";
import { postSystemOne } from "@purin-labs/agent/integrations/typesafe/system-one-client";

describe("TypeSafe response JSON boundary", suite);

function suite(): void {
  it.each([
    '{"answers":{},"answers":{}}',
    '{"answers":{"supported":{"noul":0,"noul":1}}}',
    '{"answers":{"supported":0,"suppor\\u0074ed":1}}',
    '{"answers":[{"noul":0,"noul":1}]}',
    '{"usage":{"input_tokens":100,"input_tokens":0}}',
    '{"__proto__":{},"__proto__":{}}',
    '{"answers":',
  ])("rejects ambiguous or malformed JSON: %s", rejectsResponse);
  it(
    "allows repeated names in separate objects and punctuation in strings",
    acceptsResponse,
  );
}

async function request(body: string) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
  const result = await postSystemOne({
    apiKey: "apikey_synthetic-test-key-never-a-real-credential",
    body: "{}",
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetcher,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  return result;
}

async function rejectsResponse(body: string): Promise<void> {
  expect(await request(body)).toEqual({
    ok: false,
    error: { code: "jev_response_invalid" },
  });
}

async function acceptsResponse(): Promise<void> {
  const value = {
    answers: [{ noul: 0 }, { noul: 1 }],
    text: 'Escaped quote " and punctuation { [ : , } ] with slash \\',
    nested: { text: "same key, separate object", empty: {} },
  };
  expect(await request(JSON.stringify(value))).toEqual({ ok: true, value });
}
