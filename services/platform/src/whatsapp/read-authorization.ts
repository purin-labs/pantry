import type { PermissionRequired } from "@seams/control-api";
import type { RequestAuthority } from "@seams/contracts";
import { selectActiveGrants } from "../authorization/access-grants/compiler";
import {
  CAPABILITY_KEYS,
  WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE,
  capabilityDefinitionById,
} from "../authorization/capability-catalogue";
import { personPermission } from "../control/permission-required";
import { listAccessGrants } from "../data/access-grants";
import { resolveActiveProviderAccountContext } from "../data/integration-account";
import type { IntegrationAccountId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { createCurrentSourceFlowLabel, evaluateFlowLabelSink } from "../policy";
import { readCurrentOrganisationPolicySnapshot } from "../policy-snapshot";
import { validateNativeRequestAuthority } from "../request-authority";
import type { Variant } from "@seams/type-utils";

/**
 * Whether one person may read the customer text of one WhatsApp number in the
 * Portal (Plan 83, D2). It is the same check as for a mailbox: the capability
 * is on, the person holds a grant on this number, and the text may reach them.
 */
export async function authorizeWhatsAppSupportRead(
  scope: OrganisationExecutionScope,
  authority: Variant<RequestAuthority, "control">,
  integrationAccountId: IntegrationAccountId,
): Promise<boolean> {
  const context = await resolveActiveProviderAccountContext({
    db: scope.database,
    organisationId: scope.organisationId,
    integrationAccountId,
  });
  if (!context.ok || context.value.account.provider !== "whatsapp")
    return false;
  const live = await validateNativeRequestAuthority({
    db: scope.database,
    authority,
  });
  if (!live.ok) return false;
  const policy = await readCurrentOrganisationPolicySnapshot(
    scope.database,
    scope.organisationId,
  );
  if (
    !policy.ok ||
    !policy.value.authz.allowedTools.includes(
      CAPABILITY_KEYS.whatsappSupportRead,
    )
  )
    return false;
  const grants = await listAccessGrants({
    db: scope.database,
    organisationId: scope.organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) return false;
  const selected = selectActiveGrants({
    organisationId: scope.organisationId,
    authority,
    grants: grants.value,
  });
  if (!selected.ok) return false;
  const grantIds: string[] = [];
  for (const grant of selected.value) {
    const target = grant.target;
    if (
      target.kind === "provider_resource" &&
      target.capabilityId === CAPABILITY_KEYS.whatsappSupportRead &&
      target.integrationAccountId === integrationAccountId &&
      target.resourceScope === WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE
    )
      grantIds.push(grant.grantId);
  }
  if (grantIds.length === 0) return false;
  const label = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: scope.database,
    organisationId: scope.organisationId,
    integrationAccountId,
    capabilityId: CAPABILITY_KEYS.whatsappSupportRead,
    resourceScope: WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE,
    grantIds,
  });
  return (
    label.ok &&
    evaluateFlowLabelSink({
      flowLabel: label.value,
      organisationAuthz: null,
      sink: { kind: "conversation_delivery", destinationAuthority: authority },
    }).kind === "allow"
  );
}

/** The grant that lets one person read one number, for the prompt. */
export async function whatsappSupportReadPermission(
  scope: OrganisationExecutionScope,
  personId: string,
  integrationAccountId: IntegrationAccountId,
): Promise<PermissionRequired | null> {
  const definition = capabilityDefinitionById(
    CAPABILITY_KEYS.whatsappSupportRead,
  );
  return personPermission(scope, CAPABILITY_KEYS.whatsappSupportRead, {
    personId,
    target: {
      kind: "provider_resource",
      capabilityRef: {
        capabilityId: definition.capabilityId,
        capabilityVersion: definition.capabilityVersion,
      },
      integrationRef: `integration:${integrationAccountId}`,
      resourceRef: `provider_resource:${WHATSAPP_SUPPORT_ACTIVE_CASES_SCOPE}`,
    },
  });
}
