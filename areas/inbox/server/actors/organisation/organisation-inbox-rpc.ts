import type { UserId } from "@purin-labs/control-api/ids";
import type { PlacedActorRpc } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type {
  OrganisationCommandFailure,
  OrganisationStateError,
} from "@purin-labs/tenancy/actors/organisation/types";
import type { EmailDraftSharedThread } from "../email-draft";
import type {
  MailReplyDraftAgentEdit,
  MailReplyDraftError,
  MailReplyDraftForSave,
  MailReplyDraftSnapshot,
} from "../mail-reply-draft";
import type {
  MailEvaluationError,
  MailEvaluationInput,
  MailEvaluationResult,
} from "../../mail-inbox/evaluation";

/** One command on the shared draft of a mail reply. */
type MailReplyDraftCommandResult<T> = Result<
  T,
  OrganisationCommandFailure | MailReplyDraftError
>;

/**
 * The RPC methods of the Organisation Actor that the Inbox calls: the shared
 * drafts of a mail reply and of an email, and the classification of one
 * message. `OrganisationDO`, the class of the Worker, implements this
 * interface, and the Inbox names it, not the class. The class gives the
 * comment of each method.
 */
export interface OrganisationInboxRpc {
  readEmailDraftThread(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ): Promise<EmailDraftSharedThread | null>;
  readMailReplyDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      userId: UserId;
    }>,
  ): Promise<MailReplyDraftCommandResult<MailReplyDraftSnapshot>>;
  editMailReplyDraft(
    input: MailReplyDraftAgentEdit,
  ): Promise<MailReplyDraftCommandResult<MailReplyDraftSnapshot>>;
  mailReplyDraftForSave(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      saver: UserId;
    }>,
  ): Promise<MailReplyDraftCommandResult<MailReplyDraftForSave>>;
  markMailReplyDraftSaved(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      version: number;
      body: string;
    }>,
  ): Promise<MailReplyDraftCommandResult<null>>;
  mailReplyDraftApproval(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      version: number;
    }>,
  ): Promise<MailReplyDraftCommandResult<null>>;
  reloadMailReplyDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ): Promise<MailReplyDraftCommandResult<null>>;
  closeMailReplyDraft(
    input: Readonly<{ organisationId: OrganisationId; proposalId: string }>,
  ): Promise<Result<null, OrganisationCommandFailure>>;
  evaluateMailClassification(
    input: MailEvaluationInput,
  ): Promise<
    Result<MailEvaluationResult, OrganisationStateError | MailEvaluationError>
  >;
}

/** The Organisation Actor as the Inbox sees it: its placement and its RPC. */
export type InboxOrganisationActor = PlacedActorRpc & OrganisationInboxRpc;
