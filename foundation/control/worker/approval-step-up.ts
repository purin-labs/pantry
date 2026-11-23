import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { APPROVAL_GRANT_COOKIE, parseCookies } from "./authorization";
import { googleConfig } from "./google-oidc-config";
import { controlError } from "./http";
import { verifyGoogleApprovalGrant, type GoogleApprovalGrant } from "./oidc";
import type { ActiveControlSession } from "@purin-labs/tenancy/data/control-plane";
import { APPROVAL_STEP_UP_MAX_AGE_MS } from "@purin-labs/authority/approval-authentication";

/**
 * The step-up check of an approval route: a control session that signed in
 * within the step-up age, and a current approval grant of the same person
 * for this Organisation and action nonce. The caller still checks the
 * grant's action digest against the ledger action.
 */
export async function verifyApprovalStepUp(input: {
  readonly request: Request;
  readonly env: Env;
  readonly session: Pick<ActiveControlSession, "userId" | "createdAt">;
  readonly organisationId: OrganisationId;
  readonly actionNonce: string;
  readonly now: number;
}): Promise<Result<GoogleApprovalGrant, Response>> {
  if (input.now - input.session.createdAt > APPROVAL_STEP_UP_MAX_AGE_MS) {
    return { ok: false, error: controlError("approval_step_up_required", 401) };
  }
  const config = googleConfig(input.env);
  if (config === null) {
    return { ok: false, error: controlError("google_oidc_unconfigured", 503) };
  }
  const grantRaw = parseCookies(input.request.headers.get("cookie")).get(
    APPROVAL_GRANT_COOKIE,
  );
  if (grantRaw === undefined) {
    return { ok: false, error: controlError("approval_step_up_required", 401) };
  }
  const grant = await verifyGoogleApprovalGrant({
    raw: grantRaw,
    clientSecret: config.clientSecret,
    now: input.now,
  });
  if (
    !grant.ok ||
    grant.value.userId !== input.session.userId ||
    grant.value.challenge.expiresAt <= input.now ||
    grant.value.challenge.issuedAt > input.now ||
    grant.value.challenge.organisationId !== input.organisationId ||
    grant.value.challenge.actionNonce !== input.actionNonce
  ) {
    return { ok: false, error: controlError("approval_step_up_required", 401) };
  }
  return grant;
}
