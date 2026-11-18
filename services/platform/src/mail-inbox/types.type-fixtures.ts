import type {
  MailObservation,
  MailOrganizationHead,
  MailAction,
  MailWork,
} from "./types";
import type { MailResponseOwner } from "./response-store";
import { startInboxResponse } from "./response-store";

const expired = { kind: "history_expired" } as const;
// @ts-expect-error Expired history cannot retain a usable cursor through a spread.
const mixedObservation: MailObservation = { ...expired, historyId: "10" };
// @ts-expect-error A watching mailbox requires its watch expiration.
const incompleteWatch: MailObservation = {
  kind: "watching",
  historyId: "10",
  historyPageToken: null,
};
declare const head: MailOrganizationHead;
const emptyHead: MailOrganizationHead = {
  ...head,
  // @ts-expect-error A stored organization always has published or paused rules.
  view: { kind: "empty", revision: 0, rules: [] },
};
void mixedObservation;
void incompleteWatch;
void emptyHead;
// @ts-expect-error Classification work always distinguishes arrivals and history.
const unknownOrigin: MailWork = {
  workId: "w",
  messageId: "m",
  threadId: "t",
  revision: 1,
};
declare const action: Extract<MailAction, { kind: "supplier_delay" }>;
// @ts-expect-error An organization-only publication cannot retain action authority.
const mixedAction: MailAction = { ...action, kind: "none" };
const incompleteOwner: MailResponseOwner = {
  kind: "inbox",
  messageId: "m",
  threadId: "t",
  ruleRevision: 1,
  ruleId: "r",
  // @ts-expect-error An executing response requires its exact Case and start instant.
  state: { kind: "processing" },
};
// @ts-expect-error Cue ownership cannot carry an Inbox rule revision.
const cueAction: MailResponseOwner = {
  kind: "cue",
  messageId: "m",
  threadId: "t",
  ruleRevision: 1,
};
void unknownOrigin;
void mixedAction;
void incompleteOwner;
void cueAction;
declare const sql: SqlStorage;
const closedResponse = {
  kind: "inbox",
  messageId: "m",
  threadId: "t",
  ruleRevision: 1,
  ruleId: "r",
  state: { kind: "closed", outcome: "needs_review" },
} as const;
// @ts-expect-error A closed response cannot enter execution.
startInboxResponse(sql, [closedResponse], "case_c", 1);
// @ts-expect-error A spread cannot change Inbox ownership into Cue ownership.
const changedOwner: MailResponseOwner = { ...closedResponse, kind: "cue" };
void changedOwner;
