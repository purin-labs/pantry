import type {
  DecisionButton,
  DecisionRefusalConfirm,
} from "@purin-labs/ui/index";

/**
 * The labels of a governed action decision, one look in every place: the
 * chat card, the status band and a custom connector write (Refactor 17, step
 * A2.1). This file is a public file of the commerce area, so another area can
 * import it.
 */

/** The allow labels of a governed action: before and after its approval. */
export const GOVERNED_ACTION_ALLOW = {
  approve: "Approve and apply",
  apply: "Apply change",
} as const;

/**
 * The refusal of a governed action: "Reject", then "Reject change" or "Keep
 * proposal". The second question waits for the person, and it closes when the
 * refusal ends. `className` is the class of the page for the first and the
 * keep button.
 */
export function governedActionRefusal(input: {
  readonly onSelect: () => void | Promise<void>;
  readonly className?: string;
}): DecisionButton & Readonly<{ confirm: DecisionRefusalConfirm }> {
  return {
    label: "Reject",
    ...(input.className === undefined ? {} : { className: input.className }),
    onSelect: input.onSelect,
    confirm: {
      label: "Reject change",
      className: "danger-button",
      keepLabel: "Keep proposal",
      ...(input.className === undefined
        ? {}
        : { keepClassName: input.className }),
      groupLabel: "Confirm the rejection",
      resetWhenDone: true,
    },
  };
}
