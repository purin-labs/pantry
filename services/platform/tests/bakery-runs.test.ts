import { beforeEach, expect, it, vi } from "vitest";
import {
  handleBakeryRunRoute,
  matchBakeryRunRoute,
} from "@purin-labs/area-kitchen/server/control/routes/bakery-runs";
import { parseRunSnapshot } from "@purin-labs/bakery-model/bakery-run-snapshot";
import { platformEnv } from "./worker-fakes";

const mocks = vi.hoisted(createMocks);
function createMocks() {
  return { authorize: vi.fn(), put: vi.fn(), get: vi.fn(), list: vi.fn() };
}
vi.mock("@purin-labs/control/worker/authorization", authModule);
function authModule() {
  return { authorizeOrganisationRequest: mocks.authorize };
}

// The route uses only these bindings after the separately tested auth boundary.
const env = platformEnv({
  ARCHIVE: { put: mocks.put, get: mocks.get, list: mocks.list },
});
const path = "/v1/control/organisations/organisation_cafe/bakery/runs";
beforeEach(reset);
function reset() {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({
    ok: true,
    organisationId: "organisation_cafe",
    authenticated: { session: { userId: "user_4cf0dd88-f31b-5ca2-b612-a1b1178d6503" } },
  });
}

it(
  "storage failures remain retriable errors and never report a successful save",
  storageFailure,
);
async function storageFailure() {
  mocks.put.mockRejectedValue(new Error("private backend detail"));
  mocks.get.mockRejectedValue(new Error("private backend detail"));
  mocks.list.mockRejectedValue(new Error("private backend detail"));
  const document = {
    schemaVersion: 3,
    kind: "bakery-workcell-experiment",
    input: {},
    evidence: null,
    presentation: { workcell: { x: 34, y: 24 } },
  };
  const snapshot = parseRunSnapshot({ name: "Run", document });
  if (snapshot === null) throw new Error("Invalid fixture");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(snapshot.content),
  );
  const expectedId = Array.from(new Uint8Array(digest), hexByte).join("");
  const requests = [
    new Request(`https://localhost${path}`, {
      method: "POST",
      body: JSON.stringify({ expectedId, name: "Run", document }),
    }),
    new Request(`https://localhost${path}`),
    new Request(`https://localhost${path}/${"a".repeat(64)}`),
  ];
  for (const request of requests) {
    const route = matchBakeryRunRoute(new URL(request.url).pathname);
    if (route === null) throw new Error("Missing route");
    const response = await handleBakeryRunRoute(request, env, route);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "bakery_runs_unavailable",
    });
  }
}

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}
