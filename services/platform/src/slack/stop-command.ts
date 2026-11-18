import type { SlackMessageTrigger } from "./events";

type SlackStopCommandCandidate = {
  trigger: SlackMessageTrigger;
  text: string;
};

const SLACK_MENTION = String.raw`(?:<@[A-Z0-9]+(?:\|[^>\r\n]+)?>|@[A-Za-z0-9._-]+)`;
const STOP_COMMAND_PATTERN = new RegExp(
  [
    String.raw`^`,
    String.raw`(?:(?:please|pls)[ \t]+)?`,
    String.raw`(?:${SLACK_MENTION}[ \t]+)?`,
    String.raw`(?:(?:please|pls)[ \t]+)?`,
    String.raw`(?:(?:can|could|would|will)[ \t]+you[ \t]+)?`,
    String.raw`(?:stop|kill|end|cancel)`,
    String.raw`(?:[ \t]+(?:it|this|that|the[ \t]+(?:run|execution|request|job|turn)))?`,
    String.raw`(?:[ \t]+now)?`,
    String.raw`(?:[ \t]+(?:please|pls))?`,
    String.raw`[.!?]*$`,
  ].join(""),
  "i",
);

export function isSlackStopCommand(
  message: SlackStopCommandCandidate,
): boolean {
  if (message.trigger === "edit") {
    return false;
  }

  return STOP_COMMAND_PATTERN.test(message.text.trim());
}
