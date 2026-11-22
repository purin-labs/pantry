import { resolveCaseReference } from "@purin-labs/authority/access-control/references";
import { readCaseScreenObservations } from "../../chat/case-screen-observations";
import type { ConversationScope } from "../../chat/store";
import type { Env } from "@purin-labs/kernel/env";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { controlError, controlJson } from "../http";

/**
 * Knowledge › Context › On screen for one Case (Plan 87 phase 5): the pages
 * that its agent received from the screens of people, from the chats that
 * the reader may see. The Case is named as the Related Cases inspector names
 * it, by its opaque reference and its revision.
 */
export async function handleCaseScreenObservationsRoute(
  request: Request,
  env: Env,
  scope: ConversationScope,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const reference = query.get("case_ref");
  const revision = Number(query.get("revision"));
  if (
    reference === null ||
    !/^case_[a-f0-9]{32}$/.test(reference) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    return controlError("case_screen_observations_invalid", 422);
  const caseId = await resolveCaseReference(
    { env, organisationId: scope.organisationId, now: Date.now() },
    reference,
    revision,
  );
  if (!caseId.ok)
    return controlError("case_screen_observations_unavailable", 404);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    scope.organisationId,
  );
  if (!execution.ok)
    return controlError("case_screen_observations_unavailable", 503);
  const observations = await readCaseScreenObservations(
    execution.value.database,
    scope,
    caseId.value,
  );
  return controlJson({ ok: true, observations });
}
