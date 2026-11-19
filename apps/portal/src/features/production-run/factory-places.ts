import type { CompiledScenario } from "@seams/production-simulation";
import type { FactoryStationSource } from "../workflow-simulator/spatial/factory-stations";
import { MORNING_SHIFT_STATIONS } from "./morning-shift-appliances";
import {
  FINANCIER_FLAVOUR_PRODUCTS,
  financierFlavourOf,
} from "@seams/production-simulation/recipes/bakery/financier-flavours";
import {
  PIE_PRODUCTS,
  pieTypeOf,
} from "@seams/production-simulation/recipes/bakery/pie-products";

/**
 * Operator names for the places, equipment and steps of the recurring
 * financier and morning shift routes. Unknown identities keep their engine names.
 */
const PLACES: Readonly<Record<string, string>> = {
  "clean-trays": "Clean trays",
  "filled-moulds": "Filled trays",
  "oven-mould": "Oven",
  "cooling-mould": "Mould cooling position",
  "mould-sink": "Tray wash",
  "empty-grids": "Empty cooling grids",
  "loaded-grids": "Cooling rack",
  "packing-grid": "Packing table",
  "prep-vessels": "Preparation vessels",
  "clean-pan": "Clean pan",
  "clean-pans": "Clean pans",
  "clean-bowl": "Clean bowl",
  "hob-vessel": "Hob",
  "sink-vessels": "Vessel wash",
  "hazelnut-batter-holding": "Hazelnut batter container",
  "coffee-batter-holding": "Coffee batter container",
  "matcha-batter-holding": "Matcha batter container",
  "black-sesame-batter-holding": "Black sesame batter container",
  "shortcrust-fridge": "Shortcrust in the refrigerator",
  "steak-and-pepper-filling-fridge":
    "Steak and pepper filling in the refrigerator",
  "beef-bourguignon-filling-fridge":
    "Beef bourguignon filling in the refrigerator",
  "clean-braise-pans": "Clean braising pans",
  "braise-prep": "Braising pan on the bench",
  "braise-hob-positions": "Braising hob",
  "braise-pan-wash": "Braising pan wash",
  "clean-pie-trays": "Clean pie trays",
  "pie-bench": "Pie assembly bench",
  "oven-pie-tray": "Oven",
  "oven-pie-trays": "Oven",
  "pie-cooling-rack": "Pie cooling rack",
  "pie-packing": "Packing table",
  "pie-tray-wash": "Pie tray wash",
  "braise-hob": "Braising hob zones",
  "concentrate-fridge": "Sesame concentrate in the refrigerator",
  "black-tea-ginger-decoction-fridge":
    "Black tea ginger decoction in the refrigerator",
  "milk-tea-ginger-decoction-fridge":
    "Milk tea ginger decoction in the refrigerator",
  "bar-hob": "Bar induction hob",
  "bar-hob-power": "Bar induction zone",
  "bar-scale": "Bar scale",
  baker: "Baker",
  barista: "Barista",
  "prep-bench": "Preparation bench",
  "heatproof-rest": "Heatproof rest",
  "wash-pans": "Pan wash",
  "wash-area": "Wash area",
  "receiving-position": "Beverage receiving bar",
  "wash-receivers": "Receiver wash",
  "pan-staging-table": "Cobot pan staging table",
  "pan-staging-rack": "Cobot pan & carrier rack",
  "grinder-bowl": "Grinder bowl",
  "blender-jug": "Blender jug",
  "chilled-concentrate": "Chilled sesame concentrate",
  "frother-jug": "Frother jug",
  "clean-jug": "Clean frother jug",
  "oven-roast-tray": "Oven roast tray",
  "roasted-sesame-tray": "Roasted sesame tray",
  bakers: "A baker",
  "tea-worker": "Baker 1",
  "tea-worker-2": "Baker 2",
  oven: "Oven",
  scale: "Scale",
  hob: "Hob",
  "hob-power": "Induction hob zone",
  sink: "Sink",
  packing: "Packing table",
  grinder: "Spice grinder",
  blender: "Quiet blender",
  frother: "Milk frother",
  "cooling-bath": "Chiller & cooling bath",
  "staging-arm": "FAIRINO FR10 cobot",
  "coffee-grinder": "Coffee grinder",
  "espresso-machine": "Espresso machine",
  "espresso-cup": "Espresso cup",
  "pour-over-station": "Pour-over station",
  "pour-over-arm": "FAIRINO FR10 pour-over arm",
  "gooseneck-kettle": "Gooseneck kettle",
};

