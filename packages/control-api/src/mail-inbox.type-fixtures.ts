import type {
  MailInboxCommand,
  MailInboxResult,
  MailClassifiedFilter,
} from "./mail-inbox.ts";

const page = {
  kind: "page",
  integrationAccountId: "account",
  query: "",
  cursor: null,
} as const;
// @ts-expect-error A page command cannot carry a thread selection.
const mixedCommand: MailInboxCommand = { ...page, threadId: "thread" };
// @ts-expect-error Browsing requires an explicit cursor state.
const missingCursor: MailInboxCommand = {
  kind: "page",
  integrationAccountId: "account",
  query: "",
};
// @ts-expect-error Account listings cannot carry mailbox content.
const mixedResult: MailInboxResult = {
  kind: "accounts",
  accounts: [],
  messages: [],
};
void mixedCommand;
void missingCursor;
void mixedResult;
const category = { kind: "category", ruleId: "suppliers" } as const;
// @ts-expect-error Important cannot carry a category selection through a spread.
const mixedFilter: MailClassifiedFilter = { ...category, kind: "important" };
// @ts-expect-error Classified pages require the rule revision being browsed.
const unfencedPage: MailInboxCommand = {
  kind: "classifiedPage",
  integrationAccountId: "account",
  filter: category,
  cursor: null,
};
// @ts-expect-error Broad spreads cannot mix a page with decision selection.
const mixedSelection: MailInboxCommand = {
  ...page,
  messageId: "message",
  ruleId: "rule",
};
void mixedFilter;
void unfencedPage;
void mixedSelection;
