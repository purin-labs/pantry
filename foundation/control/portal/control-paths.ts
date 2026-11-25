/**
 * Control API paths that the Portal reads before the page that needs them is
 * on screen. Each path has one definition here, so the early read and the
 * page's own read ask for the same thing.
 */
export function organisationRecordPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}`;
}

/** The Google sign-in. It comes back to `returnTo`, by default this page. */
export function signInPath(
  returnTo: string = window.location.pathname + window.location.search,
): string {
  return `/v1/control/auth/google/start?${new URLSearchParams({ returnTo }).toString()}`;
}

/** A path under one Organisation's record, such as `devices`. */
export function controlPath(organisationId: string, suffix: string): string {
  return `${organisationRecordPath(organisationId)}/${suffix}`;
}

/** A record of one period: its path with the start and the end in milliseconds. */
export function periodPath(
  organisationId: string,
  suffix: string,
  window: Readonly<{ from: number; to: number }>,
): string {
  const params = new URLSearchParams({
    from: String(window.from),
    to: String(window.to),
  });
  return `${controlPath(organisationId, suffix)}?${params.toString()}`;
}

/**
 * The logo of an organisation, or of one of its workspaces. With the digest,
 * the address names one image, so the browser keeps it.
 */
export function logoPath(
  organisationId: string,
  workspaceId: string | null,
  sha256: string | null = null,
): string {
  const subject =
    workspaceId === null
      ? "logo"
      : `workspaces/${encodeURIComponent(workspaceId)}/logo`;
  const path = controlPath(organisationId, subject);
  return sha256 === null ? path : `${path}?v=${sha256}`;
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
