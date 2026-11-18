/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import gateway from "../src/integration-gateway";
import {
  platformEnv,
  testExecutionContext,
  type UnitTestEnv,
} from "./worker-fakes";

const ROUTE = "https://satyr.test/v1/admin/code-mode-platform-cutover";
const ADMIN_TOKEN = "code-mode-cutover-admin-token-value";

describe("Code Mode platform cutover route", codeModePlatformCutoverRouteSuite);

function codeModePlatformCutoverRouteSuite(): void {
  it(
    "conceals the singleton without admin authority",
    concealsUnauthorizedRequest,
  );
  it("allows only GET and POST", rejectsUnsupportedMethod);
}

async function concealsUnauthorizedRequest(): Promise<void> {
  const fixture = routeFixture();
  const response = await gateway.fetch(
    new Request(ROUTE),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(response.status).toBe(404);
  expect(fixture.stub.inspectCalls).toBe(0);
}

async function rejectsUnsupportedMethod(): Promise<void> {
  const fixture = routeFixture();
  const response = await gateway.fetch(
    authorizedRequest("DELETE"),
    fixture.env,
    fakeExecutionContext(),
  );

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET, POST");
}

class CutoverStub {
  inspectCalls = 0;

  async location(): Promise<string | null> {
    return null;
  }

  async inspectCutoverQuiescence(): Promise<unknown> {
    this.inspectCalls += 1;
    return {
      ok: true,
      value: {
        schemaVersion: "code_mode_platform_cutover.v1",
        kind: "quiescent",
        inspectedAt: 100,
        admission: {
          state: "frozen",
          generation: 2,
          updatedAt: 90,
          requestId: "req-cutover",
          reason: "plan-13-cutover",
        },
        remoteEnabled: true,
        settledUnreconciled: 0,
        blockers: [],
      },
    };
  }
}

class CutoverNamespace {
  constructor(private readonly stub: CutoverStub) {}

  idFromName(): string {
    return "code-mode-platform-governor";
  }

  get(): CutoverStub {
    return this.stub;
  }
}

function routeFixture(): {
  readonly env: UnitTestEnv;
  readonly stub: CutoverStub;
} {
  const stub = new CutoverStub();
  return {
    env: platformEnv({
      ORGANISATION_ADMIN_TOKEN: ADMIN_TOKEN,
      CODE_MODE_PLATFORM_GOVERNOR_ACTOR: new CutoverNamespace(stub),
    }),
    stub,
  };
}

function authorizedRequest(method: string): Request {
  return new Request(ROUTE, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
  });
}

function fakeExecutionContext(): ExecutionContext {
  return testExecutionContext({
    waitUntil: function waitUntil(): void {},
    passThroughOnException: function passThroughOnException(): void {},
  });
}
