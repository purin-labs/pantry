/**
 * The one builder of a Slack card for a decision that waits for a person, or
 * for a notice (Refactor 17, step A2.1). A card is one section of text and,
 * with at least one button, one actions block. Each kind of card gives its
 * own texts, action ids and buttons, so each kind keeps its look.
 */

/** The question that Slack asks before it sends a click. */
type DecisionCardConfirm = Readonly<{
  title: string;
  text: string;
  confirm: string;
  deny: string;
}>;

export type DecisionCardButton =
  /** A link to the Portal. Slack sends no decision for it. */
  | Readonly<{
      kind: "link";
      actionId: string;
      label: string;
      url: string;
      primary: boolean;
    }>
  /** An answer in Slack. Its value names the decision. */
  | Readonly<{
      kind: "answer";
      actionId: string;
      label: string;
      value: string;
      primary: boolean;
      confirm: DecisionCardConfirm | null;
    }>;

/**
 * The blocks of a card. The order of the keys of each block is part of the
 * result: a card that Slack has already is updated with the same bytes.
 */
export function decisionCardBlocks(
  text: string,
  buttons: readonly DecisionCardButton[],
): readonly Record<string, unknown>[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    ...(buttons.length === 0
      ? []
      : [{ type: "actions", elements: buttons.map(buttonElement) }]),
  ];
}

function buttonElement(button: DecisionCardButton): Record<string, unknown> {
  const label = { type: "plain_text", text: button.label };
  if (button.kind === "link")
    return {
      type: "button",
      action_id: button.actionId,
      ...(button.primary ? { style: "primary" } : {}),
      text: label,
      url: button.url,
    };
  return {
    type: "button",
    action_id: button.actionId,
    text: label,
    ...(button.primary ? { style: "primary" } : {}),
    value: button.value,
    ...(button.confirm === null
      ? {}
      : {
          confirm: {
            title: { type: "plain_text", text: button.confirm.title },
            text: { type: "plain_text", text: button.confirm.text },
            confirm: { type: "plain_text", text: button.confirm.confirm },
            deny: { type: "plain_text", text: button.confirm.deny },
          },
        }),
  };
}
