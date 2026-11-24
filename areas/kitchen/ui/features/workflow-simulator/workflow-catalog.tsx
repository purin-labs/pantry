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

/**
 * The tiers in the order of the catalog: the short name of each filter, and
 * the full name of each group heading.
 */
const TIERS: readonly Readonly<{
  tier: CatalogTier;
  filter: string;
  heading: string;
}>[] = [
  { tier: "action", filter: "Tier 1", heading: "Tier 1 · Actions" },
  { tier: "task", filter: "Tier 2", heading: "Tier 2 · Recipe tasks" },
  { tier: "loop", filter: "Tier 3", heading: "Tier 3 · Loops and shifts" },
];

type CatalogEntry = Readonly<{
  tier: CatalogTier;
  /**
   * The tag of a tier 3 row, which tells a loop, a shift and the saved runs
   * apart. The tier names every action and recipe task, so they have none.
   */
  tag?: "Loop" | "Shift" | "Saved";
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
    name: "Robot tray rehearsal",
    fact: "Tray A → Tray B · rack handoff",
  },
  "appliance-rehearsals": {
    tier: "action",
    name: "Appliance rehearsals",
    fact: "Linea Classic S · Eagle One",
  },
  siphon: {
    tier: "task",
    name: "Siphon coffee",
    fact: "Hario ECA-3-B",
  },
  "pour-over": {
    tier: "task",
    name: "Pour-over",
    fact: "FR10 · gooseneck kettle",
  },
  espresso: {
    tier: "task",
    name: "Espresso",
    fact: "Linea Classic S",
  },
  latte: {
    tier: "task",
    name: "Caffe latte",
    fact: "FR10 · steam wand",
  },
  "black-sesame": {
    tier: "task",
    name: "Black sesame milk",
    fact: "WSG60 · Vitamix · Severin",
  },
  "ginger-tea": {
    tier: "task",
    name: "Ginger tea and milk tea",
    fact: "FR10 · two pans",
  },
  "financier-batter": {
    tier: "task",
    name: "Financier batter",
    fact: "Maruzen hob · Ohaus scale · Hobart HL200",
  },
  "financier-bake": {
    tier: "task",
    name: "Financier bake",
    fact: "Matsunaga 8P · Maruzen MBCO-5E",
  },
  "financier-pack": {
    tier: "task",
    name: "Financier pack",
    fact: "Wire grid · gift box",
  },
  "pastry-bench": {
    tier: "task",
    name: "Pie pastry",
    fact: "Shortcrust · puff lid",
  },
  "financier-morning": {
    tier: "loop",
    tag: "Shift",
    name: "Financier morning",
    fact: "Batter to vitrine refill",
  },
  "active-production": {
    tier: "loop",
    tag: "Loop",
    name: "Financier batches with robot",
    fact: "Batch A → Batch B → Batch C · robot handoffs",
  },
  "cafe-shift": {
    tier: "loop",
    tag: "Shift",
    name: "Café shift",
    fact: "Financiers and espresso · 2 robots",
  },
  "shared-runs": {
    tier: "loop",
    tag: "Saved",
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

/** One row of the catalog: the workflow, a fact that the caller knows, and what the row opens. */
export type CatalogRow = Readonly<{
  id: CatalogEntryId;
  /** A fact from the loaded run, in place of the fixed one. */
  fact?: string;
  open(): void;
}>;

/**
 * The Workflow catalog: a filter for each tier with its count, on one row,
 * then a group for each tier shown: the tier's full name, then a framed list
 * of rows (a name, one fact and, in tier 3, a tag). All shows every group.
 * The Workflow panel of the floor plan and the production workspace share it.
 */
export function WorkflowCatalog(
  props: Readonly<{ rows: readonly CatalogRow[] }>,
): React.ReactNode {
  const [tier, setTier] = React.useState<CatalogTier | "all">("all");
  const headingPrefix = React.useId();
  return (
    <div className="workflow-catalog">
      <div
        className="workflow-catalog-filters"
        role="group"
        aria-label="Workflow tiers"
      >
        <CatalogFilter
          label="All"
          count={props.rows.length}
          pressed={tier === "all"}
          select={() => setTier("all")}
        />
        {TIERS.map((group) => (
          <CatalogFilter
            key={group.tier}
            label={group.filter}
            count={rowsOfTier(props.rows, group.tier).length}
            pressed={tier === group.tier}
            select={() => setTier(group.tier)}
          />
        ))}
      </div>
      {TIERS.filter((group) => tier === "all" || group.tier === tier).map(
        (group) => {
          const rows = rowsOfTier(props.rows, group.tier);
          if (rows.length === 0) return null;
          const headingId = `${headingPrefix}-${group.tier}`;
          return (
            <section
              key={group.tier}
              className="workflow-catalog-group"
              aria-labelledby={headingId}
            >
              <h4 id={headingId}>{group.heading}</h4>
              <CatalogRows rows={rows} />
            </section>
          );
        },
      )}
    </div>
  );
}

function rowsOfTier(
  rows: readonly CatalogRow[],
  tier: CatalogTier,
): readonly CatalogRow[] {
  return rows.filter((row) => CATALOG[row.id].tier === tier);
}

function CatalogFilter(
  props: Readonly<{
    label: string;
    count: number;
    pressed: boolean;
    select: () => void;
  }>,
): React.ReactNode {
  // A screen reader hears "Tier 1 2 workflows", not "Tier 1 2".
  return (
    <button type="button" aria-pressed={props.pressed} onClick={props.select}>
      {props.label}{" "}
      <span className="workflow-catalog-count" aria-hidden="true">
        {props.count}
      </span>
      <span className="visually-hidden">
        {props.count === 1 ? "1 workflow" : `${props.count} workflows`}
      </span>
    </button>
  );
}

function CatalogRows(
  props: Readonly<{ rows: readonly CatalogRow[] }>,
): React.ReactNode {
  return (
    <ul className="workflow-catalog-rows">
      {props.rows.map((row) => {
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
              {entry.tag === undefined ? null : (
                <span className="workflow-catalog-tag">{entry.tag}</span>
              )}
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
