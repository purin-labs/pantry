import { describe, expect, it, vi } from "vitest";

import { CASE_CONTEXT_DISCOVERY_JEV_MODEL } from "@purin-labs/agent/case-context-discovery/jev";
import { evaluateFixtureJevRelationships } from "./fixtures/jev-request";
import {
  caseContextDiscoveryReadiness,
  parseCaseContextDiscoveryPolicy,
} from "@purin-labs/agent/case-context-discovery/policy";

const KEY = "apikey_synthetic-test-key-never-a-real-credential";
const COMPARISON = {
  evidence: "The flour delivery for purchase request 842 is late.",
  candidates: [
    {
      candidateId: "case-context-collection-842",
      evidence:
        "Supplier reports a delay to the flour delivery for purchase request 842.",
    },
  ],
};

describe("bounded JEV CaseContextCollection client", suite);

function suite(): void {
  it(
    "uses the direct TypeSafe endpoint and accounts for its documented token price",
    directTypeSafe,
  );
  it(
    "retains the submitted candidate identity across asynchronous I/O",
    retainsCandidateIdentity,
  );
  it(
    "calls the injected fetcher without rebinding its receiver",
    callsFetcherWithoutReceiver,
  );
  it(
    "pins the model and binds choices to runtime IDs without sending identifiers",
    pinsRequest,
  );
  it(
    "does not call the provider without a key or with unbounded or ambiguous input",
    rejectsInvalidInput,
  );
  it.each([
    { model: "jev-preview" },
    { answers: { candidate_0: { type: "choice", choice: "send_reply" } } },
    { answers: { customer_42: { type: "choice", choice: "same_issue" } } },
    { answers: {} },
    {
      answers: {
        candidate_0: { type: "choice", choice: "same_issue", confidence: 1.1 },
      },
    },
    { usage: { input_tokens: -1, output_tokens: 2 } },
    { usage: { input_tokens: 10.5, output_tokens: 2 } },
  ])("rejects malformed responses and route drift: %j", rejectsResponse);
  it.each([401, 403, 402, 429, 500, 302])(
    "never retries/falls back after HTTP %s",
    rejectsHttpFailure,
  );
  it(
    "bounds chunked responses and does not return provider content in errors",
    boundsResponse,
  );
  it(
    "cancels before dispatch and bounds a slow provider request",
    cancelsRequest,
  );
  it(
    "keeps disabled, missing-key, unlisted, Gmail and reply-context routes inactive",
    gatesFeature,
  );
}

async function directTypeSafe(): Promise<void> {
  const fixture = response();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      ...fixture,
      model: "jev-1.13.0",
      usage: { input_tokens: 1000, output_tokens: 12 },
    }),
  );
  const result = await evaluateFixtureJevRelationships({
    apiKey: KEY,
    comparison: COMPARISON,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetcher,
  });
  expect(result).toMatchObject({
    ok: true,
    value: { model: "jev-1.13.0", usage: { costMicrousd: 42 } },
  });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe("jev-1.13.0");
  expect(body).not.toHaveProperty("provider");
}

