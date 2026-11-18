import type { Env } from "../env";
import { newRequestId, parseOrganisationId, type OrganisationId } from "../ids";
import { traceWarn } from "../observability";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { createAccountPlatformClient } from "./client";

type ReleaseCandidateRow = Readonly<{
  instanceId: unknown;
  nativeOrganisationId: unknown;
  directoryStatus: unknown;
  createdAt: unknown;
}>;

type PageCursor = Readonly<{ createdAt: number; instanceId: string }>;

/** Rows that one page reads, and pages that one run reads. */
const PAGE = 100;
const PAGES_PER_RUN = 10;

/**
 * The account platform keeps a project's instance active until Pantry reports
 * that the instance's organisation has ended. Until then the project answers
 * "ready" with the deleted organisation, and the account organisation cannot
 * be deleted. Each run reports every instance whose organisation can no
 * longer be restored. The account platform answers each report with one
 * disable or archive command for Pantry's provision route, so an instance
 * reaches archived after two runs.
 */
export async function runAccountInstanceRelease(
  env: Env,
  now: number,
): Promise<void> {
  const client = createAccountPlatformClient(env);
  if (!client.ok) return;
  // The directory copy of the Organisation row says 'purged' after the purge
  // (Refactor 15) and 'deleted' while the Organisation is archived. A purged
  // or missing Organisation has ended. An archived one has ended once its
  // purge time has come, which only its regional tombstone says. The run
  // reads the candidates in pages, so archived rows that can still be
  // restored never hold back the rows after them.
  let after: PageCursor | null = null;
  for (let page = 0; page < PAGES_PER_RUN; page += 1) {
    const cursor: PageCursor | null = after;
    const candidates: D1Result<ReleaseCandidateRow> = await env.DB.prepare(
      `SELECT b.instance_id AS instanceId,
              b.native_organisation_id AS nativeOrganisationId,
              o.status AS directoryStatus, b.created_at AS createdAt
       FROM account_service_binding b
       LEFT JOIN organisation o ON o.organisation_id = b.native_organisation_id
       WHERE b.deployment_id = ? AND b.account_state <> 'archived'
         AND (o.organisation_id IS NULL OR o.status IN ('deleted', 'purged'))
         AND (? IS NULL OR b.created_at > ? OR (b.created_at = ? AND b.instance_id > ?))
       ORDER BY b.created_at, b.instance_id
       LIMIT ${PAGE}`,
    )
      .bind(
        client.value.deploymentId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.instanceId ?? null,
      )
      .all<ReleaseCandidateRow>();
    for (const row of candidates.results) {
      if (
        typeof row.instanceId !== "string" ||
        typeof row.nativeOrganisationId !== "string"
      )
        continue;
      const organisationId = parseOrganisationId(row.nativeOrganisationId);
      if (!organisationId.ok) continue;
      if (
        row.directoryStatus === "deleted" &&
        !(await organisationEnded(env, organisationId.value, now))
      )
        continue;
      const released = await client.value.releaseInstance({
        version: 1,
        instanceId: row.instanceId,
        nativeOrganizationId: organisationId.value,
      });
      if (!released.ok)
        traceWarn("account_instance_release_failed", {
          requestId: newRequestId(),
          instance_id: row.instanceId,
          code: released.error.code,
        });
    }
    const last: ReleaseCandidateRow | undefined = candidates.results.at(-1);
    if (
      candidates.results.length < PAGE ||
      last === undefined ||
      typeof last.createdAt !== "number" ||
      typeof last.instanceId !== "string"
    )
      return;
    after = { createdAt: last.createdAt, instanceId: last.instanceId };
  }
}

/** An archived organisation ends when its purge time has come; it cannot be restored after that. */
async function organisationEnded(
  env: Env,
  organisationId: OrganisationId,
  now: number,
): Promise<boolean> {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) return false;
  const tombstone = await scope.value.database
    .prepare(
      "SELECT 1 AS ended FROM organisation_archive_tombstone WHERE organisation_id = ? AND purge_after <= ?",
    )
    .bind(organisationId, now)
    .first();
  return tombstone !== null;
}