export function placeLabel(id: string): string {
  const known = PLACES[id];
  if (known !== undefined) return known;
  const baker = /^baker-(\d+)$/u.exec(id);
  return baker === null ? id : `Baker ${baker[1] ?? ""}`;
}

/** The unit a store holds, for sentences such as "2 of 2 trays". */
export function carrierNoun(store: string, count: number): string {
  const one =
    store.includes("grid") || store === "loaded-grids"
      ? "grid"
      : store.includes("vessel") ||
          store.includes("pan") ||
          store.includes("bowl") ||
          store.includes("jug") ||
          store.includes("concentrate") ||
          store === "receiving-position" ||
          store === "wash-receivers"
        ? "vessel"
        : "tray";
  return count === 1 ? one : `${one}s`;
}

export function instanceLabel(instance: string): string {
  const separator = instance.lastIndexOf("#");
  const source = instance.slice(0, separator);
  const sequence = Number(instance.slice(separator + 1));
  if (source === "financier-batches") return `Batch ${sequence + 1}`;
  if (source === "financier-preheat") return "Oven preheat";
  const flavour = financierFlavourOf(source);
  if (flavour !== null) {
    const title = FINANCIER_FLAVOUR_PRODUCTS[flavour].title;
    return source.startsWith("load-")
      ? `${title} tray ${source.slice(-1).toUpperCase()}`
      : `${title} batter ${sequence + 1}`;
  }
  if (source === "shortcrust-batches") return "Shortcrust";
  const pie = pieTypeOf(source);
  if (pie !== null)
    return source.endsWith("-filling-batches")
      ? `${PIE_PRODUCTS[pie].title} filling`
      : `${PIE_PRODUCTS[pie].title}s`;
  if (source === "sesame-batches") return `Sesame batch ${sequence + 1}`;
  if (source === "sesame-roast") return `Sesame roast ${sequence + 1}`;
  if (source === "black-tea-batches") return `Black tea ${sequence + 1}`;
  if (source === "milk-tea-batches") return `Milk tea ${sequence + 1}`;
  if (source === "espresso-orders") return `Espresso ${sequence + 1}`;
  if (source === "pour-over-order") return `Pour-over ${sequence + 1}`;
  return instance;
}

export function stepLabel(key: string): string {
  const tray = /^tray-(\d+)\.(.+)$/u.exec(key);
  if (tray === null) return key.replaceAll("-", " ");
  return `tray ${tray[1] ?? ""} · ${(tray[2] ?? "").replaceAll("-", " ")}`;
}

export function taskLabel(task: string): string {
  const separator = task.indexOf("/");
  if (separator < 0) return task;
  return `${instanceLabel(task.slice(0, separator))} · ${stepLabel(task.slice(separator + 1))}`;
}

