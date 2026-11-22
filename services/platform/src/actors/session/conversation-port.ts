import type {
  AuthorityPartition,
  HarnessTurnLease,
  RequestAuthority,
} from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";

import type { ChatForkHistory } from "../../chat/fork-history";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationAccess } from "../../organisation-access/access";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type { CaseConversationSinkRefusal, FlowBinding } from "../../policy";
import type { Result } from "@purin-labs/kernel/result";

/** What the side Case of a turn needs before inference. */
type SessionSideCaseAdmission = Readonly<{
  scope: OrganisationExecutionScope;
  storage: DurableObjectStorage;
  lease: HarnessTurnLease;
  authorizeCommit: () => void | Promise<void>;
  env: Env;
}>;

/**
 * The side Case that a Session serves (Plan 74), from a Portal chat or a
 * Slack thread. The Session does not read the proposal. It adds the
 * instruction to each turn and admits the proposal before inference.
 */
export interface SessionSideCase {
  /** The words that each turn of the side Case adds to its instructions. */
  readonly instruction: string;
  /** Admits the proposal of the side Case before inference. */
  admit(input: SessionSideCaseAdmission): Promise<void>;
}

/** Parses the stored proposal of one source kind of a side Case. */
export type SessionSideCaseSource = (
  raw: Record<string, unknown>,
) => Promise<SessionSideCase>;

/**
 * The conversation records that a Session turn reads: the inherited history
 * of a fork, the side Case, and the flow checks of the conversation that the
 * turn answers. The conversation module gives this value through the Worker.
 */
export interface SessionConversation {
  /** The inherited history of the fork that this Case continues. */
  readForkHistory(
    env: Env,
    scope: OrganisationExecutionScope,
    caseId: string,
  ): Promise<ChatForkHistory>;
  /** Refuses a fork history that the person may no longer read. */
  authorizeForkHistoryAccess(
    scope: OrganisationExecutionScope,
    history: ChatForkHistory,
    authority: Variant<RequestAuthority, "control">,
  ): Promise<unknown>;
  /** Joins the labels of the inherited history into the turn. */
  admitForkInformationFlow(
    db: OrganisationDatabase,
    accountAccess: OrganisationAccess,
    storage: DurableObjectStorage,
    lease: HarnessTurnLease,
    history: ChatForkHistory,
    authorizeCommit: () => void | Promise<void>,
  ): Promise<void>;
  /** The side Case that this Case is, or null. */
  readSideCase(
    scope: OrganisationExecutionScope,
    caseId: string,
  ): Promise<SessionSideCase | null>;
  /** Whether the flow of a Portal chat turn may reach the person. */
  decideFlowDelivery(
    db: OrganisationDatabase,
    accountAccess: OrganisationAccess,
    binding: FlowBinding,
    authority: Variant<RequestAuthority, "control">,
  ): Promise<Readonly<{ kind: string }>>;
  /** Whether a streamed turn may reach the conversation of a channel. */
  decideStreamSink(
    authority: Readonly<{
      requestAuthority: RequestAuthority;
      authorityPartition: Pick<AuthorityPartition, "digest">;
    }>,
    binding: FlowBinding,
    channelId: string,
    env: Env,
  ): Promise<Result<unknown, CaseConversationSinkRefusal>>;
}
