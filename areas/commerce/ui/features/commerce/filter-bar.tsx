import React from "react";
import "./filter-bar.css";

/**
 * A filter's count, beside its name; nothing when the view has none. The
 * filters of Products, Ingredients & supplies and the lanes of a board view
 * share it, inside a `.commerce-filter-bar`.
 */
export function FilterCount(
  props: Readonly<{ value: number | undefined }>,
): React.ReactNode {
  // The space keeps the name and the count apart for a screen reader.
  return props.value === undefined ? null : (
    <>
      {" "}
      <span className="commerce-filter-count">{props.value}</span>
    </>
  );
}
