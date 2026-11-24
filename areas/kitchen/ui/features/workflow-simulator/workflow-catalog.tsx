import React from "react";
import { ChevronRight } from "lucide-react";
import "./workflow-catalog.css";

/** A view that the Workflow catalog opens in the production workspace. */
export type CatalogSection =
  | "active-production"
  | "rehearsal-production"
  | "cafe-shift"
  | "siphon"
  | "espresso"
  | "latte"
  | "black-sesame"
  | "ginger-tea"
  | "financier-batter"
  | "financier-bake"
  | "financier-pack"
  | "pastry-bench"
  | "pour-over"
  | "appliance-rehearsals"
  | "shared-runs";

/** The tier of a workflow: one action, one recipe task, or a loop or shift. */
type CatalogTier = "action" | "task" | "loop";

type CatalogEntry = Readonly<{
  tier: CatalogTier;
  /** The kind that the row's tag shows. */
  kind: string;
  name: string;
  /** One line under the name: the main equipment, or the size of a shift. */
  fact: string;
}>;

type CatalogEntryId = CatalogSection | "financier-morning";

/**
 * Each workflow of the catalog: its name, which the production workspace also
 * shows in its top bar, and its one fact line. The view that a row opens
 * shows the rest of the equipment.
 */
const CATALOG: Readonly<Record<CatalogEntryId, CatalogEntry>> = {
  "rehearsal-production": {
    tier: "action",
    kind: "Action",
    name: "Robot tray rehearsal",
    fact: "Tray A → Tray B · rack handoff",
  },
  "appliance-rehearsals": {
    tier: "action",
    kind: "Action",
    name: "Appliance rehearsals",
    fact: "Linea Classic S · Eagle One",
  },
  siphon: {
    tier: "task",
    kind: "Recipe task",
    name: "Siphon coffee",
    fact: "Hario ECA-3-B",
  },
  "pour-over": {
    tier: "task",
    kind: "Recipe task",
    name: "Pour-over",
    fact: "FR10 · gooseneck kettle",
  },
  espresso: {
    tier: "task",
    kind: "Recipe task",
    name: "Espresso",
    fact: "Linea Classic S",
  },
  latte: {
    tier: "task",
    kind: "Recipe task",
    name: "Caffe latte",
    fact: "FR10 · steam wand",
  },
  "black-sesame": {
    tier: "task",
    kind: "Recipe task",
    name: "Black sesame milk",
    fact: "WSG60 · Vitamix · Severin",
  },
  "ginger-tea": {
    tier: "task",
    kind: "Recipe task",
    name: "Ginger tea and milk tea",
    fact: "FR10 · two pans",
  },
  "financier-batter": {
    tier: "task",
    kind: "Recipe task",
    name: "Financier batter",
    fact: "Maruzen hob · Ohaus scale · Hobart HL200",
  },
  "financier-bake": {
    tier: "task",
    kind: "Recipe task",
    name: "Financier bake",
    fact: "Matsunaga 8P · Maruzen MBCO-5E",
  },
  "financier-pack": {
    tier: "task",
    kind: "Recipe task",
    name: "Financier pack",
    fact: "Wire grid · gift box",
  },
  "pastry-bench": {
    tier: "task",
    kind: "Recipe task",
    name: "Pie pastry",
    fact: "Shortcrust · puff lid",
  },
  "financier-morning": {
    tier: "loop",
    kind: "Shift",
    name: "Financier morning",
    fact: "Batter to vitrine refill",
  },
  "active-production": {
    tier: "loop",
    kind: "Loop",
    name: "Financier batches with robot",
    fact: "Batch A → Batch B → Batch C · robot handoffs",
  },
  "cafe-shift": {
    tier: "loop",
    kind: "Shift",
    name: "Café shift",
    fact: "Financiers and espresso · 2 robots",
  },
  "shared-runs": {
    tier: "loop",
    kind: "Saved",
    name: "Shared production runs",
    fact: "Open or compare saved runs",
  },
};

/** The recipe tasks of the catalog, in the order of the list. */
export const RECIPE_TASKS = [
  "siphon",
  "pour-over",
  "espresso",
  "latte",
  "black-sesame",
  "ginger-tea",
  "financier-batter",
  "financier-bake",
  "financier-pack",
  "pastry-bench",
] as const satisfies readonly CatalogSection[];

/**
 * The top bar title of the production workspace: the name of the view that
 * its Workflow panel shows, or of the production when the panel shows the
 * batches or the catalog.
 */
export function workspaceTitle(
  section: CatalogSection | null,
  rehearsal: boolean,
): string {
  if (
    section === null ||
    section === "active-production" ||
    section === "rehearsal-production"
  )
    return CATALOG[rehearsal ? "rehearsal-production" : "active-production"]
      .name;
  return CATALOG[section].name;
}

const FILTERS: readonly Readonly<{
  tier: CatalogTier | "all";
  label: string;
}>[] = [
  { tier: "all", label: "All" },
  { tier: "action", label: "Actions" },
  { tier: "task", label: "Recipe tasks" },
  { tier: "loop", label: "Loops and shifts" },
];

/** One row of the catalog: the workflow, a fact that the caller knows, and what the row opens. */
export type CatalogRow = Readonly<{
  id: CatalogEntryId;
  /** A fact from the loaded run, in place of the fixed one. */
  fact?: string;
  open(): void;
}>;

/**
 * The Workflow catalog: filters with counts, then one framed list with a row
 * for each workflow (its name, one fact and its kind). The Workflow panel of
 * the floor plan and the production workspace share it.
 */
export function WorkflowCatalog(
  props: Readonly<{ rows: readonly CatalogRow[] }>,
): React.ReactNode {
  const [tier, setTier] = React.useState<CatalogTier | "all">("all");
  const shown = props.rows.filter(
    (row) => tier === "all" || CATALOG[row.id].tier === tier,
  );
  return (
    <div className="workflow-catalog">
      <div
        className="workflow-catalog-filters"
        role="group"
        aria-label="Workflow kinds"
      >
        {FILTERS.map((filter) => (
          <button
            key={filter.tier}
            type="button"
            aria-pressed={tier === filter.tier}
            onClick={() => setTier(filter.tier)}
          >
            {filter.label}{" "}
            <span className="workflow-catalog-count">
              {
                props.rows.filter(
                  (row) =>
                    filter.tier === "all" ||
                    CATALOG[row.id].tier === filter.tier,
                ).length
              }
            </span>
          </button>
        ))}
      </div>
      <ul className="workflow-catalog-rows">
        {shown.map((row) => {
          const entry = CATALOG[row.id];
          return (
            <li key={row.id}>
              <button
                type="button"
                className="workflow-catalog-row"
                onClick={row.open}
              >
                <span className="workflow-catalog-name">
                  <strong>{entry.name}</strong>
                  <span>{row.fact ?? entry.fact}</span>
                </span>
                <span className="workflow-catalog-tag">{entry.kind}</span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
