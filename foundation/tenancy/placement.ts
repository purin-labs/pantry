import type { Result } from "@purin-labs/kernel/result";
import { isRecord } from "@purin-labs/std";

declare const placementCellIdBrand: unique symbol;
declare const placementEpochBrand: unique symbol;
declare const locationHintBrand: unique symbol;

type DurableObjectLocationHintValue =
  "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me";

export type PlacementCellId = string & {
  readonly [placementCellIdBrand]: "PlacementCellId";
};

export type PlacementEpoch = number & {
  readonly [placementEpochBrand]: "PlacementEpoch";
};

export type DurableObjectLocationHint = DurableObjectLocationHintValue & {
  readonly [locationHintBrand]: "DurableObjectLocationHint";
};

export type ResidencyJurisdiction = "eu" | "fedramp";

type OrganisationPlacementIdentity = {
  readonly placementEpoch: PlacementEpoch;
  readonly placementCellId: PlacementCellId;
  readonly locationHint: DurableObjectLocationHint;
};

export type OrganisationPlacement =
  | (OrganisationPlacementIdentity & {
      readonly kind: "affinity";
      readonly residencyJurisdiction?: never;
    })
  | (OrganisationPlacementIdentity & {
      readonly kind: "residency";
      readonly residencyJurisdiction: ResidencyJurisdiction;
    });

export type InitialOrganisationPlacement = OrganisationPlacement & {
  readonly placementEpoch: PlacementEpoch & 1;
};

export type PlacementBoundaryError = {
  readonly code: "invalid_organisation_placement";
  readonly path: string;
};

const PLACEMENT_CELL_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const LOCATION_HINTS: ReadonlySet<string> = new Set([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
]);

export function parseInitialOrganisationPlacement(
  raw: unknown,
  path = "placement",
): Result<InitialOrganisationPlacement, PlacementBoundaryError> {
  const parsed = parseOrganisationPlacement(raw, path);

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.placementEpoch !== 1) {
    return invalidPlacement(`${path}.placementEpoch`);
  }

  return { ok: true, value: parsed.value as InitialOrganisationPlacement };
}

export function parseOrganisationPlacement(
  raw: unknown,
  path = "placement",
): Result<OrganisationPlacement, PlacementBoundaryError> {
  if (!isRecord(raw)) {
    return invalidPlacement(path);
  }

  const kind = raw.kind;
  const placementEpoch = parsePlacementEpoch(
    raw.placementEpoch,
    `${path}.placementEpoch`,
  );
  const placementCellId = parsePlacementCellId(
    raw.placementCellId,
    `${path}.placementCellId`,
  );
  const locationHint = parseLocationHint(
    raw.locationHint,
    `${path}.locationHint`,
  );

  if (!placementEpoch.ok) return placementEpoch;
  if (!placementCellId.ok) return placementCellId;
  if (!locationHint.ok) return locationHint;

  if (kind === "affinity") {
    if ("residencyJurisdiction" in raw) {
      return invalidPlacement(`${path}.residencyJurisdiction`);
    }

    return {
      ok: true,
      value: {
        kind,
        placementEpoch: placementEpoch.value,
        placementCellId: placementCellId.value,
        locationHint: locationHint.value,
      },
    };
  }

  if (kind === "residency") {
    const residencyJurisdiction = parseResidencyJurisdiction(
      raw.residencyJurisdiction,
      `${path}.residencyJurisdiction`,
    );

    if (!residencyJurisdiction.ok) {
      return residencyJurisdiction;
    }

    return {
      ok: true,
      value: {
        kind,
        placementEpoch: placementEpoch.value,
        placementCellId: placementCellId.value,
        locationHint: locationHint.value,
        residencyJurisdiction: residencyJurisdiction.value,
      },
    };
  }

  return invalidPlacement(`${path}.kind`);
}

function parsePlacementEpoch(
  raw: unknown,
  path: string,
): Result<PlacementEpoch, PlacementBoundaryError> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? { ok: true, value: raw as PlacementEpoch }
    : invalidPlacement(path);
}

function parsePlacementCellId(
  raw: unknown,
  path: string,
): Result<PlacementCellId, PlacementBoundaryError> {
  return typeof raw === "string" && PLACEMENT_CELL_PATTERN.test(raw)
    ? { ok: true, value: raw as PlacementCellId }
    : invalidPlacement(path);
}

function parseLocationHint(
  raw: unknown,
  path: string,
): Result<DurableObjectLocationHint, PlacementBoundaryError> {
  return typeof raw === "string" && LOCATION_HINTS.has(raw)
    ? { ok: true, value: raw as DurableObjectLocationHint }
    : invalidPlacement(path);
}

function parseResidencyJurisdiction(
  raw: unknown,
  path: string,
): Result<ResidencyJurisdiction, PlacementBoundaryError> {
  return raw === "eu" || raw === "fedramp"
    ? { ok: true, value: raw }
    : invalidPlacement(path);
}

function invalidPlacement(path: string): Result<never, PlacementBoundaryError> {
  return { ok: false, error: { code: "invalid_organisation_placement", path } };
}

