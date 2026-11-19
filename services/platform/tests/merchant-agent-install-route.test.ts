import {
  TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
/// <reference types="@cloudflare/workers-types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const controlMocks = vi.hoisted(() => ({
  authorizeOrganisationControl: vi.fn(),
  resolveControlSession: vi.fn(),
  validateControlCsrf: vi.fn(),
}));
const mutationMocks = vi.hoisted(() => ({
  readControlMutationReplay: vi.fn(),
  prepareControlMutationReceipt: vi.fn(),
}));
const policyMocks = vi.hoisted(() => ({
  readCurrentOrganisationPolicySnapshot: vi.fn(),
}));
const presetMocks = vi.hoisted(() => ({ installMerchantAgent: vi.fn() }));

vi.mock("../src/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-plane")>()),
  authorizeOrganisationControl: controlMocks.authorizeOrganisationControl,
  resolveControlSession: controlMocks.resolveControlSession,
  validateControlCsrf: controlMocks.validateControlCsrf,
}));
vi.mock("../src/data/control-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/control-mutation")>()),
  readControlMutationReplay: mutationMocks.readControlMutationReplay,
  prepareControlMutationReceipt: mutationMocks.prepareControlMutationReceipt,
}));
vi.mock("../src/policy-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/policy-snapshot")>()),
  readCurrentOrganisationPolicySnapshot: policyMocks.readCurrentOrganisationPolicySnapshot,
}));
vi.mock("../src/data/merchant-agent-preset", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/merchant-agent-preset")>()),
  installMerchantAgent: presetMocks.installMerchantAgent,
}));

import { handleControlRequest } from "../src/control-router";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ORGANISATION_ID = "organisation_urk_route";
const ROUTE = `https://pantry.example/v1/control/organisations/${ORGANISATION_ID}/agents/urk`;
const COOKIE = "satyr_control_session=session-urk; satyr_control_csrf=csrf-urk";
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 } as const;

describe("Urk installation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationMocks.readControlMutationReplay.mockResolvedValue({
      kind: "absent",
    });
    mutationMocks.prepareControlMutationReceipt.mockReturnValue({
      run: vi.fn(),
    });
    policyMocks.readCurrentOrganisationPolicySnapshot.mockResolvedValue({
      ok: true,
      value: { version: 4 },
    });
  });

  it("refuses an operator", async () => {
    authorizeAs("operator");

    const response = await handleControlRequest(installRequest(), routeEnv());

    // Installing an agent grants it capabilities; that is an admin act.
    expect(response.status).toBe(404);
    expect(presetMocks.installMerchantAgent).not.toHaveBeenCalled();
  });

  it("refuses a read of the install route", async () => {
    authorizeAs("admin");
    const response = await handleControlRequest(
      new Request(ROUTE, { headers: { cookie: COOKIE } }),
      routeEnv(),
    );
    expect(response.status).toBe(405);
  });
});

function installRequest(): Request {
  return new Request(ROUTE, {
    method: "POST",
    headers: {
      cookie: COOKIE,
      origin: "https://pantry.example",
      "x-satyr-csrf": "csrf-urk",
      "content-type": "application/json",
      "idempotency-key": "install-urk-once",
    },
    body: JSON.stringify({}),
  });
}

function authorizeAs(role: "operator" | "admin" | "owner"): void {
  const now = Date.now();
  controlMocks.resolveControlSession.mockResolvedValue({
    ok: true,
    value: {
      kind: "active",
      controlSessionId: "control_session_urk",
      userId: "user_e20853c4-28bd-598c-a7fa-37e4d878a859",
      rotationGeneration: 1,
      createdAt: now,
      rotatedAt: now,
      expiresAt: now + 60_000,
    },
  });
  controlMocks.validateControlCsrf.mockResolvedValue({ ok: true, value: true });
  controlMocks.authorizeOrganisationControl.mockImplementation(
    async (input: { readonly requiredRole: keyof typeof ROLE_RANK }) =>
      ROLE_RANK[role] >= ROLE_RANK[input.requiredRole]
        ? {
            ok: true,
            value: {
              session: undefined,
              membership: {
                kind: "active",
                organisationId: ORGANISATION_ID,
                userId: "user_e20853c4-28bd-598c-a7fa-37e4d878a859",
                personId: "person_urk",
                role,
                createdAt: now - 60_000,
              },
            },
          }
        : { ok: false, error: { code: "organisation_role_insufficient" } },
  );
}

function routeEnv(): UnitTestEnv {
  const first = vi
    .fn()
    .mockResolvedValue({
      ...TEST_ACTIVE_ORGANISATION_PLACEMENT_ROW,
      environment: "development",
    });
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ first, all, run: vi.fn() });
  return platformEnv({
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    DB: { prepare: vi.fn().mockReturnValue({ bind }), withSession: vi.fn().mockReturnThis() },
    PANTRY_PUBLIC_ORIGIN: "https://pantry.example",
  });
}
