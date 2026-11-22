import type { Env } from "@purin-labs/kernel/env";
import { readCurrentOrganisationPolicySnapshot } from "@purin-labs/authority/policy-snapshot";
import {
  installMerchantAgent,
  merchantAgentDefaultSkills,
} from "../../../data/merchant-agent-preset";
import {
  admitControlMutation,
  recordSessionMutationReceipt,
} from "@purin-labs/control/worker/admission/control-mutation";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import type { AgentSkillRef } from "@purin-labs/control-api";
import { agentOperationsErrorResponse } from "./operations";

/**
 * Installs the merchant operating agent for one organisation.
 *
 * Sous Chef is an ordinary agent: this issues the same configuration commands an
 * operator could issue one at a time from the Portal, in one idempotent step,
 * so an organisation does not have to hand-build a five-skill agent to get one.
 */
export async function handleMerchantAgentInstallation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  // Installing an agent grants it capabilities, so it sits with the other
  // configuration writes at admin rather than with the read routes.
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("urk_install_invalid", 422);
  const admitted = await admitControlMutation({
    request,
    authorized,
    body: body.value,
    boundary: "unversioned",
    route: `/v1/control/organisations/${authorized.organisationId}/agents/urk`,
    operation: "agents.urk.install",
  });
  if (admitted instanceof Response) return admitted;
  const policy = await readCurrentOrganisationPolicySnapshot(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (!policy.ok) return controlError("policy_snapshot_missing", 503);
  const now = Date.now();
  const installed = await installMerchantAgent({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    actorUserId: authorized.authenticated.session.userId,
    policyRevision: policy.value.version,
    skills: merchantAgentDefaultSkills(),
    now,
  });
  if (!installed.ok) return agentOperationsErrorResponse(installed.error);
  const responseBody = {
    ok: true,
    installation: {
      installationId: installed.value.installationId,
      skillIds: installed.value.skillRefs.map(
        (ref: AgentSkillRef) => ref.skillId,
      ),
    },
  };
  await recordSessionMutationReceipt(
    authorized,
    admitted,
    { status: 201, body: responseBody },
    now,
  );
  return controlJson(responseBody, 201);
}