async function pinsRequest(): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(response()));
  const result = await evaluateFixtureJevRelationships({
    apiKey: KEY,
    comparison: COMPARISON,
    timeoutMs: 100,
    signal: new AbortController().signal,
    fetcher,
  });
  expect(result).toMatchObject({
    ok: true,
    value: {
      model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
      decisions: [
        {
          candidateId: "case-context-collection-842",
          outcome: "same_issue",
          confidence: 1,
        },
      ],
    },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(init?.redirect).toBe("manual");
  expect(init?.headers).toEqual({
    authorization: `Bearer ${KEY}`,
    "content-type": "application/json",
  });
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe(CASE_CONTEXT_DISCOVERY_JEV_MODEL);
  expect(body).not.toHaveProperty("provider");
  expect(body.state).toEqual({
    incoming: COMPARISON.evidence,
    candidates: { candidate_0: COMPARISON.candidates[0]!.evidence },
  });
  expect(Object.keys(body.questions)).toEqual(["candidate_0"]);
  expect(String(init?.body)).not.toContain("case-context-collection-842");
  expect(String(init?.body)).not.toContain(KEY);
}

async function callsFetcherWithoutReceiver(): Promise<void> {
  const result = await evaluateFixtureJevRelationships({
    apiKey: KEY,
    comparison: COMPARISON,
    timeoutMs: 100,
    signal: new AbortController().signal,
    fetcher: receiverSensitiveFetcher,
  });
  expect(result.ok).toBe(true);
}

function receiverSensitiveFetcher(
  this: void,
  _request: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> {
  if (this !== undefined) throw new Error("fetcher receiver was rebound");
  return Promise.resolve(Response.json(response()));
}

async function rejectsInvalidInput(): Promise<void> {
  const fetcher = vi.fn<typeof fetch>();
  const base = {
    apiKey: KEY,
    comparison: COMPARISON,
    timeoutMs: 100,
    signal: new AbortController().signal,
    fetcher,
  };
  expect(
    await evaluateFixtureJevRelationships({ ...base, apiKey: "" }),
  ).toEqual({
    ok: false,
    error: { code: "jev_credential_unavailable" },
  });
  expect(
    (
      await evaluateFixtureJevRelationships({
        ...base,
        comparison: { evidence: "x", candidates: [] },
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await evaluateFixtureJevRelationships({
        ...base,
        comparison: {
          evidence: "x",
          candidates: Array(6).fill(COMPARISON.candidates[0]),
        },
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await evaluateFixtureJevRelationships({
        ...base,
        comparison: {
          evidence: "x",
          candidates: [COMPARISON.candidates[0]!, COMPARISON.candidates[0]!],
        },
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await evaluateFixtureJevRelationships({
        ...base,
        comparison: {
          evidence: "x".repeat(8193),
          candidates: COMPARISON.candidates,
        },
      })
    ).ok,
  ).toBe(false);
  expect(
    (await evaluateFixtureJevRelationships({ ...base, timeoutMs: Infinity }))
      .ok,
  ).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
}

async function rejectsResponse(patch: Record<string, unknown>): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...response(), ...patch }));
  expect(
    await evaluateFixtureJevRelationships({
      apiKey: KEY,
      comparison: COMPARISON,
      timeoutMs: 100,
      signal: new AbortController().signal,
      fetcher,
    }),
  ).toEqual({ ok: false, error: { code: "jev_response_invalid" } });
}

async function rejectsHttpFailure(status: number): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("private provider error", { status }));
  const result = await evaluateFixtureJevRelationships({
    apiKey: KEY,
    comparison: COMPARISON,
    timeoutMs: 100,
    signal: new AbortController().signal,
    fetcher,
  });
  const code =
    status === 401 || status === 403
      ? "jev_credential_rejected"
      : status === 402
        ? "jev_budget_exhausted"
        : "jev_unavailable";
  expect(result).toEqual({ ok: false, error: { code } });
  expect(fetcher).toHaveBeenCalledTimes(1);
}

async function boundsResponse(): Promise<void> {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("private".repeat(6000)));
  expect(
    await evaluateFixtureJevRelationships({
      apiKey: KEY,
      comparison: COMPARISON,
      timeoutMs: 100,
      signal: new AbortController().signal,
      fetcher,
    }),
  ).toEqual({ ok: false, error: { code: "jev_response_invalid" } });
}

async function cancelsRequest(): Promise<void> {
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn<typeof fetch>();
  expect(
    await evaluateFixtureJevRelationships({
      apiKey: KEY,
      comparison: COMPARISON,
      timeoutMs: 100,
      signal: controller.signal,
      fetcher,
    }),
  ).toEqual({ ok: false, error: { code: "jev_cancelled" } });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    evaluateFixtureJevRelationships({
      apiKey: KEY,
      comparison: COMPARISON,
      timeoutMs: 5,
      signal: new AbortController().signal,
      fetcher: waitForAbort,
    }),
  ).resolves.toEqual({ ok: false, error: { code: "jev_cancelled" } });
}

async function waitForAbort(
  _request: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const signal = init?.signal;
  if (signal === undefined || signal === null)
    throw new Error("signal missing");
  return new Promise(waitForAbortExecutor.bind(null, signal));
}

function waitForAbortExecutor(
  signal: AbortSignal,
  _resolve: (response: Response) => void,
  reject: (reason: unknown) => void,
): void {
  if (signal.aborted) reject(signal.reason);
  else
    signal.addEventListener(
      "abort",
      reject.bind(null, new Error("synthetic cancellation")),
      { once: true },
    );
}

