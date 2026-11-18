import type {
  PermissionRequired,
  PermissionRequiredGrantTarget,
} from "@seams/control-api";
import { opaqueSubjectReference } from "../access-control/references";
import {
  capabilityDefinitionById,
  type ActiveCapabilityId,
} from "../authorization/capability-catalogue";
import { readOrganisationCapabilityPolicies } from "../data/capability-policy";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { controlJson } from "./http";

/**
 * The permission that a refused person needs: the capability with its
 * current mode, and the grant that gives it to that person, or null when
 * switching the capability on is enough. Null when the policies cannot be
 * read, so the caller answers its plain refusal.
 */
export async function personPermission(
  scope: OrganisationExecutionScope,
  capabilityId: ActiveCapabilityId,
  grant: Readonly<{
    personId: string;
    target: PermissionRequiredGrantTarget;
  }> | null,
): Promise<PermissionRequired | null> {
  const policies = await readOrganisationCapabilityPolicies({
    db: scope.database,
    organisationId: scope.organisationId,
  });
  if (!policies.ok) return null;
  const definition = capabilityDefinitionById(capabilityId);
  const policy = policies.value.find(
    (candidate) =>
      candidate.capabilityId === definition.capabilityId &&
      candidate.capabilityVersion === definition.capabilityVersion,
  );
  return {
    capabilityId: definition.capabilityId,
    capabilityVersion: definition.capabilityVersion,
    label: definition.label,
    description: definition.description,
    mode: policy?.mode ?? "disabled",
    grant:
      grant === null
        ? null
        : {
            subjectRef: {
              subjectRefId: await opaqueSubjectReference(scope.organisationId, {
                kind: "person",
                firstId: grant.personId,
                secondId: null,
                revision: 1,
              }),
              revision: 1,
            },
            target: grant.target,
          },
  };
}

/**
 * The refusal that the Portal answers with the permission prompt. `code`
 * names the refused action, as in `commerce_list_entry_patch`.
 */
export function permissionRequiredResponse(
  code: `${string}_permission_required`,
  permission: PermissionRequired,
): Response {
  return controlJson({ ok: false, error: code, permission }, 403);
}
