import React from "react";

/** One button of a decision. `className` is the class of the page that shows it. */
export type DecisionButton = Readonly<{
  label: React.ReactNode;
  className?: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
}>;

/**
 * A refusal that asks one more time. The person selects the refusal, and the
 * buttons then show `label` (refuse) and `keepLabel` (go back).
 */
export type DecisionRefusalConfirm = Readonly<{
  label: React.ReactNode;
  className?: string;
  keepLabel: React.ReactNode;
  keepClassName?: string;
  /** The name of the group while it asks; the default is `groupLabel`. */
  groupLabel?: string;
  /** Goes back to the first buttons when the refusal ends. */
  resetWhenDone?: boolean;
}>;

/** The allow labels of a governed action: before and after its approval. */
export const GOVERNED_ACTION_ALLOW = {
  approve: "Approve and apply",
  apply: "Apply change",
} as const;

/**
 * The labels of an email reply decision, one look in every place: the
 * mailbox page, the Inbox conversation and the draft card in a chat. A place
 * that can edit the draft shows Edit between them.
 */
export const EMAIL_REPLY_DECISION = {
  sendLabel: "Approve and send",
  discardLabel: "Reject",
} as const;

/** A self-test goes to the address of the person who approves it. */
export const SELF_TEST_SEND_LABEL =
  "Confirm this is my address and send self-test";

/**
 * The refusal of a governed action, one look in every place (Refactor 17,
 * step A2.1): "Reject", then "Reject change" or "Keep proposal". The second
 * question waits for the person, and it closes when the refusal ends.
 * `className` is the class of the page for the first and the keep button.
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

export type DecisionButtonsProps = Readonly<{
  /** The answer that allows. Null when this place has no allow button. */
  allow: DecisionButton | null;
  /** The answer that refuses. Null when the decision has no refusal here. */
  refuse:
    (DecisionButton & Readonly<{ confirm?: DecisionRefusalConfirm }>) | null;
  /** A control between the two answers, for example Edit. */
  between?: React.ReactNode;
  /** Every button is disabled while an answer is in progress. */
  disabled: boolean;
  /**
   * The class of the group element. Without it the buttons have no element
   * of their own: they join the row of the page.
   */
  className?: string;
  /** The name of the group. With a name, the element has the group role. */
  groupLabel?: string;
}>;

/**
 * The buttons of one decision that waits for a person: allow, then refuse
 * (Refactor 17, step A2.1). Each place that shows a decision uses this
 * component with its own classes. One kind of decision has one set of
 * labels in every place: a governed action takes `GOVERNED_ACTION_ALLOW` and
 * `governedActionRefusal`. The component owns the second question of a
 * refusal.
 */
export function DecisionButtons(props: DecisionButtonsProps): React.ReactNode {
  const [confirming, setConfirming] = React.useState(false);
  const confirm = props.refuse?.confirm;

  const refuse = props.refuse;
  const asking = confirming && refuse !== null && confirm !== undefined;
  const buttons = asking ? (
    <>
      <button
        type="button"
        className={confirm.className}
        onClick={() => {
          const done = refuse.onSelect();
          if (confirm.resetWhenDone === true)
            void Promise.resolve(done).finally(() => setConfirming(false));
        }}
        disabled={props.disabled}
      >
        {confirm.label}
      </button>
      <button
        type="button"
        className={confirm.keepClassName}
        onClick={() => setConfirming(false)}
        disabled={props.disabled}
      >
        {confirm.keepLabel}
      </button>
    </>
  ) : (
    <>
      {props.allow === null ? null : (
        <button
          type="button"
          className={props.allow.className}
          onClick={() => void props.allow?.onSelect()}
          disabled={props.disabled || props.allow.disabled === true}
        >
          {props.allow.label}
        </button>
      )}
      {props.between}
      {refuse === null ? null : (
        <button
          type="button"
          className={refuse.className}
          onClick={() => {
            if (refuse.confirm === undefined) void refuse.onSelect();
            else setConfirming(true);
          }}
          disabled={props.disabled || refuse.disabled === true}
        >
          {refuse.label}
        </button>
      )}
    </>
  );
  if (props.className === undefined) return buttons;
  return (
    <div
      className={props.className}
      role={props.groupLabel === undefined ? undefined : "group"}
      aria-label={
        asking ? (confirm.groupLabel ?? props.groupLabel) : props.groupLabel
      }
    >
      {buttons}
    </div>
  );
}
