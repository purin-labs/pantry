/**
 * The organisation's capability rules: each tool that its policy denies or
 * sends for approval.
 *
 * These rules describe the organisation's tools, not the data, so no label
 * carries them. Every tool effect is judged by the rules of the policy that
 * the deciding authority runs under, whatever the label holds. Turning a
 * capability on therefore admits data that arrived while it was off, and
 * turning it off stops data that arrived while it was on.
 */
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  readCurrentOrganisationPolicySnapshot,
  type OrganisationPolicySnapshot,
} from "../../policy-snapshot";
import type { Result } from "@purin-labs/kernel/result";
import type {
  FlowDecisionReason,
  FlowLabelDecision,
  ToolEffectSink,
} from "./types";

declare const CURRENT_ORGANISATION_AUTHZ: unique symbol;

/**
 * The capability rules of one organisation's current policy. The sink check
 * reads them for the organisation of the effect's own authority.
 */
export type CurrentOrganisationAuthz = Readonly<{
  readonly deniedTools: ReadonlySet<string>;
  readonly approvalRequired: ReadonlySet<string>;
  readonly [CURRENT_ORGANISATION_AUTHZ]: true;
}>;

const RULE_PREFIX = "organisation.authz.";

/**
 * The rules of a policy snapshot. Pass the snapshot that the deciding
 * authority runs under: the current one, or the one pinned for its turn.
 */
export function organisationAuthzFromPolicy(
  policy: OrganisationPolicySnapshot,
): CurrentOrganisationAuthz {
  const deniedTools: ReadonlySet<string> = new Set(policy.authz.deniedTools);
  const approvalRequired: ReadonlySet<string> = new Set(
    policy.authz.approvalRequired,
  );
  return Object.freeze({
    deniedTools,
    approvalRequired,
  } as CurrentOrganisationAuthz);
}

export async function readCurrentOrganisationAuthz(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<CurrentOrganisationAuthz, string>> {
  const policy = await readCurrentOrganisationPolicySnapshot(
    db,
    organisationId,
  );
  if (!policy.ok) return { ok: false, error: policy.error.code };
  return {
    ok: true,
    value: organisationAuthzFromPolicy(policy.value),
  };
}

/**
 * The decision of the organisation's rules on one tool effect. A denial wins
 * over an approval rule. A satisfied approval passes the approval rule only.
 */
export function decideOrganisationToolEffect(
  authz: CurrentOrganisationAuthz,
  sink: ToolEffectSink,
): FlowLabelDecision {
  if (authz.deniedTools.has(sink.capabilityId))
    return {
      kind: "deny",
      reason: toolRuleReason("deny", sink.capabilityId),
      violationAction: "deny",
    };
  if (authz.approvalRequired.has(sink.capabilityId) && !sink.approvalSatisfied)
    return {
      kind: "approval_required",
      reason: toolRuleReason("approval_required", sink.capabilityId),
    };
  return { kind: "allow" };
}

function toolRuleReason(
  effect: "approval_required" | "deny",
  capabilityId: string,
): FlowDecisionReason {
  return {
    code: "flow_rule",
    ruleId: `${RULE_PREFIX}${effect}.${capabilityId}`,
    reasonCode: `${RULE_PREFIX}${effect}`,
  };
}