type OrganisationDatabaseBinding =
  "DB" | "ORGANISATION_DB_WNAM" | "ORGANISATION_DB_APAC" | "ORGANISATION_DB_EU";

export type OrganisationPlacementCell = {
  readonly placement: InitialOrganisationPlacement;
  readonly databaseBinding: OrganisationDatabaseBinding;
};

/** The root cell is the onboarding default. Additional cells use the same authority. */
export function parseOrganisationPlacementCells(
  raw: string,
): Result<readonly OrganisationPlacementCell[], PlacementBoundaryError> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidPlacement("PANTRY_ORGANISATION_PLACEMENT_PROFILE");
  }
  if (!isRecord(value))
    return invalidPlacement("PANTRY_ORGANISATION_PLACEMENT_PROFILE");
  const additional = value.cells;
  if (additional !== undefined && !Array.isArray(additional)) {
    return invalidPlacement("PANTRY_ORGANISATION_PLACEMENT_PROFILE.cells");
  }
  const cells: OrganisationPlacementCell[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of [value, ...(additional ?? [])].entries()) {
    const path = `PANTRY_ORGANISATION_PLACEMENT_PROFILE.cells[${index}]`;
    if (!isRecord(candidate)) return invalidPlacement(path);
    const placement = parseInitialOrganisationPlacement(
      { ...candidate, placementEpoch: 1 },
      path,
    );
    if (!placement.ok) return placement;
    const binding = candidate.databaseBinding;
    if (
      binding !== "DB" &&
      binding !== "ORGANISATION_DB_WNAM" &&
      binding !== "ORGANISATION_DB_APAC" &&
      binding !== "ORGANISATION_DB_EU"
    ) {
      return invalidPlacement(`${path}.databaseBinding`);
    }
    if (ids.has(placement.value.placementCellId))
      return invalidPlacement(`${path}.placementCellId`);
    ids.add(placement.value.placementCellId);
    cells.push({ placement: placement.value, databaseBinding: binding });
  }
  return { ok: true, value: cells };
}

type Coordinates = {
  readonly latitude: number;
  readonly longitude: number;
};

export type Continent = "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA";

/** Where a request entered, as far as the edge reported it. */
export type RequestLocation =
  | (Coordinates & { readonly kind: "coordinates" })
  | { readonly kind: "continent"; readonly continent: Continent }
  | { readonly kind: "unknown" };

// One reference site for each location hint. Cloudflare picks the site inside
// a hinted region, so these give a distance order and no more.
const LOCATION_HINT_SITES: Readonly<
  Record<DurableObjectLocationHintValue, Coordinates>
> = {
  wnam: { latitude: 37.4, longitude: -121.9 },
  enam: { latitude: 39.0, longitude: -77.5 },
  sam: { latitude: -23.5, longitude: -46.6 },
  weur: { latitude: 50.1, longitude: 8.7 },
  eeur: { latitude: 52.2, longitude: 21.0 },
  apac: { latitude: 35.7, longitude: 139.7 },
  oc: { latitude: -33.9, longitude: 151.2 },
  afr: { latitude: -26.2, longitude: 28.0 },
  me: { latitude: 25.3, longitude: 55.3 },
};

// Antarctica has no entry: a request from there keeps the onboarding default.
const CONTINENT_SITES: Readonly<Record<Exclude<Continent, "AN">, Coordinates>> =
  {
    AF: { latitude: 1.0, longitude: 20.0 },
    AS: { latitude: 30.0, longitude: 105.0 },
    EU: { latitude: 50.0, longitude: 10.0 },
    NA: { latitude: 40.0, longitude: -100.0 },
    OC: { latitude: -25.0, longitude: 135.0 },
    SA: { latitude: -15.0, longitude: -60.0 },
  };

/**
 * The cell nearest to a location, by distance over the globe. The first cell
 * is the onboarding default: it wins a tie, and an unknown location.
 */
export function nearestOrganisationPlacementCell(
  cells: readonly [OrganisationPlacementCell, ...OrganisationPlacementCell[]],
  location: RequestLocation,
): OrganisationPlacementCell {
  const origin = locationCoordinates(location);
  let nearest = cells[0];
  if (origin === null) return nearest;
  let shortest = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    const hint: DurableObjectLocationHintValue = cell.placement.locationHint;
    const distance = angularDistance(origin, LOCATION_HINT_SITES[hint]);
    if (distance < shortest) {
      shortest = distance;
      nearest = cell;
    }
  }
  return nearest;
}

function locationCoordinates(location: RequestLocation): Coordinates | null {
  switch (location.kind) {
    case "coordinates":
      return location;
    case "continent":
      return location.continent === "AN"
        ? null
        : CONTINENT_SITES[location.continent];
    case "unknown":
      return null;
  }
}

/** The haversine angle in radians: enough to order distances. */
function angularDistance(from: Coordinates, to: Coordinates): number {
  const latitude = radians(to.latitude - from.latitude);
  const longitude = radians(to.longitude - from.longitude);
  const chord =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitude / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(chord)));
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
