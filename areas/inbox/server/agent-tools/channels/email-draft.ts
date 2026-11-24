import { textLimit } from "@purin-labs/contract-schema";
import type { EmailDraftEditRequest } from "../../actors/email-draft";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { STORED_ACCESS_ENDED_NOTE } from "@purin-labs/agent-tools/tool-effect";
import { defineChannelTool } from "./services";

export const emailDraftRead = defineChannelTool({
  name: "email_draft_read",
  description:
    "Read the organisation's saved shared email draft after this Slack thread has been explicitly shared. " +
    "The result includes subject, preview, body, observation time, and the revision required for an edit.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseEmailDraftReadArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.marketingEmailDraftEdit,
  },
  unavailable: "email draft read is unavailable",
  handler: ({ readEmailDraft }) =>
    readEmailDraft === undefined ? undefined : () => readEmailDraft(),
});

export const emailDraftEdit = defineChannelTool({
  name: "email_draft_edit",
  description:
    "Replace one exact, unique passage in one field of the shared email draft. " +
    "Use the field text and expectedRevision returned by email_draft_read." +
    STORED_ACCESS_ENDED_NOTE,
  input: jsonSchema({
    type: "object",
    properties: {
      field: { type: "string", enum: ["subject", "preview", "body"] },
      oldText: textLimit({ type: "string", maxLength: 50000 }),
      newText: textLimit({ type: "string", maxLength: 50000 }),
      expectedRevision: { type: "integer", minimum: 0 },
    },
    required: ["field", "oldText", "newText", "expectedRevision"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseEmailDraftEditArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.marketingEmailDraftEdit,
  },
  unavailable: "email draft edit is unavailable",
  prepare: ({ editEmailDraft }) =>
    editEmailDraft === undefined
      ? undefined
      : (request, call) =>
          editEmailDraft(request, call.operationId, call.execution),
});

function parseEmailDraftReadArgs(
  args: readonly unknown[],
): Readonly<Record<string, never>> {
  if (args.length !== 1 || !isRecord(args[0]) || !hasExactKeys(args[0], [])) {
    throw new TypeError("email_draft_read arguments are invalid");
  }
  return {};
}

function parseEmailDraftEditArgs(
  args: readonly unknown[],
): EmailDraftEditRequest {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], [
      "field",
      "oldText",
      "newText",
      "expectedRevision",
    ]) ||
    (args[0].field !== "subject" &&
      args[0].field !== "preview" &&
      args[0].field !== "body") ||
    typeof args[0].oldText !== "string" ||
    args[0].oldText.length > 50_000 ||
    typeof args[0].newText !== "string" ||
    args[0].newText.length > 50_000 ||
    typeof args[0].expectedRevision !== "number" ||
    !Number.isSafeInteger(args[0].expectedRevision) ||
    args[0].expectedRevision < 0
  ) {
    throw new TypeError("email_draft_edit arguments are invalid");
  }
  return {
    field: args[0].field,
    oldText: args[0].oldText,
    newText: args[0].newText,
    expectedRevision: args[0].expectedRevision,
  };
}
