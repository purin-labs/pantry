import type { OrganisationHomeRegions } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import type { OrganisationPlacementBindings } from "../organisation-execution-scope";
import {
  nearestOrganisationPlacementCell,
  parseOrganisationPlacementCells,
  type Continent,
  type InitialOrganisationPlacement,
  type OrganisationPlacementCell,
  type RequestLocation,
} from "../placement";
import type { Result } from "@purin-labs/kernel/result";

type OrganisationHomeRegionError =
  | { readonly code: "organisation_placement_configuration_invalid" }
  | { readonly code: "invalid_organisation_home_region" };

type OfferedCells = {
  readonly nearest: OrganisationPlacementCell;
  readonly cells: readonly OrganisationPlacementCell[];
};

/** The cells a new organisation can live in, and the one nearest the request. */
export function readOrganisationHomeRegions(
  env: OrganisationPlacementBindings,
  request: Request,
): Result<OrganisationHomeRegions, OrganisationHomeRegionError> {
  const offered = offeredCells(env, request);
  if (!offered.ok) return offered;
  return {
    ok: true,
    value: {
      suggested: offered.value.nearest.placement.placementCellId,
      choices: offered.value.cells.map(homeRegionChoice),
    },
  };
}

/**
 * The placement of a new organisation. A choice in the request wins. With no
 * choice, the organisation lives in the cell nearest to the request.
 */
export function selectOrganisationHomePlacement(
  env: OrganisationPlacementBindings,
  request: Request,
  rawChoice: unknown,
): Result<InitialOrganisationPlacement, OrganisationHomeRegionError> {
  const offered = offeredCells(env, request);
  if (!offered.ok) return offered;
  if (rawChoice === undefined)
    return { ok: true, value: offered.value.nearest.placement };
  for (const cell of offered.value.cells) {
    if (cell.placement.placementCellId === rawChoice)
      return { ok: true, value: cell.placement };
  }
  return { ok: false, error: { code: "invalid_organisation_home_region" } };
}

function offeredCells(
  env: OrganisationPlacementBindings,
  request: Request,
): Result<OfferedCells, OrganisationHomeRegionError> {
  const configured = parseOrganisationPlacementCells(
    env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  );
  const root = configured.ok ? configured.value[0] : undefined;
  if (!configured.ok || root === undefined) {
    return {
      ok: false,
      error: { code: "organisation_placement_configuration_invalid" },
    };
  }
  // A cell with no database in this deployment is not offered. When none has
  // one, creation keeps the onboarding default and reports that cell.
  const deployed = configured.value.filter(hasDatabase.bind(null, env));
  const [first, ...others] = deployed;
  if (first === undefined)
    return { ok: true, value: { nearest: root, cells: [root] } };
  return {
    ok: true,
    value: {
      nearest: nearestOrganisationPlacementCell(
        [first, ...others],
        readRequestLocation(request),
      ),
      cells: deployed,
    },
  };
}

function hasDatabase(
  env: OrganisationPlacementBindings,
  cell: OrganisationPlacementCell,
): boolean {
  return env[cell.databaseBinding] !== undefined;
}

function homeRegionChoice(
  cell: OrganisationPlacementCell,
): OrganisationHomeRegions["choices"][number] {
  return {
    id: cell.placement.placementCellId,
    area: cell.placement.locationHint,
  };
}

const CONTINENTS: Readonly<Record<Continent, true>> = {
  AF: true,
  AN: true,
  AS: true,
  EU: true,
  NA: true,
  OC: true,
  SA: true,
};

/**
 * Cloudflare describes the client of a request in `request.cf`. A request
 * from a test, a service binding or an anonymising network can lack it.
 */
function readRequestLocation(request: Request): RequestLocation {
  const cf: unknown = request.cf;
  if (!isRecord(cf)) return { kind: "unknown" };
  const latitude = degrees(cf.latitude, 90);
  const longitude = degrees(cf.longitude, 180);
  if (latitude !== null && longitude !== null)
    return { kind: "coordinates", latitude, longitude };
  return isContinent(cf.continent)
    ? { kind: "continent", continent: cf.continent }
    : { kind: "unknown" };
}

function degrees(raw: unknown, limit: number): number | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function isContinent(raw: unknown): raw is Continent {
  return typeof raw === "string" && Object.hasOwn(CONTINENTS, raw);
}
