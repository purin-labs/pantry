import { authenticatedConversationScope } from "@purin-labs/tenancy/organisation-access/access";
import { EMPTY_BRAIN_SUMMARY, type BrainSummary } from "@purin-labs/control-api";

import { roleMayConfigure } from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import { countEvalsToReview } from "../../evals/access";
import { parseOrganisationId, type OrganisationId } from "@purin-labs/kernel/ids";
import {
  countMemoriesToReview,
  createReviewMemo,
  organisationActor,
  resolveMemoryViewer,
} from "../../memory/access";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";

export type BrainRoute = Readonly<{
  kind: "brain";
  organisationId: OrganisationId;
  operation: "summary";
}>;

export function matchBrainRoute(pathname: string): BrainRoute | null {
  const match = /^\/v1\/control\/organisations\/([^/]+)\/brain\/summary$/.exec(
    pathname,
  );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    return organisationId.ok
      ? {
          kind: "brain",
          organisationId: organisationId.value,
          operation: "summary",
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * What waits for this person's decision. The Portal shows the sum beside the
 * Brain entry of its navigation, on every page.
 *
 * A number is source-derived content, so each one counts only records that
 * this person may inspect in full, under the checks of the two lists. A
 * person who cannot decide, or who may read no Case context, receives the
 * summary of an Organisation with no records.
 */
export async function handleBrainRoute(
  request: Request,
  env: Env,
  route: BrainRoute,
): Promise<Response> {
  try {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    // The two command routes require this role, so nothing waits for the
    // decision of a person below it.
    if (!roleMayConfigure(authorized.membership.role))
      return summaryResponse(EMPTY_BRAIN_SUMMARY);
    const viewer = await resolveMemoryViewer(
      env,
      authenticatedConversationScope(
        authorized.organisationId,
        authorized.authenticated.session,
      ),
      authorized.executionScope,
    );
    if (viewer === null) return summaryResponse(EMPTY_BRAIN_SUMMARY);
    const organisation = await organisationActor(viewer);
    // One review answers a question about a label or a cited record one
    // time for both counts.
    const review = createReviewMemo();
    const [memoriesToReview, evalsToReview] = await Promise.all([
      countMemoriesToReview(viewer, organisation, review),
      countEvalsToReview(viewer, organisation, review),
    ]);
    return memoriesToReview === null || evalsToReview === null
      ? controlError("brain_summary_unavailable", 503)
      : summaryResponse({ memoriesToReview, evalsToReview });
  } catch {
    return controlError("brain_summary_unavailable", 503);
  }
}

function summaryResponse(summary: BrainSummary): Response {
  return controlJson({ ok: true, summary });
}
