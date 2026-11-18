import { describe, expect, it } from "vitest";

import { isSlackStopCommand } from "../src/slack/stop-command";

type StopCommandCase = {
  trigger: "mention" | "message" | "edit";
  text: string;
};

const STOP_COMMANDS = [
  { trigger: "message", text: "stop" },
  { trigger: "message", text: "cancel the run" },
  { trigger: "mention", text: "stop" },
  { trigger: "mention", text: "Stop!" },
  { trigger: "mention", text: "<@U123> stop" },
  { trigger: "mention", text: "please <@U123|satyr> stop now" },
  { trigger: "mention", text: "@satyr please stop now" },
  { trigger: "mention", text: "could you cancel the run?" },
  { trigger: "mention", text: "kill this" },
  { trigger: "mention", text: "end the turn" },
  { trigger: "mention", text: "pls stop it" },
  { trigger: "mention", text: "cancel the job now please." },
] satisfies readonly StopCommandCase[];

const CONVERSATIONAL_TEXT = [
  "do not stop",
  "how do I stop a workflow?",
  "the job stopped yesterday",
  "the job was killed",
  "ending the run now",
  "stop using that tool and continue",
  "cancel culture",
  "cancel the invite for user@example.com",
  "if so, stop",
  "please check this; if broken, stop",
  "<@U123> stop @U456",
  "<@U123>\nstop",
  "please summarize this",
] as const;

function assertRecognizedStopCommand(candidate: StopCommandCase): void {
  expect(isSlackStopCommand(candidate)).toBe(true);
}

function assertConversationalText(text: string): void {
  expect(isSlackStopCommand({ trigger: "message", text })).toBe(false);
  expect(isSlackStopCommand({ trigger: "mention", text })).toBe(false);
}

function assertEditedStopDoesNotInterrupt(): void {
  expect(isSlackStopCommand({ trigger: "edit", text: "<@U123> stop" })).toBe(
    false,
  );
}

function defineStopCommandTests(): void {
  it.each(STOP_COMMANDS)(
    "recognizes an exact stop command: $text",
    assertRecognizedStopCommand,
  );
  it.each(CONVERSATIONAL_TEXT)(
    "does not interrupt for conversational text: %s",
    assertConversationalText,
  );
  it(
    "does not interrupt after editing a message into a stop command",
    assertEditedStopDoesNotInterrupt,
  );
}

describe("isSlackStopCommand", defineStopCommandTests);
