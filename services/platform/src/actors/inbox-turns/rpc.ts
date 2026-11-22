import type { SerializedFlowBinding } from "../../policy";
import type { MailOrganizationActorInput } from "../../mail-inbox/commands";
import type { Result } from "@purin-labs/kernel/result";
import type { EmbeddedHarnessModelUsage } from "../embedded-harness";
import type {
  EmailCaseManifest,
  EmailCueOutcome,
  EmailSizeBreach,
} from "../email-harness-tools";
import type {
  TransientHarnessTurnInput,
  TransientModelTurnError,
} from "../session/types";
import type {
  WhatsAppCaseManifest,
  WhatsAppTurnOutcome,
} from "../whatsapp-harness-tools";

export type TransientEmailTurnRequest = TransientHarnessTurnInput & {
  readonly evidenceDependency: import("../../case-context-discovery/evidence").CaseContextCollectionEvidenceDependency;
  readonly manifest: EmailCaseManifest;
  /**
   * The accepted context this turn was prepared with. The Session verifies it
   * against `contextBundleDigest` and records it before asking the model.
   */
  readonly context: Readonly<{
    bundle: unknown;
    bundleDigest: string;
    modelContext: unknown;
  }>;
  readonly responsePolicy: import("../email-harness-tools").EmailResponsePolicy;
};

export type TransientMailAssistantRequest = TransientHarnessTurnInput &
  Readonly<{
    mailbox: MailOrganizationActorInput;
    modelRouteDigest: string;
    sourcePin: string;
  }>;

export type TransientEmailTurnReply = {
  readonly flowBinding: SerializedFlowBinding;
  /** The Memory revisions the turn's prompt carried. */
  readonly memory: readonly Readonly<{ memoryId: string; revision: number }>[];
  readonly outcome: Exclude<EmailCueOutcome, { readonly kind: "none" }>;
  readonly modelUsage: EmbeddedHarnessModelUsage;
  readonly breaches: readonly EmailSizeBreach[];
  readonly commerceEvidence: readonly import("../../mail-inbox/supplier-context").EmailCommerceEvidence[];
  /** The verified sources of a draft for approval; none for other outcomes. */
  readonly sources: import("../../mail-inbox/reply-sources").EmailReplySources;
};

/**
 * One eval turn: a mailbox reply turn that reads a reviewed scenario in place
 * of mailbox mail. It drafts and sends nothing.
 */
export type TransientEvalTurnRequest = Omit<
  TransientEmailTurnRequest,
  "manifest" | "responsePolicy" | "evidenceDependency"
> &
  Readonly<{
    integrationAccountId: string;
    fixture: Readonly<{
      /** The Eval revision and scenario the message belongs to. */
      evalId: string;
      revision: number;
      scenarioId: string;
      /** The label of that Eval revision. */
      inputLabel: unknown;
      message: import("@purin-labs/connections/mail/gmail-adapter").GmailMessageContent;
    }>;
  }>;

export type TransientEvalTurnReply = Omit<
  TransientEmailTurnReply,
  "breaches" | "commerceEvidence" | "sources"
> &
  Readonly<{ toolCatalogDigest: string }>;

export type TransientWhatsAppTurnRequest = Omit<
  TransientHarnessTurnInput,
  "maxBodyChars"
> & {
  readonly manifest: WhatsAppCaseManifest;
};

export type TransientWhatsAppTurnReply = {
  readonly outcome: Exclude<WhatsAppTurnOutcome, { readonly kind: "none" }>;
  readonly modelUsage: EmbeddedHarnessModelUsage;
};

export type TransientWhatsAppTurnResult = Result<
  TransientWhatsAppTurnReply,
  TransientModelTurnError
>;

/**
 * The RPC methods of the Inbox turns on the Session actor. The class of the
 * Worker implements them, and each method calls one function of this module.
 * A caller in another module names this interface.
 */
export interface SessionInboxTurnsRpc {
  /**
   * One transient_email turn: runs under the session's pinned inference
   * route and authority partition, reads admitted content only through the
   * purpose-bound email tools, and returns one validated plain-text body.
   * Transcripts stay out of accepted history, checkpoints, and Actor storage.
   * Goal accounting metadata persists. The native thread is deleted before the
   * turn reports complete, and a cleanup failure supersedes the outcome.
   */
  runTransientEmailTurn(
    input: TransientEmailTurnRequest,
  ): Promise<Result<TransientEmailTurnReply, TransientModelTurnError>>;
  /**
   * One transient eval turn. It runs the mailbox reply harness on a reviewed
   * scenario and returns what the agent chose. Nothing reaches the mailbox:
   * the scenario is the only message, and the outcome is only reported.
   */
  runTransientEvalTurn(
    input: TransientEvalTurnRequest,
  ): Promise<Result<TransientEvalTurnReply, TransientModelTurnError>>;
  runTransientMailAssistant(
    input: TransientMailAssistantRequest,
  ): ReturnType<typeof import("./session-turns").prepareTransientMailAssistant>;
  /**
   * One transient WhatsApp support turn. The reply is produced through the
   * `whatsapp_reply_propose` capability rather than the harness's final
   * message, so a turn that ends without a proposal or handoff is a failed
   * turn and leaves the Case retryable. Transcripts remain ephemeral;
   * goal-operation metadata persists in the Session outbox.
   */
  runTransientWhatsAppTurn(
    input: TransientWhatsAppTurnRequest,
  ): Promise<TransientWhatsAppTurnResult>;
}
