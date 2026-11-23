import React from "react";

export type JevFact = readonly [label: string, value: React.ReactNode];

/**
 * Money and data facts of Jev as plain label and value rows: who pays, the
 * free use, the price and the limits. Each fact stays on the page.
 */
export function JevFacts(props: {
  readonly label: string;
  readonly rows: readonly JevFact[];
}): React.ReactNode {
  return (
    <dl className="jev-facts" aria-label={props.label}>
      {props.rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
