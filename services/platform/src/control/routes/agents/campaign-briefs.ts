import type { Env } from "../../../env";
import type { Result } from "../../../result";
import { resolveUser } from "../../../data/control-plane";
import {
  decideCampaignBrief,
  listCaseCampaignBriefs,
  type CampaignMessageVariant,
} from "../../../data/campaign-brief";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  noStoreJson,
  readJsonRecord,
} from "../../http";

/**
 * Lists the campaign briefs an agent staged in one Case.
 *
 * A brief was write-only until now: the tool wrote one and nothing read it
 * back, so the review the whole feature exists for could not happen. Reading
 * is open to anyone who can see the Case, since reviewing is the point.
 */
export async function handleCampaignBriefQueue(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const caseId = new URL(request.url).searchParams.get("caseId");
  if (caseId === null || caseId.length === 0)
    return controlError("campaign_brief_invalid", 422);
  const briefs = await listCaseCampaignBriefs({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    caseId,
    now: Date.now(),
  });
  return noStoreJson({ ok: true, briefs });
}

/**
 * Records a decision on one staged brief.
 *
 * Accepting is a review record and reaches no provider — nothing here can
 * launch a campaign. A reviewer may edit the objective and the message
 * variants as they accept, so what is recorded is what they agreed to rather
 * than what the agent first wrote.
 */
export async function handleCampaignBriefDecision(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  briefIdRaw: string,
  action: "accept" | "dismiss",
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("campaign_brief_invalid", 422);
  const expectedRevision = body.value.expectedRevision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision <= 0
  ) {
    return controlError("campaign_brief_invalid", 422);
  }
  const edited =
    action === "accept"
      ? parseCampaignBriefEdit(body.value)
      : {
          ok: true as const,
          value: { objective: null, messageVariants: null },
        };
  if (!edited.ok) return controlError("campaign_brief_invalid", 422);
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const decided = await decideCampaignBrief({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    briefId: briefIdRaw,
    expectedRevision,
    decision: action === "accept" ? "accepted" : "dismissed",
    decidedByPersonId: authorized.membership.personId,
    editedObjective: edited.value.objective,
    editedMessageVariants: edited.value.messageVariants,
    now: Date.now(),
  });
  if (!decided.ok) {
    return decided.error.code === "campaign_brief_not_found"
      ? controlError("campaign_brief_not_found", 404)
      : controlError(
          decided.error.code === "campaign_brief_conflict"
            ? "campaign_brief_conflict"
            : "campaign_brief_invalid",
          decided.error.code === "campaign_brief_conflict" ? 409 : 422,
        );
  }
  return controlJson({ ok: true, briefId: briefIdRaw, decision: action });
}

function parseCampaignBriefEdit(
  body: Readonly<Record<string, unknown>>,
): Result<
  Readonly<{
    objective: string | null;
    messageVariants: readonly CampaignMessageVariant[] | null;
  }>,
  { readonly code: "campaign_brief_invalid" }
> {
  const objective = body.editedObjective ?? null;
  if (
    objective !== null &&
    (typeof objective !== "string" || objective.length === 0)
  ) {
    return { ok: false, error: { code: "campaign_brief_invalid" } };
  }
  const raw = body.editedMessageVariants ?? null;
  if (raw === null) {
    return { ok: true, value: { objective, messageVariants: null } };
  }
  if (!Array.isArray(raw))
    return { ok: false, error: { code: "campaign_brief_invalid" } };
  const variants: CampaignMessageVariant[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: { code: "campaign_brief_invalid" } };
    }
    const record = entry as Readonly<Record<string, unknown>>;
    if (
      typeof record.variantId !== "string" ||
      record.variantId.length === 0 ||
      typeof record.headline !== "string" ||
      record.headline.length === 0 ||
      typeof record.body !== "string" ||
      record.body.length === 0
    ) {
      return { ok: false, error: { code: "campaign_brief_invalid" } };
    }
    variants.push({
      variantId: record.variantId,
      headline: record.headline,
      body: record.body,
    });
  }
  return { ok: true, value: { objective, messageVariants: variants } };
}
