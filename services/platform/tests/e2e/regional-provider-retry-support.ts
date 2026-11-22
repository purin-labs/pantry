import { parseOrganisationPlacementMoveTarget } from "@purin-labs/tenancy/data/organisation-placement";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  resumeActorRelocation,
  startActorRelocation,
  type ActorRelocationId,
} from "../../src/actors/actor-relocation";
import { reconcileProviderAccountCleanup } from "../../src/provider-lifecycle/cleanup-reconciliation";
import { readProviderCleanupContext } from "../../src/provider-adapters/catalogue";
import type { IntegrationAccountId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

export async function beginRegionalProviderRetry(
  scope: OrganisationExecutionScope,
  accountId: IntegrationAccountId,
  relocationId: ActorRelocationId,
): Promise<RegionalCleanupProvider> {
  const context = await readProviderCleanupContext({
    db: scope.database,
    integrationAccountId: accountId,
    provider: "whatsapp",
    removeApplicationSubscription: true,
  });
  if (context === null) throw new Error("Missing cleanup context");
  await scope.database
    .prepare(
      `INSERT INTO provider_account_cleanup (
    cleanup_id, organisation_id, integration_account_id, provider, environment, lifecycle,
    attempt, next_attempt_at, created_at, updated_at, provider_account_id,
    provider_connection_id, credential_handles, provider_context
  ) SELECT 'cleanup_regional', organisation_id, integration_account_id, provider, environment,
    'pending_provider_cleanup', 0, 1, 1, 1, provider_account_id,
    provider_connection_id, '["vault:whatsapp:regional-execution"]', ?
    FROM integration_account WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(context, scope.organisationId, accountId)
    .run();
  const provider = new RegionalCleanupProvider(scope, relocationId);
  expect(
    await reconcileProviderAccountCleanup({
      env,
      organisationId: scope.organisationId,
      now: Date.now(),
      fetcher: provider.fetch.bind(provider),
    }),
  ).toBe(1);
  expect(provider.requests).toBe(1);
  expect(
    await scope.database
      .prepare(
        "SELECT lifecycle, attempt FROM provider_account_cleanup WHERE cleanup_id = 'cleanup_regional'",
      )
      .first(),
  ).toEqual({ lifecycle: "retry_scheduled", attempt: 1 });
  return provider;
}

export async function finishRegionalProviderRetry(
  scope: OrganisationExecutionScope,
  provider: RegionalCleanupProvider,
): Promise<void> {
  const now = Date.now() + 60_000;
  expect(
    await reconcileProviderAccountCleanup({
      env,
      organisationId: scope.organisationId,
      now,
      fetcher: provider.fetch.bind(provider),
    }),
  ).toBe(1);
  expect(
    await reconcileProviderAccountCleanup({
      env,
      organisationId: scope.organisationId,
      now,
      fetcher: provider.fetch.bind(provider),
    }),
  ).toBe(0);
  expect(provider.requests).toBe(2);
  expect(
    await scope.database
      .prepare(
        "SELECT lifecycle, attempt FROM provider_account_cleanup WHERE cleanup_id = 'cleanup_regional'",
      )
      .first(),
  ).toEqual({ lifecycle: "completed", attempt: 2 });
}

class RegionalCleanupProvider {
  requests = 0;
  constructor(
    readonly source: OrganisationExecutionScope,
    readonly relocationId: ActorRelocationId,
  ) {}
  async fetch(
    request: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    expect(String(request)).toContain("/410000000000055/subscribed_apps");
    expect(init?.method).toBe("DELETE");
    this.requests += 1;
    if (this.requests === 1) {
      const target = parseOrganisationPlacementMoveTarget({
        kind: "affinity",
        placementCellId: "regional-apac",
        locationHint: "apac",
      });
      if (!target.ok) throw new Error(target.error.path);
      expect(
        await startActorRelocation({
          env,
          organisationId: this.source.organisationId,
          target: target.value,
          now: Date.now(),
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "relocation_provider_work_unresolved",
          operationId: "cleanup_regional",
        },
      });
      expect(await this.source.isActive()).toBe(true);
      const move = await resumeActorRelocation({
        env,
        relocationId: this.relocationId,
        now: Date.now(),
      });
      expect(move).toMatchObject({
        ok: false,
        error: { code: "organisation_placement_move_conflict" },
      });
      expect(
        await this.source.database
          .prepare(
            "SELECT status FROM organisation_placement WHERE organisation_id = ?",
          )
          .bind(this.source.organisationId)
          .first(),
      ).toEqual({ status: "active" });
      expect(await this.source.isActive()).toBe(true);
      return Response.json(
        { error: { message: "Retry fixture", code: 2 } },
        { status: 503 },
      );
    }
    return Response.json({ success: true });
  }
}
