import type { UnitTestEnv } from "./worker-fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  actor: vi.fn(),
  read: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("../src/control/authorization", () => ({
  authorizeOrganisationRequest: mocks.authorize,
}));
vi.mock("../src/actors/actor-router", () => ({
  requireActiveOrganisationActor: mocks.actor,
}));

import { handleControlRequest } from "../src/control-router";

const URL =
  "https://satyr.example/v1/control/organisations/organisation_typesafe/integrations/typesafe";
const ENV = {} as UnitTestEnv;

describe("organisation TypeSafe control route", suite);

function suite(): void {
  beforeEach(reset);
  it("bounds bodies and sanitizes failures", boundsInput);
}

function reset(): void {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({
    ok: true,
    organisationId: "organisation_typesafe",
    membership: { userId: "user_f098b452-f6f7-5d2a-8070-1ac17b691be1" },
  });
  mocks.actor.mockResolvedValue({
    readTypeSafeConnectionConfiguration: mocks.read,
    manageTypeSafeConnection: mocks.mutate,
  });
  mocks.read.mockResolvedValue({
    ok: true,
    value: {
      connection: { kind: "disconnected", revision: 0 },
      credentialConfigured: false,
    },
  });
  mocks.mutate.mockResolvedValue({
    ok: true,
    value: { kind: "disconnected", revision: 1 },
  });
}

async function boundsInput(): Promise<void> {
  expect(
    (
      await handleControlRequest(
        new Request(URL, {
          method: "POST",
          body: JSON.stringify({ apiKey: "x".repeat(16_384) }),
        }),
        ENV,
      )
    ).status,
  ).toBe(400);
  expect(mocks.mutate).not.toHaveBeenCalled();
  mocks.read.mockRejectedValue(new Error("private provider diagnostic"));
  const response = await handleControlRequest(new Request(URL), ENV);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private provider diagnostic");
}