function gatesFeature(): void {
  const disabled = { mode: "disabled" } as const;
  expect(
    caseContextDiscoveryReadiness({
      policy: disabled,
      credential: { provider: "typesafe" as const, apiKey: KEY, authority: { kind: "organisation_byo" as const, connectionRevision: 1 } },
      source: "commerce",
      integrationAccountId: "account-1",
    }),
  ).toEqual({ kind: "inactive", reason: "disabled" });
  const enabled = parseCaseContextDiscoveryPolicy(policy());
  expect(enabled.ok).toBe(true);
  if (!enabled.ok) return;
  const input = {
    policy: enabled.value,
    credential: { provider: "typesafe" as const, apiKey: KEY, authority: { kind: "organisation_byo" as const, connectionRevision: 1 } },
    source: "commerce" as const,
    integrationAccountId: "account-1",
  };
  expect(caseContextDiscoveryReadiness(input).kind).toBe("ready");
  expect(
    caseContextDiscoveryReadiness({
      ...input,
      credential: {
        ...input.credential,
        authority: { kind: "organisation_byo", connectionRevision: 2 },
      },
    }),
  ).toEqual({
    kind: "inactive",
    reason: "credential_unavailable",
  });
  expect(caseContextDiscoveryReadiness({ ...input, credential: null })).toEqual(
    {
      kind: "inactive",
      reason: "credential_unavailable",
    },
  );
  expect(
    caseContextDiscoveryReadiness({
      ...input,
      integrationAccountId: "other-account",
    }),
  ).toEqual({ kind: "inactive", reason: "source_not_enabled" });
  const gmail = parseCaseContextDiscoveryPolicy({
    ...policy(),
    sources: [{ source: "gmail", integrationAccountId: "account-1" }],
  });
  if (!gmail.ok) throw new Error("fixture invalid");
  expect(
    caseContextDiscoveryReadiness({
      ...input,
      policy: gmail.value,
      source: "gmail",
    }),
  ).toMatchObject({ kind: "ready" });
  const reply = parseCaseContextDiscoveryPolicy({
    ...policy(),
    mode: "party_context",
  });
  if (!reply.ok) throw new Error("fixture invalid");
  expect(
    caseContextDiscoveryReadiness({ ...input, policy: reply.value }),
  ).toEqual({
    kind: "inactive",
    reason: "recipient_isolation_unavailable",
  });
  expect(
    parseCaseContextDiscoveryPolicy({ mode: "disabled", route: policy().route })
      .ok,
  ).toBe(false);
  expect(
    parseCaseContextDiscoveryPolicy({
      ...policy(),
      route: { ...policy().route, model: "jev-preview" },
    }).ok,
  ).toBe(false);
}

function policy() {
  return {
    mode: "shadow",
    route: {
      provider: "typesafe",
      connectionRevision: 1,
      funding: "organisation_byo",
      credentialRef: "organisation_typesafe",
    },
    sources: [{ source: "commerce", integrationAccountId: "account-1" }],
    limits: {
      maxEvaluations: 5,
      maxConcurrentEvaluations: 5,
      maxInputBytes: 100_000,
      maxInputTokens: 5 * 65_536,
      maxWallMs: 50_000,
      maxCostMicrousd: 50_000,
      reservationMicrousd: 10_000,
      requestTimeoutMs: 10_000,
    },
  };
}

function response() {
  return {
    model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
    answers: {
      candidate_0: { type: "choice", choice: "same_issue", confidence: 1 },
    },
    usage: { input_tokens: 200, output_tokens: 30, cost: 0.00002 },
  };
}

async function retainsCandidateIdentity(): Promise<void> {
  const candidate = {
    candidateId: "submitted",
    evidence: "Synthetic PR-842 delivery delay.",
  };
  const result = await evaluateFixtureJevRelationships({
    apiKey: KEY,
    comparison: {
      evidence: "Synthetic PR-842 is late.",
      candidates: [candidate],
    },
    timeoutMs: 100,
    signal: new AbortController().signal,
    fetcher: mutateCandidateDuringFetch.bind(null, candidate),
  });
  expect(result).toMatchObject({
    ok: true,
    value: { decisions: [{ candidateId: "submitted" }] },
  });
}

async function mutateCandidateDuringFetch(candidate: {
  candidateId: string;
}): Promise<Response> {
  candidate.candidateId = "replaced-after-dispatch";
  return Response.json(response());
}
