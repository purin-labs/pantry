import React from "react";

import type { CommerceActionDetails } from "@purin-labs/control-api/portal/commerce-actions";
import type { Variant } from "@purin-labs/type-utils";

/** The exact menu that goes live, by section, with what changes. */
export function CafeMenuPublicationDetails(input: {
  readonly details: Variant<CommerceActionDetails, "publish_cafe_menu">;
}): React.JSX.Element {
  const { details } = input;
  const names = new Map(
    details.entryNames.map((entry) => [entry.menuEntryId, entry.displayName]),
  );
  const added = new Set(details.addedEntryIds);
  return (
    <>
      <p className="action-summary">
        <span>Menu</span>:{" "}
        <strong>
          <bdi>{details.menu.name}</bdi>
        </strong>
      </p>
      <dl className="action-change-facts">
        {details.menu.sections.map((section) => (
          <div key={section.sectionId}>
            <dt>
              <bdi>{section.name}</bdi>
            </dt>
            <dd>
              <ul>
                {details.menu.entries
                  .filter((entry) => entry.sectionId === section.sectionId)
                  .map((entry) => (
                    <li key={entry.menuEntryId}>
                      <bdi>{names.get(entry.menuEntryId) ?? entry.menuEntryId}</bdi>
                      {added.has(entry.menuEntryId) ? " (new)" : null}
                    </li>
                  ))}
              </ul>
            </dd>
          </div>
        ))}
        {details.removedNames.length === 0 ? null : (
          <div>
            <dt>Removed from the live menu</dt>
            <dd>
              <bdi>{details.removedNames.join(", ")}</bdi>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}
