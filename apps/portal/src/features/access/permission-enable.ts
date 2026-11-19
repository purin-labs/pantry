import type {
  AccessControlCapabilityView,
  AccessControlView,
  AccessError,
  AccessGrantTargetSelection,
  AccessRouteTransport,
} from "@purin-labs/control-api/portal/access-models";
import type { AccessSubjectRef } from "@purin-labs/contracts";

/** A capability that a permission request asks to turn on. */
export type RequestedCapability = Readonly<{
  capabilityId: string;
  capabilityVersion: number;
  label: string;
}>;

/** A grant that a permission request asks to add. */
type RequestedGrant = Readonly<{
  subjectRef: AccessSubjectRef;
  target: AccessGrantTargetSelection;
}>;

type AccessMutations = Pick<AccessRouteTransport, "read" | "mutate">;

/**
 * Turns on each requested capability that is not on yet, through the same
 * Access mutation as the Access page. Each change bumps the Access revision,
 * so the view is read again before the next one. Returns an error message,
 * or null when every capability is on.
 */
export async function enableCapabilities(
  access: AccessMutations,
  organisationId: string,
  items: readonly RequestedCapability[],
): Promise<string | null> {
  for (const item of items) {
    const read = await access.read(organisationId, null, null);
    if (!read.ok) return accessErrorMessage(read.error);
    const capability = findCapability(read.value, item);
    if (capability === null)
      return `${item.label} is not available in this workspace.`;
    if (capability.mode === "enabled") continue;
    const changed = await access.mutate(organisationId, {
      kind: "change_capability_mode",
      expectedRevision: read.value.revision,
      capabilityId: item.capabilityId,
      capabilityVersion: item.capabilityVersion,
      capabilityRevision: capability.revision,
      mode: "enabled",
    });
    if (!changed.ok) return accessErrorMessage(changed.error);
  }
  return null;
}

/**
 * Adds each requested grant through the Access grant mutation. Returns an
 * error message, or null when every grant is added.
 */
export async function createGrants(
  access: AccessMutations,
  organisationId: string,
  grants: readonly RequestedGrant[],
): Promise<string | null> {
  for (const grant of grants) {
    const read = await access.read(organisationId, null, null);
    if (!read.ok) return accessErrorMessage(read.error);
    const created = await access.mutate(organisationId, {
      kind: "create_grant",
      expectedRevision: read.value.revision,
      subjectRef: grant.subjectRef,
      target: grant.target,
    });
    if (!created.ok) return accessErrorMessage(created.error);
  }
  return null;
}

/** Whether the reader may turn on every capability that is still off. */
export function mayEnableEvery(
  view: AccessControlView,
  items: readonly RequestedCapability[],
): boolean {
  return items.every(mayEnable.bind(null, view));
}

function mayEnable(
  view: AccessControlView,
  item: RequestedCapability,
): boolean {
  const capability = findCapability(view, item);
  return (
    capability !== null &&
    (capability.mode === "enabled" ||
      capability.actions.kind === "change_capability_mode")
  );
}

export function accessErrorMessage(error: AccessError): string {
  return error.kind === "decode"
    ? "Access settings could not be read. Refresh and try again."
    : error.message;
}

function findCapability(
  view: AccessControlView,
  item: RequestedCapability,
): AccessControlCapabilityView | null {
  for (const capability of view.capabilities)
    if (
      capability.definition.capabilityId === item.capabilityId &&
      capability.definition.capabilityVersion === item.capabilityVersion
    )
      return capability;
  return null;
}
