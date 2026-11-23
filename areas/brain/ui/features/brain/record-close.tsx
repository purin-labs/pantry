import React from "react";
import { X } from "lucide-react";

import { isPrimaryNavigationClick } from "@purin-labs/ui/console-sidebar";

/**
 * The way back from a record to its list: one close button at the top right
 * of the record. A Memory and an Eval open in place of their lists.
 */
export function RecordClose(props: {
  readonly href: string;
  /** What the button closes, for a screen reader: "Close this memory". */
  readonly label: string;
  readonly onClose: () => void;
}): React.ReactNode {
  return (
    <a
      className="brain-record-close"
      href={props.href}
      aria-label={props.label}
      onClick={(event) => {
        if (!isPrimaryNavigationClick(event)) return;
        event.preventDefault();
        props.onClose();
      }}
    >
      <X size={16} strokeWidth={1.6} aria-hidden="true" />
    </a>
  );
}