/** Simulated clock time, h:mm:ss from the start of the shift. */
export function clock(microseconds: number): string {
  const total = Math.round(microseconds / 1e6);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** The recurring financier bakery, along a back counter and a front counter. */
export const FINANCIER_STATIONS: readonly FactoryStationSource[] = [
  {
    id: "station-preparation",
    label: "Preparation",
    model: "prep-table",
    x: -4.2,
    z: -1.8,
    stores: ["prep-vessels", "clean-trays", "filled-moulds"],
    primary: "filled-moulds",
    resources: ["scale"],
    locations: ["prep"],
  },
  {
    id: "station-hob",
    label: "Hob",
    model: "hob",
    x: -2.4,
    z: -1.8,
    stores: ["hob-vessel"],
    primary: "hob-vessel",
    resources: ["hob"],
    locations: ["hob"],
  },
  {
    id: "station-oven",
    label: "Oven",
    model: "oven",
    x: -0.4,
    z: -1.8,
    stores: ["oven-mould"],
    primary: "oven-mould",
    resources: ["oven"],
    locations: ["oven"],
  },
  {
    id: "station-mould-cooling",
    label: "Mould cooling",
    model: "cooling-table",
    x: 1.6,
    z: -1.8,
    stores: ["cooling-mould"],
    primary: "cooling-mould",
    resources: [],
    locations: ["cooling"],
  },
  {
    id: "station-cooling-rack",
    label: "Cooling rack",
    model: "cooling-rack",
    x: 3.6,
    z: -1.8,
    stores: ["loaded-grids", "empty-grids"],
    primary: "loaded-grids",
    resources: [],
    locations: [],
  },
  {
    id: "station-wash",
    label: "Wash",
    model: "wash-sink",
    x: -2.4,
    z: 1.8,
    stores: ["mould-sink", "sink-vessels", "clean-pan", "clean-bowl"],
    primary: "mould-sink",
    resources: ["sink"],
    locations: ["sink"],
  },
  {
    id: "station-packing",
    label: "Packing",
    model: "packing-table",
    x: 2.6,
    z: 1.8,
    stores: ["packing-grid"],
    primary: "packing-grid",
    resources: ["packing"],
    locations: ["packing"],
  },
];

/** Savoury pie bakery layout connecting the marble pastry bench to the Maruzen oven. */
export const PIE_STATIONS: readonly FactoryStationSource[] = [
  {
    id: "station-scale",
    label: "Pie pastry bench · Scale",
    model: "scale-station",
    x: -4.6,
    z: -2.2,
    stores: ["prep-vessels", "braise-prep", "pie-bench"],
    primary: "pie-bench",
    resources: ["scale"],
    locations: ["prep"],
  },
  {
    id: "station-mixer",
    label: "Mixer · KPL9000S",
    model: "mixer-station",
    x: -2.8,
    z: -2.2,
    stores: ["clean-bowl"],
    primary: "clean-bowl",
    resources: [],
    locations: [],
  },
  {
    id: "station-hob",
    label: "Braising hob",
    model: "dual-hob-station",
    x: 1.0,
    z: -2.2,
    stores: ["braise-hob-positions", "clean-braise-pans"],
    primary: "braise-hob-positions",
    resources: ["braise-hob"],
    locations: ["hob"],
  },
  {
    id: "station-oven",
    label: "Oven · MBCO-4ME",
    model: "oven",
    x: 3.0,
    z: -2.2,
    stores: ["oven-pie-trays", "oven-pie-tray"],
    primary: "oven-pie-trays",
    resources: ["oven"],
    locations: ["oven"],
  },
  {
    id: "station-chiller",
    label: "Chiller & pie cooling rack",
    model: "chiller-rack-station",
    x: 4.8,
    z: -2.2,
    stores: [
      "pie-cooling-rack",
      "shortcrust-fridge",
      "steak-and-pepper-filling-fridge",
      "beef-bourguignon-filling-fridge",
    ],
    primary: "pie-cooling-rack",
    resources: ["cooling-bath"],
    locations: ["cooling"],
  },
  {
    id: "station-wash",
    label: "Wash · UC-L",
    model: "dishwasher-sink-station",
    x: -3.6,
    z: 2.0,
    stores: [
      "clean-pie-trays",
      "pie-tray-wash",
      "braise-pan-wash",
      "sink-vessels",
    ],
    primary: "pie-tray-wash",
    resources: ["sink"],
    locations: ["sink"],
  },
  {
    id: "station-packing",
    label: "Packing",
    model: "packing-table",
    x: 4.2,
    z: 2.0,
    stores: ["pie-packing"],
    primary: "pie-packing",
    resources: ["packing"],
    locations: ["packing"],
  },
];

export function isPieScenario(scenario: CompiledScenario): boolean {
  return scenario.workflows.some(
    (w) =>
      w.id === "shortcrust" ||
      w.id.endsWith("-pies") ||
      w.id.endsWith("-filling"),
  );
}

export function factoryStationsForScenario(
  scenario: CompiledScenario,
): readonly FactoryStationSource[] | null {
  if (scenario.id === "bakery-shift") return MORNING_SHIFT_STATIONS;
  if (isPieScenario(scenario)) return PIE_STATIONS;
  return null;
}

export function financierStation(
  id: string,
  scenario?: CompiledScenario,
): FactoryStationSource | null {
  const stations =
    scenario !== undefined
      ? (factoryStationsForScenario(scenario) ?? [
          ...FINANCIER_STATIONS,
          ...PIE_STATIONS,
          ...MORNING_SHIFT_STATIONS,
        ])
      : [...MORNING_SHIFT_STATIONS, ...FINANCIER_STATIONS, ...PIE_STATIONS];
  for (const station of stations) if (station.id === id) return station;
  return null;
}
