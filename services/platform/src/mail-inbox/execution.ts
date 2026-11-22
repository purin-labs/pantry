import type { GlobalDatabase } from "@purin-labs/kernel/database-handles";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { isActorExecutionActive } from "../actors/actor-execution-quiescence";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  authorizeSessionTurnExecution,
  type SessionTurnExecution,
} from "../chat/turn-access";

export type MailConnectorContext = Readonly<{
  env: Env;
  storage: DurableObjectStorage;
  scope: OrganisationExecutionScope;
  fetcher?: typeof fetch;
}>;

export async function fetchConnectorMail(
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
  fetcher: typeof fetch,
  request: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (!(await isActorExecutionActive(sql, scope)))
    throw new Error("connector_placement_conflict");
  return fetcher(request, init);
}

export async function isSessionMailExecutionActive(
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
  globalDatabase: GlobalDatabase,
  execution: SessionTurnExecution,
): Promise<boolean> {
  if (!(await isActorExecutionActive(sql, scope))) return false;
  const authorized = await authorizeSessionTurnExecution(
    globalDatabase,
    scope.database,
    scope.organisationId,
    execution,
    scope.accountAccess,
  );
  return authorized && (await isActorExecutionActive(sql, scope));
}

export async function fetchSessionConnectorMail(
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
  globalDatabase: GlobalDatabase,
  execution: SessionTurnExecution,
  fetcher: typeof fetch,
  request: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (
    !(await isSessionMailExecutionActive(sql, scope, globalDatabase, execution))
  )
    throw new Error("session_execution_authority_inactive");
  // The caller settles issued effects before checking protected release.
  return fetcher(request, init);
}
