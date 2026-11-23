import React from "react";
import "./sale-facts.css";

export type SaleFact = readonly [label: string, value: React.ReactNode];

/**
 * The money facts of a counter sale as plain label and value rows: the
 * total, the cash and the change, the payment, the order and the refund.
 * The Register and the counter sale on Counters & payments show them alike.
 */
export function SaleFacts(props: {
  readonly label: string;
  readonly rows: readonly (SaleFact | null)[];
}): React.ReactNode {
  return (
    <dl className="sale-facts" aria-label={props.label}>
      {props.rows.map((row) =>
        row === null ? null : (
          <div key={row[0]}>
            <dt>{row[0]}</dt>
            <dd>{row[1]}</dd>
          </div>
        ),
      )}
    </dl>
  );
}
