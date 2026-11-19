import { isNonNegativeInteger, isRecord } from "@purin-labs/std";

type CapabilityRef = Readonly<{
  capabilityId: string;
  capabilityVersion: number;
}>;

/**
 * The grant that gives the refused person the capability: on one published
 * commerce target (a product or a list entry), on one provider resource (a
 * WhatsApp number), or on the whole platform.
 */
export type PermissionRequiredGrantTarget =
  | Readonly<{
      kind: "published_commerce_target";
      capabilityRef: CapabilityRef;
      targetRef: Readonly<{ targetRefId: string; revision: number }>;
    }>
  | Readonly<{
      kind: "provider_resource";
      capabilityRef: CapabilityRef;
      integrationRef: string;
      resourceRef: string;
    }>
  | Readonly<{ kind: "platform"; capabilityRef: CapabilityRef }>;

/**
 * What a person needs before a refused action can run: the capability, its
 * current mode for the organisation, and the grant that gives it to that
 * person. A null grant means that the capability only needs to be switched
 * on. A control route answers it as `{ ok: false, error:
 * "<action>_permission_required", permission }` with status 403, and the
 * Portal shows the permission prompt in place.
 */
export type PermissionRequired = Readonly<{
  capabilityId: string;
  capabilityVersion: number;
  label: string;
  description: string;
  mode: "enabled" | "approval_required" | "disabled";
  grant: Readonly<{
    subjectRef: Readonly<{ subjectRefId: string; revision: number }>;
    target: PermissionRequiredGrantTarget;
  }> | null;
}>;

/** Reads the permission from a `*_permission_required` answer. */
export function parsePermissionRequiredProblem(
  raw: unknown,
): PermissionRequired | null {
  if (
    !isRecord(raw) ||
    typeof raw.error !== "string" ||
    !raw.error.endsWith("_permission_required") ||
    !isRecord(raw.permission)
  )
    return null;
  const permission = raw.permission;
  if (
    typeof permission.capabilityId !== "string" ||
    !isNonNegativeInteger(permission.capabilityVersion) ||
    typeof permission.label !== "string" ||
    typeof permission.description !== "string" ||
    (permission.mode !== "enabled" &&
      permission.mode !== "approval_required" &&
      permission.mode !== "disabled")
  )
    return null;
  const capabilityRef = {
    capabilityId: permission.capabilityId,
    capabilityVersion: permission.capabilityVersion,
  };
  const grant =
    permission.grant === null
      ? null
      : parseGrant(permission.grant, capabilityRef);
  if (grant === undefined) return null;
  return {
    capabilityId: permission.capabilityId,
    capabilityVersion: permission.capabilityVersion,
    label: permission.label,
    description: permission.description,
    mode: permission.mode,
    grant,
  };
}

function parseGrant(
  raw: unknown,
  capabilityRef: CapabilityRef,
): PermissionRequired["grant"] | undefined {
  if (
    !isRecord(raw) ||
    !isRecord(raw.subjectRef) ||
    typeof raw.subjectRef.subjectRefId !== "string" ||
    !isNonNegativeInteger(raw.subjectRef.revision) ||
    !isRecord(raw.target)
  )
    return undefined;
  const target = parseGrantTarget(raw.target, capabilityRef);
  return target === undefined
    ? undefined
    : {
        subjectRef: {
          subjectRefId: raw.subjectRef.subjectRefId,
          revision: raw.subjectRef.revision,
        },
        target,
      };
}

function parseGrantTarget(
  raw: Readonly<Record<string, unknown>>,
  capabilityRef: CapabilityRef,
): PermissionRequiredGrantTarget | undefined {
  if (
    !isRecord(raw.capabilityRef) ||
    raw.capabilityRef.capabilityId !== capabilityRef.capabilityId ||
    raw.capabilityRef.capabilityVersion !== capabilityRef.capabilityVersion
  )
    return undefined;
  switch (raw.kind) {
    case "platform":
      return { kind: "platform", capabilityRef };
    case "provider_resource":
      return typeof raw.integrationRef === "string" &&
        typeof raw.resourceRef === "string"
        ? {
            kind: "provider_resource",
            capabilityRef,
            integrationRef: raw.integrationRef,
            resourceRef: raw.resourceRef,
          }
        : undefined;
    case "published_commerce_target":
      return isRecord(raw.targetRef) &&
        typeof raw.targetRef.targetRefId === "string" &&
        isNonNegativeInteger(raw.targetRef.revision)
        ? {
            kind: "published_commerce_target",
            capabilityRef,
            targetRef: {
              targetRefId: raw.targetRef.targetRefId,
              revision: raw.targetRef.revision,
            },
          }
        : undefined;
    default:
      return undefined;
  }
}
