import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { OrganisationModelRoute } from "../models/route";
import {
  digestModelRoute,
  resolveOrganisationModelRoute,
} from "../models/route";
import type { Env } from "../env";
import type { MailAssistantStatus } from "@purin-labs/control-api";
import type { MailOrganizationActorInput } from "./commands";
import { authorizeMailSource } from "./contract/mail-source-authorization";
import type { Result } from "../result";
import type { Variant } from "@purin-labs/type-utils";

export type MailAssistantAuthority = Readonly<{
  modelRoute: OrganisationModelRoute;
  modelRouteDigest: string;
  sourcePin: string;
  status: Variant<MailAssistantStatus, "ready">;
}>;
export async function authorizeMailAssistant(
  env: Env,
  input: MailOrganizationActorInput,
): Promise<Result<MailAssistantAuthority, Readonly<{ code: string }>>> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    input.identity.organisationId,
  );
  if (!execution.ok)
    return { ok: false, error: { code: execution.error.code } };
  const source = await authorizeMailSource(
    env,
    input.authority,
    input.integrationAccountId,
  );
  if (source === null)
    return { ok: false, error: { code: "mail_inbox_not_found" } };
  const model = await resolveOrganisationModelRoute({
    env,
    organisationId: input.identity.organisationId,
    now: Date.now(),
  });
  if (!model.ok)
    return { ok: false, error: { code: "mail_assistant_model_unavailable" } };
  const modelRouteDigest = await digestModelRoute(model.value);
  const recipient = mailAssistantRecipient(model.value);
  const row = await execution.value.database
    .prepare(
      `SELECT 1 AS eligible FROM mail_assistant_eligibility
    WHERE organisation_id = ? AND integration_account_id = ? AND source_pin = ? AND model_route_digest = ?
      AND purpose = 'mail_inbox_assistance' AND disclosed_recipient = ?
      AND reviewed_at <= ? AND review_expires_at > ? AND revoked_at IS NULL`,
    )
    .bind(
      input.identity.organisationId,
      input.integrationAccountId,
      source.sourcePin,
      modelRouteDigest,
      recipient,
      Date.now(),
      Date.now(),
    )
    .first<{ eligible: number }>();
  if (row?.eligible !== 1)
    return {
      ok: false,
      error: { code: "mail_assistant_eligibility_required" },
    };
  return {
    ok: true,
    value: {
      modelRoute: model.value,
      modelRouteDigest,
      sourcePin: source.sourcePin,
      status: {
        kind: "ready",
        model: model.value.model,
        modelRouteDigest,
        recipient,
      },
    },
  };
}
function mailAssistantRecipient(
  route: OrganisationModelRoute,
): Variant<MailAssistantStatus, "ready">["recipient"] {
  switch (route.provider) {
    case "openai-compatible":
      return "openrouter";
    case "openai":
      return "openai";
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
  }
}
