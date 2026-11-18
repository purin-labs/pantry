import React from "react";
import { ChevronRight } from "lucide-react";

import { isPrimaryNavigationClick } from "../../console-sidebar";

/**
 * The pages that own the inspection of Case context. The Brain page reads
 * nothing about context: it leads to its owners.
 */
export type ContextLinks = Readonly<{
  /** The collections of related records of a Case, and their review. */
  relatedCasesHref: string;
  /** The connection that finds related records, and its status. */
  discoveryHref: string;
  /** The pages that a Case's agent received from a screen (Plan 87). */
  onScreenHref: string;
}>;

type ContextEntry = Readonly<{
  key: string;
  title: string;
  detail: string;
  href: string;
}>;

/**
 * Where a person inspects the context that an agent may load for a Case.
 * Context discovery finds related records, and a person reviews each
 * relationship. Both have their own pages, and this view links to them.
 */
export function ContextView(props: {
  /** Null where the workspace pages are not known, as in a preview. */
  readonly links: ContextLinks | null;
  readonly onOpenPage: (href: string) => void;
}): React.ReactNode {
  const entries: readonly ContextEntry[] =
    props.links === null
      ? []
      : [
          {
            key: "related",
            title: "Related Cases",
            detail:
              "Access and data flow · The related records of one Case, why each is related, and its review",
            href: props.links.relatedCasesHref,
          },
          {
            key: "discovery",
            title: "Context discovery",
            detail:
              "Integrations · The connection that finds related records, and its status",
            href: props.links.discoveryHref,
          },
          {
            key: "on-screen",
            title: "On screen",
            detail:
              "Access and data flow · The pages that the agent of one Case received from a screen, with the time and the records, and no values",
            href: props.links.onScreenHref,
          },
        ];
  return (
    <section className="brain-context" aria-labelledby="brain-context">
      <h2 className="visually-hidden" id="brain-context" tabIndex={-1}>
        Context
      </h2>
      <p className="brain-muted brain-evals-intro">
        Context is the set of related records that an agent may load for a Case.
        Seams Pantry finds a related record, keeps the reason with it, and a
        person reviews it. A relationship gives no access: each reader sees only
        the records that they may read.
      </p>
      <section className="brain-kind" aria-labelledby="brain-context-pages">
        <h3 className="brain-kind-heading" id="brain-context-pages">
          Where to inspect it
          <span className="brain-kind-count">{entries.length}</span>
        </h3>
        {entries.length === 0 ? (
          <p className="brain-kind-empty">
            The pages of this workspace are not available here.
          </p>
        ) : (
          <ul className="brain-rows" aria-label="Pages that show Case context">
            {entries.map((entry) => (
              <li key={entry.key}>
                <a
                  className="brain-row"
                  href={entry.href}
                  onClick={(event) => {
                    if (!isPrimaryNavigationClick(event)) return;
                    event.preventDefault();
                    props.onOpenPage(entry.href);
                  }}
                >
                  <span className="brain-row-main">
                    <span className="brain-row-head">
                      <span className="brain-row-title">{entry.title}</span>
                    </span>
                    <span className="brain-row-meta">{entry.detail}</span>
                  </span>
                  <ChevronRight
                    className="brain-row-chevron"
                    size={16}
                    strokeWidth={1.6}
                    aria-hidden="true"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="brain-muted">
        The Brain page changes nothing here. A memory can cite a collection of
        Case context as its evidence, and the record of that memory names it.
      </p>
    </section>
  );
}
