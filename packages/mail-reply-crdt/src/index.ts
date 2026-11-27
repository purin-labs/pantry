import {
  definePlainTextDoc,
  type PlainTextDocError,
  type SharedDocEncoding,
  type SharedDocResult,
  type TextInputRange,
  type TextPresenceSelection,
} from "@purin-labs/collaboration";
import {
  BODY_LIMIT,
  UPDATE_LIMIT,
  STATE_LIMIT,
  STATE_VECTOR_LIMIT,
} from "./limits.ts";
export { BODY_LIMIT, STATE_LIMIT } from "./limits.ts";
export { RelativeTextSelection as MailReplySelection } from "@purin-labs/collaboration";

export const MAIL_REPLY_SCHEMA = "mail_reply_crdt.v1";

/** The one text of a mail reply, in the root `body`. */
export const mailReplyDocument = definePlainTextDoc({
  schema: MAIL_REPLY_SCHEMA,
  root: "body",
  limits: {
    state: STATE_LIMIT,
    update: UPDATE_LIMIT,
    stateVector: STATE_VECTOR_LIMIT,
  },
  textLimit: BODY_LIMIT,
  tooLongFailure: "body_too_long",
});

type Schema = typeof MAIL_REPLY_SCHEMA;

export type MailReplyCrdtError = PlainTextDocError<"body_too_long">;
export type MailReplyCrdtResult<T> = SharedDocResult<
  T,
  MailReplyCrdtError["code"]
>;

export type MailReplyUpdate = SharedDocEncoding<"update", Schema>;
export type MailReplyStateVector = SharedDocEncoding<"state_vector", Schema>;

export const parseMailReplyState = mailReplyDocument.parseState;

export type MailReplyInputRange = TextInputRange;
export type MailReplyPresenceSelection = TextPresenceSelection;

export const MailReplyDoc = mailReplyDocument.Doc;
export type MailReplyDoc = typeof MailReplyDoc.prototype;
