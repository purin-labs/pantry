import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import { defineTool, jsonSchema } from "../define-tool";

export const messageAttachmentInspect = defineTool({
  name: "inspect_message_attachment",
  description:
    "Read bounded text or technical metadata from one file attached to the current message. " +
    "The file's digest is re-verified before any bytes are read. When no handler can read a " +
    "format, the result states that limitation rather than guessing at the contents.",
  input: jsonSchema({
    type: "object",
    properties: {
      attachmentId: { type: "string", pattern: "^att_[a-z0-9]{1,64}$" },
    },
    required: ["attachmentId"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseAttachmentInspectArgs([input]),
  effect: "read",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.messageAttachmentInspect,
  },
  unavailable: "inspect message attachment is unavailable",
  handler: (authority) => (request) =>
    authority.inspectMessageAttachment(request),
});

export const messageLinkRead = defineTool({
  name: "read_message_link",
  description:
    "Fetch a bounded read of one public HTTP(S) link carried by the current message. " +
    "No credential or cookie is sent. Private, loopback, link-local, and cloud metadata " +
    "destinations are refused, and every redirect is revalidated.",
  input: jsonSchema({
    type: "object",
    properties: {
      url: { type: "string", pattern: "^https?://", maxLength: 2048 },
    },
    required: ["url"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMessageLinkArgs([input]),
  effect: "read",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.messageLinkRead,
  },
  unavailable: "read message link is unavailable",
  handler:
    ({ readMessageLink }) =>
    (request) =>
      readMessageLink(request),
});

function parseAttachmentInspectArgs(args: readonly unknown[]): {
  readonly attachmentId: string;
} {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["attachmentId"]) ||
    typeof args[0].attachmentId !== "string" ||
    !/^att_[a-z0-9]{1,64}$/u.test(args[0].attachmentId)
  ) {
    throw new TypeError("inspect_message_attachment arguments are invalid");
  }
  return { attachmentId: args[0].attachmentId };
}

function parseMessageLinkArgs(args: readonly unknown[]): {
  readonly url: string;
} {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["url"]) ||
    typeof args[0].url !== "string" ||
    args[0].url.length > 2048 ||
    !/^https?:\/\//u.test(args[0].url)
  ) {
    throw new TypeError("read_message_link arguments are invalid");
  }
  return { url: args[0].url };
}
