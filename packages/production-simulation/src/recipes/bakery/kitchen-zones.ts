import type { StationId } from "@purin-labs/bakery-model/bakery";
import { assertNever } from "@purin-labs/std";
import type {
  HumanId,
  KitchenZoneId,
  StaffRoleProfile,
  ZoneHandoffInfo,
} from "./schedule-types.ts";

const KITCHEN_ZONE_LABELS: Readonly<Record<KitchenZoneId, string>> = {
  "prep-zone": "Prep & Portioning Zone",
  "hearth-zone": "Hearth & Cooling Zone",
  "finishing-zone": "Packing & Vitrine Zone",
};

const STAFF_ROLE_PROFILES: readonly StaffRoleProfile[] = [
  {
    role: "tourier-prep",
    roleTitle: "Chef de Partie — Prep & Portioning",
    shortRole: "Prep & Portioning",
    badgeTag: "Prep",
    zone: "prep-zone",
    zoneLabel: KITCHEN_ZONE_LABELS["prep-zone"],
    homeStation: "stage",
    preferredStations: ["stage", "portion"],
  },
  {
    role: "four-finition",
    roleTitle: "Chef — Hearth, Cooling & Packing",
    shortRole: "Hearth & Cooling",
    badgeTag: "Hearth",
    zone: "hearth-zone",
    zoneLabel: KITCHEN_ZONE_LABELS["hearth-zone"],
    homeStation: "cool",
    preferredStations: ["bake", "cool", "pack"],
  },
  {
    role: "commis-vitrine",
    roleTitle: "Commis — Ballotin Packing & Vitrine",
    shortRole: "Packing & Vitrine",
    badgeTag: "Pack",
    zone: "finishing-zone",
    zoneLabel: KITCHEN_ZONE_LABELS["finishing-zone"],
    homeStation: "pack",
    preferredStations: ["pack", "cool"],
  },
];

export function staffRoleProfileFor(
  workerIdOrIndex: HumanId | number,
): StaffRoleProfile {
  const idx =
    typeof workerIdOrIndex === "number"
      ? workerIdOrIndex
      : Math.max(0, Number(workerIdOrIndex.slice(6)) - 1);
  return (
    STAFF_ROLE_PROFILES[idx % STAFF_ROLE_PROFILES.length] ??
    STAFF_ROLE_PROFILES[0]!
  );
}

export function stationZone(id: StationId): KitchenZoneId {
  switch (id) {
    case "stage":
    case "portion":
      return "prep-zone";
    case "bake":
    case "cool":
      return "hearth-zone";
    case "pack":
      return "finishing-zone";
    default:
      return assertNever(id, "Unexpected station id");
  }
}

export function stationZoneLabel(id: StationId): string {
  return KITCHEN_ZONE_LABELS[stationZone(id)];
}

export function transferZoneHandoff(
  from: StationId,
  to: StationId,
  workerCount = 2,
): ZoneHandoffInfo {
  const fromZone = stationZone(from);
  const toZone = stationZone(to);
  const fromZoneLabel = KITCHEN_ZONE_LABELS[fromZone];
  const toZoneLabel = KITCHEN_ZONE_LABELS[toZone];
  const isZoneBoundary = fromZone !== toZone;
  const sendingRole =
    fromZone === "prep-zone"
      ? STAFF_ROLE_PROFILES[0]!
      : fromZone === "hearth-zone"
        ? STAFF_ROLE_PROFILES[Math.min(1, Math.max(0, workerCount - 1))]!
        : STAFF_ROLE_PROFILES[Math.min(2, Math.max(0, workerCount - 1))]!;
  const receivingRole =
    toZone === "prep-zone"
      ? STAFF_ROLE_PROFILES[0]!
      : toZone === "hearth-zone"
        ? STAFF_ROLE_PROFILES[Math.min(1, Math.max(0, workerCount - 1))]!
        : STAFF_ROLE_PROFILES[Math.min(2, Math.max(0, workerCount - 1))]!;
  return {
    fromZone,
    toZone,
    fromZoneLabel,
    toZoneLabel,
    isZoneBoundary,
    summary: isZoneBoundary
      ? `Zone handoff: ${fromZoneLabel} → ${toZoneLabel} (${sendingRole.shortRole} → ${receivingRole.shortRole})`
      : `Intra-zone transfer within ${fromZoneLabel}`,
    shortSummary: isZoneBoundary
      ? `Zone handoff · ${fromZone.replace("-zone", "")} → ${toZone.replace("-zone", "")}`
      : `Within ${fromZoneLabel}`,
    passStation: to,
    sendingRole,
    receivingRole,
  };
}
