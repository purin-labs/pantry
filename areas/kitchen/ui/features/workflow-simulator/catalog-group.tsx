import React from "react";

/** The three tiers of the Workflow catalog, as each group and sub-view names them. */
export const CATALOG_TIERS = {
  action: "Tier 1 · Actions",
  task: "Tier 2 · Recipe tasks",
  loop: "Tier 3 · Loops and shifts",
} as const;

/**
 * One group of the Workflow catalog: its tier and name, then one framed list
 * of the workflows that it opens. The Workflow dock, the production
 * workspace and the recipe task catalog share it.
 */
export function ProductionCatalogGroup(
  props: Readonly<{ title: string; children: React.ReactNode }>,
): React.ReactNode {
  return (
    <section className="production-catalog-group" aria-label={props.title}>
      <h4>{props.title}</h4>
      <div className="production-menu-list">{props.children}</div>
    </section>
  );
}

/** One workflow of a catalog group: its name, what it runs and an arrow. */
export function ProductionCatalogItem(
  props: Readonly<{
    title: React.ReactNode;
    detail: React.ReactNode;
    open: () => void;
  }>,
): React.ReactNode {
  return (
    <button
      type="button"
      className="production-menu-item production-catalog-card"
      onClick={props.open}
    >
      <div className="production-catalog-card-body">
        <strong>{props.title}</strong>
        <small>{props.detail}</small>
      </div>
      <span className="production-menu-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
