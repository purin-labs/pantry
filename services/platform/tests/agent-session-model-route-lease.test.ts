import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { prepareInitialOrganisationPlacementInsert } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import { createMigratedDatabase } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { describe, expect, test, vi } from "vitest";
import { PLATFORM_DEFAULT_PI_MODEL } from "../src/actors/pi-model-transport";

const organisationCredentialMock = vi.hoisted(() => ({
  resolveOrganisationModelCredentialForRoute: vi.fn(),
}));

vi.mock(
  "@purin-labs/authority/credential-vault/index",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@purin-labs/authority/credential-vault/index")
    >()),
    resolveOrganisationModelCredentialForRoute:
      organisationCredentialMock.resolveOrganisationModelCredentialForRoute,
  }),
);

import { createEmbeddedHarnessModelRouteLease } from "../src/actors/session/model-route";
import { requireSessionId, requireOrganisationId } from "./test-ids";

const organisationId = requireOrganisationId("organisation_route_lease");
const sessionId = requireSessionId("session_route_lease");

describe("AgentSession model-route leases", agentSessionModelRouteLeaseSuite);

function agentSessionModelRouteLeaseSuite(): void {
  test(
    "resolves the platform OpenRouter key and rejects a missing key",
    resolvesPlatformOpenRouterKey,
  );
  test(
    "resolves an organisation OpenAI key without a platform fallback",
    resolvesOrganisationOpenAiKey,
  );
}

async function resolvesPlatformOpenRouterKey(): Promise<void> {
  const route = {
    keySource: "platform" as const,
    provider: "openai-compatible" as const,
    model: PLATFORM_DEFAULT_PI_MODEL,
  };

  const resolved = await createEmbeddedHarnessModelRouteLease({
    env: testEnv({ OPENROUTER_API_KEY: "  openrouter-test-key  " }),
    scope: await leaseScope(),
    sessionId,
    modelRoute: route,
  });

  expect(resolved).toMatchObject({
    ok: true,
    value: { kind: "platform_api_key" },
  });
  if (!resolved.ok || resolved.value.kind !== "platform_api_key") return;
  await expect(resolved.value.resolveModelApiKey()).resolves.toBe(
    "openrouter-test-key",
  );

  const missing = await createEmbeddedHarnessModelRouteLease({
    env: testEnv({}),
    scope: await leaseScope(),
    sessionId,
    modelRoute: route,
  });
  expect(missing).toMatchObject({
    ok: true,
    value: { kind: "platform_api_key" },
  });
  if (!missing.ok || missing.value.kind !== "platform_api_key") return;
  await expect(missing.value.resolveModelApiKey()).rejects.toThrow(
    "embedded_harness_model_credential_unavailable",
  );
}

async function resolvesOrganisationOpenAiKey(): Promise<void> {
  const route = {
    keySource: "organisation_byo" as const,
    provider: "openai" as const,
    model: "gpt-5.6-luna",
    byoKeyRef: "vault:organisation_route_lease:openai:model:g1",
  };
  const env = testEnv({ OPENROUTER_API_KEY: "must-not-be-used", DB: {} });
  organisationCredentialMock.resolveOrganisationModelCredentialForRoute.mockResolvedValueOnce(
    {
      ok: true,
      value: {
        provider: "openai",
        handle: route.byoKeyRef,
        apiKey: "sk-organisation-openai-key-1234567890",
      },
    },
  );

  const scope = await leaseScope();
  const resolved = await createEmbeddedHarnessModelRouteLease({
    env,
    scope,
    sessionId,
    modelRoute: route,
  });
  expect(resolved).toMatchObject({
    ok: true,
    value: { kind: "organisation_openai_api_key" },
  });
  if (!resolved.ok || resolved.value.kind !== "organisation_openai_api_key")
    return;
  await expect(resolved.value.resolveModelApiKey()).resolves.toBe(
    "sk-organisation-openai-key-1234567890",
  );

  organisationCredentialMock.resolveOrganisationModelCredentialForRoute.mockResolvedValueOnce(
    {
      ok: false,
      error: { code: "organisation_openai_credential_scope_mismatch" },
    },
  );
  await expect(resolved.value.resolveModelApiKey()).rejects.toThrow(
    "embedded_harness_model_credential_unavailable",
  );
}

function testEnv(overrides: Record<string, unknown>): UnitTestEnv {
  return overrides as unknown as UnitTestEnv;
}

async function leaseScope(): Promise<OrganisationExecutionScope> {
  const db = createMigratedDatabase();
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Route fixture', 'beta', 1, 'active')",
    )
    .bind(organisationId)
    .run();
  await prepareInitialOrganisationPlacementInsert(
    db,
    organisationId,
    "development",
    TEST_INITIAL_ORGANISATION_PLACEMENT,
    1,
  ).run();
  const env = platformEnv({
    DB: db,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  return scope.value;
}
