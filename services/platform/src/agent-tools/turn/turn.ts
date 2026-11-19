import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  SIDE_CASE_BRIEF_MAX_LENGTH,
  SIDE_CASE_TITLE_MAX_LENGTH,
} from "@purin-labs/control-api";
import type {
  HarnessFollowUpRequest,
  HarnessMemoryProposalRequest,
  HarnessSideCaseProposalRequest,
} from "../catalog/types";
import { defineTool, jsonSchema } from "../define-tool";

/** The longest statement that the agent may propose as one Memory. */
const MAX_MEMORY_PROPOSAL_CHARS = 600;

/** The longest note that a follow-up keeps. */
const MAX_FOLLOW_UP_NOTE_CHARS = 500;

/** The latest follow-up: seven days. */
const MAX_FOLLOW_UP_MINUTES = 10_080;

/**
 * The Memory proposal tool of a Portal chat turn. It is selected by the
 * turn's authority, not by a capability grant, and its handler checks that
 * authority again. It names no evidence: the platform cites the message
 * that started the turn.
 */
export const memoryProposal = defineTool({
  name: "propose_memory",
  description:
    "Propose one memory from a rule, a fact or a preference that the person stated in their current message and wants you to keep for later chats. The memory cites that message. It waits for a person's review in Brain and is not in use until someone accepts it, so tell the person that it waits for review. Do not call it for a question, a one-time request or your own inference. Call it directly after tool discovery, outside Code Mode. Use one call for each separate rule.",
  input: jsonSchema({
    type: "object",
    properties: {
      statement: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MEMORY_PROPOSAL_CHARS,
        description:
          "The rule, fact or preference in one or two plain sentences that stand alone. Keep the person's meaning. Do not mention this chat.",
      },
      kind: {
        type: "string",
        enum: ["fact", "preference"],
        description:
          "fact: something that is true about the business. preference: how the person wants the agent to work or to answer.",
      },
    },
    required: ["statement", "kind"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseMemoryProposalArgs,
  effect: "proposal",
  rerun: {
    kind: "any_caller",
    reason:
      "The Memory command is named by the cited message and the statement, so the Organisation answers a repeated proposal with the first candidate.",
  },
  selection: { kind: "turn", flag: "memoryProposal" },
  directOnly: true,
  unavailable: "Memory proposals are unavailable",
  handler: ({ proposeMemory }) =>
    proposeMemory === undefined
      ? undefined
      : (request) => proposeMemory(request),
});

/**
 * The follow-up tool of a Slack thread turn. It is selected by the turn's
 * origin, not by a capability grant. The follow-up runs with the authority
 * of the same person, which is checked again when it runs.
 */
export const followUp = defineTool({
  name: "schedule_follow_up",
  description:
    "Come back to this Slack thread later. After afterMinutes, Seams Pantry starts a new turn in this thread for the same person; in that turn you read your note in this call and answer in the thread. Use it when the person asks you to check back, to remind them, or when work must wait for something. Tell the person when you will come back. Call it directly, outside Code Mode. A thread holds at most three follow-ups that wait.",
  input: jsonSchema({
    type: "object",
    properties: {
      afterMinutes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_FOLLOW_UP_MINUTES,
        description: "Minutes from now, from 1 to 10080 (seven days).",
      },
      note: {
        type: "string",
        minLength: 1,
        maxLength: MAX_FOLLOW_UP_NOTE_CHARS,
        description:
          "What to check or do at that time, in one or two sentences that stand alone.",
      },
    },
    required: ["afterMinutes", "note"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseFollowUpArgs,
  effect: "scheduled",
  rerun: {
    kind: "any_caller",
    reason:
      "A follow-up is named by its turn, its delay and its note, so the Connector answers a repeated call with the first follow-up.",
  },
  selection: { kind: "turn", flag: "followUp" },
  directOnly: true,
  unavailable: "Follow-ups are unavailable",
  handler: ({ scheduleFollowUp }) =>
    scheduleFollowUp === undefined
      ? undefined
      : (request) => scheduleFollowUp(request),
});

/**
 * The side Case tool of a Portal chat turn or a Slack thread turn. It is
 * selected by the turn's origin, not by a capability grant. It proposes
 * only: a person starts the side Case from the chat's card or the thread's
 * Start button.
 */
export const sideCaseProposal = defineTool({
  name: "propose_side_case",
  description:
    "Propose separate work that you found while you work on the person's request, such as a fault, wrong data or a missing setup step. Seams Pantry shows the proposal in this chat or Slack thread, and a person may start it as a new chat or a new Slack thread whose first message is your brief. The new conversation does not hold this one's history, so write the brief to stand alone. Do not do that work in this turn, and do not propose the work that the person asked for now. Tell the person in one sentence that you proposed it. Call it directly, outside Code Mode. A conversation holds at most three proposals that wait.",
  input: jsonSchema({
    type: "object",
    properties: {
      title: {
        type: "string",
        minLength: 1,
        maxLength: SIDE_CASE_TITLE_MAX_LENGTH,
        description: "A short name for the new conversation, in plain words.",
      },
      brief: {
        type: "string",
        minLength: 1,
        maxLength: SIDE_CASE_BRIEF_MAX_LENGTH,
        description:
          "The first message of the new conversation. It must stand alone: what is wrong, the evidence that you saw, and the result to reach.",
      },
    },
    required: ["title", "brief"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parseSideCaseProposalArgs,
  effect: "proposal",
  rerun: {
    kind: "any_caller",
    reason:
      "A side Case proposal is named by its turn and its content, so a repeated call returns the first proposal and shows no second card.",
  },
  selection: { kind: "turn", flag: "sideCaseProposal" },
  directOnly: true,
  unavailable: "Side Case proposals are unavailable",
  handler: ({ proposeSideCase }) =>
    proposeSideCase === undefined
      ? undefined
      : (request) => proposeSideCase(request),
});

function parseMemoryProposalArgs(input: unknown): HarnessMemoryProposalRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["statement", "kind"]) ||
    typeof input.statement !== "string" ||
    (input.kind !== "fact" && input.kind !== "preference")
  ) {
    throw new TypeError("propose_memory accepts only statement and kind");
  }
  const statement = input.statement.trim();
  if (statement.length === 0 || statement.length > MAX_MEMORY_PROPOSAL_CHARS) {
    throw new TypeError("propose_memory statement is out of bounds");
  }
  return { statement, memoryKind: input.kind };
}

function parseFollowUpArgs(input: unknown): HarnessFollowUpRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["afterMinutes", "note"]) ||
    typeof input.afterMinutes !== "number" ||
    !Number.isSafeInteger(input.afterMinutes) ||
    input.afterMinutes < 1 ||
    input.afterMinutes > MAX_FOLLOW_UP_MINUTES ||
    typeof input.note !== "string"
  ) {
    throw new TypeError(
      "schedule_follow_up accepts only afterMinutes and note",
    );
  }
  const note = input.note.trim();
  if (note.length === 0 || note.length > MAX_FOLLOW_UP_NOTE_CHARS) {
    throw new TypeError("schedule_follow_up note is out of bounds");
  }
  return { afterMinutes: input.afterMinutes, note };
}

function parseSideCaseProposalArgs(
  input: unknown,
): HarnessSideCaseProposalRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["title", "brief"]) ||
    typeof input.title !== "string" ||
    typeof input.brief !== "string"
  ) {
    throw new TypeError("propose_side_case accepts only title and brief");
  }
  const title = input.title.trim();
  const brief = input.brief.trim();
  if (
    title.length === 0 ||
    title.length > SIDE_CASE_TITLE_MAX_LENGTH ||
    brief.length === 0 ||
    brief.length > SIDE_CASE_BRIEF_MAX_LENGTH
  ) {
    throw new TypeError("propose_side_case title or brief is out of bounds");
  }
  return { title, brief };
}
