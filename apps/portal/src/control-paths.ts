/**
 * Control API paths that the Portal reads before the page that needs them is
 * on screen. Each path has one definition here, so the early read and the
 * page's own read ask for the same thing.
 */
export function organisationRecordPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}`;
}

export function homePath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/home`;
}

export function memoriesPath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/memories`;
}

export function evalsPath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/evals`;
}

export function brainSummaryPath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/brain/summary`;
}

export function permissionRequestsPath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/access-control/permission-requests`;
}

export function heldOutputPath(
  organisationId: string,
  requestId: string,
): string {
  return `${organisationRecordPath(organisationId)}/access-control/held-outputs/${encodeURIComponent(requestId)}`;
}

export function commerceSystemPath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/commerce-system`;
}

export function inferencePath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/inference`;
}

export function codexConnectionPath(organisationId: string): string {
  return `${inferencePath(organisationId)}/codex`;
}

export function vaultItemsPath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/vault/items`;
}

export function vaultStorePath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/vault/store`;
}

export function vaultEventsPath(organisationId: string): string {
  return `${organisationRecordPath(organisationId)}/vault/events`;
}
