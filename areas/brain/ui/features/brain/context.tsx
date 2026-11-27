import React from "react";
import { ChevronRight } from "lucide-react";

import { isPrimaryNavigationClick } from "@purin-labs/ui/page-address";

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
 * Where a person inspects the context that an agent may load for a Case:
 * the related records of a Case, the connection that finds them, and the
 * pages that an agent received from a screen. Each has its own page, and
 * this view links to them. The Knowledge page changes nothing here.
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
            detail: "Access and data flow",
            href: props.links.relatedCasesHref,
          },
          {
            key: "discovery",
            title: "Context discovery",
            detail: "Integrations",
            href: props.links.discoveryHref,
          },
          {
            key: "on-screen",
            title: "On screen",
            detail: "Access and data flow",
            href: props.links.onScreenHref,
          },
        ];
  return (
    <section className="brain-context" aria-labelledby="brain-context">
      <h2 className="visually-hidden" id="brain-context" tabIndex={-1}>
        Context
      </h2>
      {/* The one fact of this view: a relationship is not access. */}
      <p className="brain-muted">
        A related record gives no access: each reader sees only the records that
        they may read.
      </p>
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
  );
}
