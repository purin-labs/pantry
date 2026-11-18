import { startControlRead, startControlSessionRead } from "./control-client";
import {
  codexConnectionPath,
  commerceSystemPath,
  evalsPath,
  homePath,
  inferencePath,
  memoriesPath,
  organisationRecordPath,
} from "./control-paths";
import { readPortalRoute, type WorkspaceDetailPage } from "./route";

const ORGANISATION_ID_STORAGE_PREFIX = "satyr:organisation-id:";

/**
 * Starts the reads of the page at `pathname` while the Portal's code loads.
 * The session read needs nothing. The other reads need the Organisation's
 * identifier, which an earlier visit to the same address left in this
 * browser. Each read is authorized by the server as usual; a read that the
 * signed-in person may not make fails there and serves nobody.
 */
export function startPortalReads(pathname: string): void {
  startControlSessionRead();
  const route = readPortalRoute(pathname);
  if (route.kind === "organisation_list") {
    startOrganisationListReads();
    return;
  }
  if (route.kind !== "workspace") return;
  const organisationId = readRememberedOrganisationId(route.organisationHandle);
  if (organisationId === null) return;
  startShellReads(organisationId);
  startWorkspacePageReads(route.destination.page, organisationId);
}

/** Only identifiers are remembered. Every early response needs fresh server authorization. */
function startOrganisationListReads(): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith(ORGANISATION_ID_STORAGE_PREFIX)) continue;
      const organisationId = readRememberedOrganisationId(
        key.slice(ORGANISATION_ID_STORAGE_PREFIX.length),
      );
      if (organisationId !== null)
        startControlRead(organisationRecordPath(organisationId));
    }
  } catch {
    return;
  }
}

/**
 * Starts what the shell reads one time for an Organisation: its record, and
 * the Codex connection behind the usage figure.
 */
export function startShellReads(organisationId: string): void {
  startControlRead(organisationRecordPath(organisationId));
  startControlRead(codexConnectionPath(organisationId));
}

/**
 * Starts the first reads of one page. The page takes them when it is on
 * screen, so its data does not wait for its code or for the shell.
 */
export function startWorkspacePageReads(
  page: WorkspaceDetailPage,
  organisationId: string,
): void {
  for (const path of workspacePageReads(page, organisationId))
    startControlRead(path);
}

function workspacePageReads(
  page: WorkspaceDetailPage,
  organisationId: string,
): readonly string[] {
  // Home shows the connected systems above its own content.
  const connectedSystems = [
    organisationRecordPath(organisationId),
    commerceSystemPath(organisationId),
    codexConnectionPath(organisationId),
    inferencePath(organisationId),
  ];
  switch (page) {
    case "overview":
      return [...connectedSystems, homePath(organisationId)];
    case "integrations":
      return connectedSystems;
    case "brain":
    case "knowledge":
    case "tests":
      return [memoriesPath(organisationId), evalsPath(organisationId)];
    default:
      return [];
  }
}

export function rememberOrganisationId(
  organisationHandle: string,
  organisationId: string,
): void {
  try {
    window.localStorage.setItem(
      `${ORGANISATION_ID_STORAGE_PREFIX}${organisationHandle}`,
      organisationId,
    );
  } catch {
    return;
  }
}

function readRememberedOrganisationId(
  organisationHandle: string,
): string | null {
  try {
    const stored = window.localStorage.getItem(
      `${ORGANISATION_ID_STORAGE_PREFIX}${organisationHandle}`,
    );
    return stored !== null && /^[A-Za-z0-9_-]{1,128}$/u.test(stored)
      ? stored
      : null;
  } catch {
    return null;
  }
}
