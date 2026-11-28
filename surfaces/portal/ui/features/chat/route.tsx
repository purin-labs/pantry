import { ChatApprovalTrace, ChatReceiptTrace } from "./operation-events";
import { ChatGoalControl, DEFAULT_GOAL_TOKEN_BUDGET } from "./goal";
import { ChatExecutionTrace } from "./execution-trace";
import { effortLabel } from "@purin-labs/ui/features/chat/effort-labels";
import { useUserPreferences } from "@purin-labs/ui/preferences/context";
import type { UserPreferenceOwner } from "@purin-labs/ui/preferences/owner";
import {
  newConversationId,
  isConversationId,
  sideCaseHereRequestId,
  type ChatSideCaseView,
} from "@purin-labs/control-api";
import { MESSAGE_ATTACHMENT_POLICY, type ConversationId, type ProjectId, type VoiceHeard } from "@purin-labs/control-api";
import { publishChatAgentRequest } from "./agent-request";
import {
  clearSubmittedDraft,
  ComposerSubmissions,
  isOlderSnapshot,
  removeAcceptedQueue,
  restoreQueuedDraft,
  toQueuedInput,
  withoutOutgoing,
} from "./submission";
import { captureBakeryBrowserContext } from "@purin-labs/area-kitchen-contract/ui/features/bakery-browser-context";
import { type BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import {
  QuestionCard,
  StreamingText,
  EmptyState,
  questionAnswerText,
  type QuestionAnswer,
  type QuestionAvailability,
  type QuestionSubmitResult,
  MessageScroller,
  ResponseActions,
  type ResponseRating,
  type ResponseActionResult,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  TraceLine,
  TraceIcon,
  TraceTitle,
} from "@purin-labs/ui/index";
import React from "react";
import { toast } from "sonner";
import { ThreadTitle } from "./thread-title";
import {
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FileText,
  Folder,
  GitBranch,
  History,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  MessageSquareWarning,
  Paperclip,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Split,
  SquarePen,
  X,
} from "lucide-react";
import { ChatDisplayContext, ChatFullscreenButton } from "./underlay";
import { DashboardSidebarToggleIcon } from "@purin-labs/ui/dashboard-sidebar-toggle-icon";
import { ChatOrganizer } from "./organizer";
import { ProjectCases } from "./project-cases";
import { ChatSources, chatSourceParts } from "./sources";
import {
  ChatContextChip,
  type ChatWorkspaceContext,
} from "./context";
import { ChatResponseIndicator, renderChatTimeline } from "./activity";
import { ComposerGlow } from "./composer-glow";
import { ChatSelectedFile } from "./selected-file";
import { ChatPermissionPrompt } from "./permission-prompt";
import { ChatHeldStepPrompt } from "@purin-labs/area-organisation/ui/features/access/chat-held-step-prompt";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";
import {
  DialogHeading,
  syncDialog,
  cancelDialog,
  isBackdropClick,
} from "@purin-labs/ui/dialog";
import { soundsLikeStop, type VoiceCommand } from "@purin-labs/surface-voice/ui/features/voice/command";
import {
  lastAssistantEvent,
  speakVoiceAnswer,
  type VoiceAnswerWait,
} from "@purin-labs/surface-voice/ui/features/voice/answer";
import { VoiceControl, VoiceHeaderMark } from "@purin-labs/surface-voice/ui/features/voice/control";
import { UserMessageMarks } from "./message-marks";
import { holdSendForScreenQuestion, ScreenChip } from "./screen-chip";
import { ContextEstimateMenu, WorkspaceAccessMenu } from "./composer-menus";
import { mergeDirectoryResult, updateSavedDraft, type PageState } from "./page-state";
import { VoiceApprovalContext } from "@purin-labs/surface-voice/ui/features/voice/approvals";
import {
  attachVoiceChat,
  noteVoiceConversation,
  voiceSessionFor,
} from "@purin-labs/surface-voice/ui/features/voice/host";
import { CustomConnectorsWorkspace } from "@purin-labs/area-integrations/ui/features/integrations/custom-connectors";
import {
  customConnectorCollectionPath,
  customConnectorPath,
  customConnectorRevisionPath,
  mutateCustomConnector,
} from "@purin-labs/area-integrations-contract/ui/features/integrations/custom-connector-api";
import { createProjectChat, forkChatThread, makeDefaultProject, cancelChat, ChatDraftConflictError, ChatNotRunningError, ChatAccessError, markChatRead, rateChatResponse, readChat, saveChatDraft, updateChatConversation } from "./api";
import { sendChat } from "./screen-send";
import type { Chat, ChatConversationSummary, ChatMessage, ChatModelOption, ChatPageData, ChatTimelineView, ChatAttachmentView } from "@purin-labs/control-api/portal/chat";
import {
  ChatDelivery,
  type ChatStreamState,
  type DeliveryIdentity,
} from "./delivery";
import { ChatSignalSocket } from "./signals";
import {
  bakerySurfaceForOrganisation,
  notifySurfaceListeners,
  subscribeBakerySurface,
} from "@purin-labs/area-kitchen-contract/ui/features/bakery-surface-registry";
import { createEmailReviewActions } from "@purin-labs/area-inbox-contract/ui/features/email-review/api";
import { emailDraftInserts, slackDraftInserts } from "./draft-cards";
import type { MailSourceLinks } from "@purin-labs/area-inbox-contract/ui/features/mail-inbox/draft-sources";
import { createSlackDraftActions } from "./slack-drafts";
import { createConfigurationDraftActions } from "./configuration-drafts";
import { configurationDraftInserts } from "./configuration-draft-cards";
import { createSideCaseActions } from "./side-cases";
import { sideCaseInserts } from "./side-case-cards"; import { chatCommerceActionCards, withoutCommerceActionLinks } from "@purin-labs/area-commerce/ui/features/governed-actions/chat-commerce-action-card";
import "./styles.css";
import type { Variant } from "@purin-labs/type-utils";
import type {
  ChatEffort,
  ChatTurnUsage,
  Project,
  ProjectReference,
} from "@purin-labs/control-api";
import { errorMessage } from "@purin-labs/std";
import {
  chooseSupportedEffort,
  modelName,
  modelOptionHasId,
  renderEffortOption,
  selectedEffortFromConversation,
  selectedEffortFromData,
  selectedEffortFromState,
  selectedModelFromData,
  selectedModelFromState,
} from "./model-choice";
type Props = {
  readonly context: ChatWorkspaceContext;
  readonly preferences?: UserPreferenceOwner | null;
  readonly close: () => void;
  readonly organisationId: string;
  readonly basePath: string;
  readonly integrationsPath: string;
  readonly accessPath: string;
  /** The pages that an email draft's sources open. */
  readonly sourceLinks?: MailSourceLinks;
  readonly canManage: boolean;
  readonly access: Pick<AccessRouteTransport, "read" | "mutate">;
  readonly signedInAs: string | null;
};
type State = {
  readonly forking: boolean;
  readonly forkConfirmation: {
    readonly sourceId: ConversationId;
    readonly messageId: string;
  } | null;
  readonly queued: readonly { readonly id: string; readonly text: string }[];
  readonly steering: boolean;
  /** The queued message that is on its way into the running turn. */
  readonly steeringQueuedId: string | null;
  /** The cancellation that has run long enough to offer Retry stop. */
  readonly stopRetryDueFor: string | null;
  readonly page: PageState;
  readonly selectedModel: string | null;
  readonly selectedEffort: ChatEffort | null;
  readonly draft: string;
  readonly files: readonly File[];
  readonly sending: boolean;
  /**
   * The message that the person sent and the server has not accepted yet.
   * The thread shows it at once; the accepted turn replaces it.
   */
  readonly outgoing: {
    readonly conversationId: ConversationId;
    readonly text: string;
  } | null;
  readonly error: string | null;
  readonly draftConflictNotice: {
    readonly conversationId: ConversationId;
  } | null;
  readonly setupOpen: boolean;
  readonly history: "closed" | "open" | "closing";
  readonly openingConversationId: ConversationId | null;
  readonly savingCard: string | null;
  readonly stream: ChatStreamState;
  readonly observationVersion: number;
  readonly metadataUpdate: ChatMetadataUpdateState;
  readonly threadQuery: string;
  readonly threadsExpanded: boolean;
  readonly threadsWidth: number;
  readonly selectedProject: Project | null;
};

type ThreadPreview = {
  readonly id: ConversationId;
  readonly read: Promise<ChatPageData | null>;
  finishedAt: number | null;
};

function threadPreviewIsFresh(preview: ThreadPreview): boolean {
  return (
    preview.finishedAt === null ||
    Date.now() - preview.finishedAt <= THREAD_PREVIEW_ANSWER_MS
  );
}
function readNoThreadPreview(): null {
  return null;
}
/** A click on a chat with open work must run the read that reconnects it. */
function previewOfReadyThread(data: ChatPageData | null): ChatPageData | null {
  return data?.conversation?.work.kind === "ready" ? data : null;
}

type ChatThreadsResize = {
  readonly pointerId: number;
  readonly anchor: number;
  width: number;
  moved: boolean;
};

type ChatMetadataUpdateState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "updating";
      readonly conversationId: ConversationId;
    };

type BakeryContextCapture =
  | Readonly<{ kind: "captured"; browserContext: BakeryBrowserContext }>
  | Readonly<{ kind: "failed"; message: string }>;

/** Signals that arrive within this time give one read. */
/** How long the pointer rests on a row before its read starts. */
const THREAD_PREVIEW_REST_MS = 120;
/** How long a click may use a read that finished before it. */
const THREAD_PREVIEW_ANSWER_MS = 5_000;
const SIGNAL_READ_DELAY_MS = 150;
/** While the signal socket is live, the page still reads this often. */
const SIGNAL_SAFETY_READ_MS = 60_000;
const EMPTY_DIRECTORY = {
  apps: [],
  workspaceSetup: [],
  connectedApps: [],
  onQueryChange: ignoreQuery,
};
function ignoreQuery(): void {}

export class ChatPage extends React.Component<Props, State> {
  private unsubscribePreferences: (() => void) | null = null;
  private sidebarSaveTimer: ReturnType<typeof setTimeout> | null = null;
  static contextType = ChatDisplayContext;
  declare context: React.ContextType<typeof ChatDisplayContext>;
  state: State = {
    forking: false,
    forkConfirmation: null,
    queued: [],
    steering: false,
    steeringQueuedId: null,
    stopRetryDueFor: null,
    page: { kind: "loading" },
    selectedModel: null,
    selectedEffort: null,
    draft: "",
    files: [],
    sending: false,
    outgoing: null,
    error: null,
    draftConflictNotice: null,
    history: "closed",
    openingConversationId: null,
    setupOpen: new URLSearchParams(window.location.search).has(
      "customConnector",
    ),
    savingCard: null,
    stream: { kind: "idle" },
    observationVersion: 0,
    metadataUpdate: { kind: "idle" },
    threadQuery: "",
    threadsExpanded: false,
    threadsWidth: 360,
    selectedProject: null,
  };
  private readonly historyDialog = React.createRef<HTMLDialogElement>();
  private readonly forkDialog = React.createRef<HTMLDialogElement>();
  private readonly dialog = React.createRef<HTMLDialogElement>();
  private readonly composer = React.createRef<HTMLTextAreaElement>();
  private readonly goal = React.createRef<ChatGoalControl>();
  private readonly transcript = React.createRef<MessageScroller>();
  private readonly threadFiles = new Map<string, readonly File[]>();
  private readonly threadDrafts = new Map<ConversationId, string>();
  private readonly threadScrollPositions = new Map<string, number>();
  private readonly layout = React.createRef<HTMLDivElement>();
  private threadsResize: ChatThreadsResize | null = null;
  private delivery: ChatDelivery | null = null;
  private signals: ChatSignalSocket | null = null;
  private signalTimer: number | null = null;
  private signalPending = false;
  private lastReadAt = 0;
  private readonly onVisibilityChange = this.acceptVisibility.bind(this);
  private mounted = false;
  private loading = false;
  private readonly submissions = new ComposerSubmissions();
  private selectionVersion = 0;
  private navigationVersion = 0;
  private threadPreview: ThreadPreview | null = null;
  private threadPreviewTimer: number | null = null;
  private readonly onHistoryChange = this.restoreLocation.bind(this);
  private readonly onThreadsViewportChange =
    this.cancelThreadsResize.bind(this);
  private forkPending = false;
  private conversationId = initialConversationId();
  private pending: {
    readonly requestId: string;
    readonly model: string;
    readonly text: string;
    readonly files: readonly File[];
    readonly effort: ChatEffort;
    readonly browserContext: BakeryBrowserContext;
    readonly goalTokenBudget: number | null;
  } | null = null;
  private pendingQueueAdmission: {
    readonly inputId: string;
    readonly requestId: string;
    readonly model: string;
    readonly text: string;
    readonly files: readonly File[];
    readonly effort: ChatEffort;
    readonly browserContext: BakeryBrowserContext;
  } | null = null;
  private pendingSteering: {
    readonly inputId: string;
    readonly requestId: string;
    readonly cancellationId: string;
    readonly model: string;
    readonly text: string;
    readonly files: readonly File[];
    readonly effort: ChatEffort;
    readonly browserContext: BakeryBrowserContext;
  } | null = null;
  private observedReadSequence = 0;
  private branchPointLocation: string | null = null;
  private draftSaveTimer: number | null = null;
  private stopRetryTimer: number | null = null;
  private watchedCancellation: string | null = null;
  private chatRefreshTimer: number | null = null;
  private draftSavePromise: Promise<void> | null = null;
  private directorySearchTimer: number | null = null;
  private directorySearchVersion = 0;
  private draftDirty = false;
  private readonly dismissComposerMenus =
    this.closeComposerMenusOutside.bind(this);
  private unsubscribeBakerySurface: (() => void) | null = null;
  private voice = voiceSessionFor(this.props.organisationId);
  private detachVoice: (() => void) | null = null;
  private voiceAnswer: VoiceAnswerWait | null = null;

  componentDidMount(): void {
    this.unsubscribePreferences =
      this.props.preferences?.subscribe(this.syncChatPreferences.bind(this)) ??
      null;
    this.syncChatPreferences();
    void this.props.preferences?.load("chat");
    this.mounted = true;
    window.addEventListener("popstate", this.onHistoryChange);
    window.addEventListener("resize", this.onThreadsViewportChange);
    document.addEventListener("pointerdown", this.dismissComposerMenus);
    this.unsubscribeBakerySurface = subscribeBakerySurface(
      this.syncBakerySurface.bind(this),
    );
    this.forceUpdate();
    const draftKey = `connector-chat-draft:${this.props.basePath}`;
    const connectorDraft = sessionStorage.getItem(draftKey);
    if (connectorDraft !== null) {
      sessionStorage.removeItem(draftKey);
      // The first refresh must keep these words, as it keeps a person's typing.
      this.draftDirty = true;
      this.setState({ draft: connectorDraft });
    }
    void this.refresh();
    this.signals = new ChatSignalSocket(
      this.props.organisationId,
      this.acceptSignal.bind(this),
      this.acceptSignal.bind(this),
    );
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    // The poll runs only while the signal socket is down.
    this.chatRefreshTimer = window.setInterval(
      this.refreshVisibleChatsWithoutSignals.bind(this),
      5000,
    );
  }
  componentDidUpdate(previous: Props): void {
    this.watchStopRetry();
    if (previous.organisationId !== this.props.organisationId) {
      this.detachVoice?.();
      this.detachVoice = null;
      this.voice = voiceSessionFor(this.props.organisationId);
    }
    if (this.detachVoice === null && this.state.page.kind === "ready")
      this.detachVoice = attachVoiceChat(
        this.props.organisationId,
        this.acceptVoiceCommand.bind(this),
      );
    if (
      this.context?.fullscreen !== true ||
      !this.state.threadsExpanded ||
      this.state.history !== "closed"
    ) {
      this.cancelThreadsResize();
    }
    syncDialog(this.dialog, this.state.setupOpen);
    syncDialog(this.historyDialog, this.state.history !== "closed");
    syncDialog(this.forkDialog, this.state.forkConfirmation !== null);
    this.syncStream();
    publishChatAgentRequest(this.state, this.stop.bind(this));
    this.restoreBranchPointLocation();
    this.markConversationRead();
    this.speakVoiceAnswer();
  }
  private speakVoiceAnswer(): void {
    const waiting = this.voiceAnswer;
    if (waiting === null || this.state.page.kind !== "ready") return;
    this.voiceAnswer = null;
    this.voiceAnswer = speakVoiceAnswer(
      this.voice,
      waiting,
      this.state.page.data.conversation,
      this.state.stream,
    );
  }
  /**
   * The transcript of a spoken command takes the typed send path: a new message
   * when the agent is idle and `next` or `steer` when it works. The person's
   * draft and files stay as they are. Returns a sentence to speak on a failure.
   */
  private async acceptVoiceCommand(
    command: Exclude<VoiceCommand, Readonly<{ kind: "empty" }>>,
    heard: VoiceHeard,
  ): Promise<string | null> {
    if (this.state.page.kind !== "ready") return "The chat is not ready.";
    if (this.isArchived()) return "This chat is archived.";
    const conversation = this.state.page.data.conversation;
    if (
      command.kind === "stop" ||
      (command.kind === "send" &&
        chatWorkIsActive(conversation?.work) &&
        soundsLikeStop(command.text, heard.engine))
    ) {
      // The person stopped the turn, so the rest of its answer stays unspoken.
      this.voiceAnswer = null;
      this.voice.releaseAnnouncements();
      await this.stop();
      return null;
    }
    if (this.submissions.sending(this.conversationId) || this.state.sending)
      return "Wait for the current message to finish sending.";
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null) return "Connect an AI first.";
    const selectionVersion = this.selectionVersion;
    const started = this.startConversation();
    const ticket = this.submissions.begin(started, "send", command.text);
    this.setState({ sending: true, error: null });
    try {
      const capture = await this.captureBakeryContext();
      if (capture.kind === "failed") throw new Error(capture.message);
      const shared = {
        conversationId: started,
        requestId: crypto.randomUUID(),
        model,
        text: command.text,
        browserContext: capture.browserContext,
        effort: selectedEffortFromState(
          this.state.selectedEffort,
          this.state.page.data,
        ),
        inputMode: { kind: "voice", transcriptionPath: heard.path, transcriptionEngine: heard.engine },
      } as const;
      const lastAssistantId =
        conversation === null
          ? null
          : (lastAssistantEvent(conversation)?.eventId ?? null);
      const accepted = await sendChat(
        this.props.organisationId,
        !chatWorkIsActive(conversation?.work)
          ? { kind: "message", ...shared }
          : command.kind === "steer"
            ? {
                kind: "steer",
                inputId: crypto.randomUUID(),
                cancellationId: crypto.randomUUID(),
                ...shared,
              }
            : { kind: "next", inputId: crypto.randomUUID(), ...shared },
      );
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.voiceAnswer = {
          conversationId: accepted.id,
          requestId: shared.requestId,
          lastAssistantId,
          spoken: [],
        };
        this.voice.holdAnnouncements();
        noteVoiceConversation(this.props.organisationId, accepted.id);
        this.acceptConversation(accepted);
        this.scrollToLatest();
      }
      return null;
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
      return "I could not send that. Look at the screen.";
    } finally {
      this.submissions.settle(ticket);
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  }
  private restoreBranchPointLocation(): void {
    if (this.state.page.kind !== "ready") return;
    const conversation = this.state.page.data.conversation;
    const hash = window.location.hash;
    if (conversation === null || !hash.startsWith("#message-")) {
      this.branchPointLocation = null;
      return;
    }
    const location = `${conversation.id}:${hash}`;
    if (this.branchPointLocation === location) return;
    const messageId = hash.slice("#message-".length);
    if (!conversation.timeline.some(timelineEventHasId.bind(null, messageId)))
      return;
    this.branchPointLocation = location;
    focusBranchPoint(messageId);
  }
  componentWillUnmount(): void {
    if (this.stopRetryTimer !== null) window.clearTimeout(this.stopRetryTimer);
    // The microphone stays on while the chat is closed (voice/host.ts).
    this.detachVoice?.();
    this.endThreadPreviewWait();
    if (this.chatRefreshTimer !== null)
      window.clearInterval(this.chatRefreshTimer);
    this.signals?.dispose();
    this.signals = null;
    if (this.signalTimer !== null) window.clearTimeout(this.signalTimer);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.unsubscribePreferences?.();
    if (this.sidebarSaveTimer !== null) clearTimeout(this.sidebarSaveTimer);
    document.removeEventListener("pointerdown", this.dismissComposerMenus);
    window.removeEventListener("popstate", this.onHistoryChange);
    window.removeEventListener("resize", this.onThreadsViewportChange);
    this.stopStream();
    this.cancelDirectorySearch();
    this.unsubscribeBakerySurface?.();
    this.unsubscribeBakerySurface = null;
    void this.flushDraftSave();
    this.mounted = false;
  }
  private syncBakerySurface(): void {
    if (this.mounted) {
      this.forceUpdate();
      if (this.state.page.kind === "ready" && this.conversationId !== null)
        void this.refresh("observe");
    }
  }
  // The composer chip decides at send time if the Kitchen view goes too.
  private async captureBakeryContext(): Promise<BakeryContextCapture> {
    if (this.conversationId === null)
      return { kind: "failed", message: "The conversation is unavailable." };
    const browserContext = await captureBakeryBrowserContext(
      this.props.organisationId,
      this.conversationId,
    );
    return { kind: "captured", browserContext };
  }
  private closeComposerMenusOutside(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const menus = this.layout.current?.querySelectorAll<HTMLDetailsElement>(
      'details[name="composer-menu"][open]',
    );
    if (menus === undefined) return;
    for (const menu of menus) {
      if (!menu.contains(target)) menu.open = false;
    }
  }
  private async refresh(
    mode: "reconnect" | "observe" = "reconnect",
  ): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.loading) return;
    this.loading = true;
    this.lastReadAt = Date.now();
    try {
      const read = await readChat(
        this.props.organisationId,
        this.conversationId,
        this.state.threadQuery,
        mode,
      );
      if (this.mounted && selectionVersion === this.selectionVersion) {
        const previous =
          this.state.page.kind === "ready"
            ? this.state.page.data.conversation
            : null;
        const data = isOlderSnapshot(previous, read.conversation)
          ? { ...read, conversation: previous }
          : read;
        if (
          previous?.sharing?.visibility === "shared" &&
          data.conversation === null
        ) {
          this.clearSharedContent();
        }
        this.setState({
          page: { kind: "ready", data },
          observationVersion: this.state.observationVersion + 1,
          selectedProject:
            this.state.selectedProject === null
              ? null
              : (data.projectDirectory.projects.find(
                  projectHasId.bind(null, this.state.selectedProject.id),
                ) ?? null),
          selectedModel:
            this.state.selectedModel ?? selectedModelFromData(data),
          selectedEffort: selectedEffortFromData(data),
          draft:
            this.draftDirty || this.submissions.holdsDraft(this.conversationId)
              ? this.state.draft
              : (data.conversation?.draft.text ?? ""),
          stream: streamAfterConversationRefresh(
            data.conversation?.work,
            this.state.stream,
          ),
          queued: data.conversation?.pendingInputs.map(toQueuedInput) ?? [],
        });
      }
    } catch (error) {
      if (
        this.mounted &&
        selectionVersion === this.selectionVersion &&
        error instanceof ChatAccessError
      ) {
        this.clearSharedContent();
        this.setState({ page: { kind: "failed", message: error.message } });
        return;
      }
      if (
        this.mounted &&
        selectionVersion === this.selectionVersion &&
        this.state.page.kind === "loading"
      )
        this.setState({
          page: {
            kind: "failed",
            message: errorMessage(error, "Something went wrong. Try again."),
          },
        });
    } finally {
      if (selectionVersion === this.selectionVersion) this.loading = false;
    }
  }
  /**
   * Polls while the signal socket is down. While it is live, the page still
   * reads now and then, so a signal that never came costs at most that wait.
   */
  private refreshVisibleChatsWithoutSignals(): void {
    if (
      this.signals?.live() !== true ||
      Date.now() - this.lastReadAt >= SIGNAL_SAFETY_READ_MS
    )
      this.refreshVisibleChats();
  }
  /**
   * A signal or a new socket connection means that the chats changed. Signals
   * that arrive close together give one read, and a hidden page reads when it
   * shows again.
   */
  private acceptSignal(): void {
    this.signalPending = true;
    if (this.signalTimer === null)
      this.signalTimer = window.setTimeout(
        this.readSignalledChange.bind(this),
        SIGNAL_READ_DELAY_MS,
      );
  }
  private readSignalledChange(): void {
    this.signalTimer = null;
    if (!this.signalPending || document.visibilityState !== "visible") return;
    // A read that runs now may have started before the change: the signal
    // waits for it and reads again.
    if (this.loading || this.state.page.kind !== "ready") {
      this.signalTimer = window.setTimeout(
        this.readSignalledChange.bind(this),
        SIGNAL_READ_DELAY_MS,
      );
      return;
    }
    this.signalPending = false;
    this.refreshVisibleChats();
  }
  /** A page that shows again reads the signal that came while it was hidden. */
  private acceptVisibility(): void {
    if (this.signalTimer !== null) window.clearTimeout(this.signalTimer);
    this.readSignalledChange();
  }
  private refreshVisibleChats(): void {
    if (
      document.visibilityState !== "visible" ||
      this.state.page.kind !== "ready"
    )
      return;
    this.markConversationRead();
    void this.refresh("observe");
  }
  private clearSharedContent(): void {
    this.selectionVersion++;
    this.navigationVersion++;
    this.directorySearchVersion++;
    this.loading = false;
    this.conversationId = null;
    this.pending = null;
    this.pendingQueueAdmission = null;
    this.pendingSteering = null;
    this.observedReadSequence = 0;
    this.cancelDirectorySearch();
    this.stopStream();
    this.cancelDraftSave();
    this.draftDirty = false;
    this.threadScrollPositions.clear();
    this.threadFiles.clear();
    this.threadDrafts.clear();
    this.setState({ files: [] });
    this.setState({
      draft: "",
      queued: [],
      sending: false,
      steering: false,
      steeringQueuedId: null,
      openingConversationId: null,
      savingCard: null,
      metadataUpdate: { kind: "idle" },
      stream: { kind: "idle" },
      selectedProject: null,
      draftConflictNotice: null,
      error:
        "Project access changed. Unavailable shared content has been cleared.",
    });
  }
  private markConversationRead(): void {
    if (
      this.state.setupOpen ||
      this.state.history !== "closed" ||
      this.state.forkConfirmation !== null ||
      this.state.page.kind !== "ready"
    )
      return;
    const conversation = this.state.page.data.conversation;
    if (
      conversation === null ||
      conversation.latestSequence <= conversation.lastReadSequence
    )
      return;
    const transcript = this.transcript.current;
    if (
      document.visibilityState !== "visible" ||
      transcript === null ||
      !transcript.isAtEnd()
    )
      return;
    if (conversation.latestSequence <= this.observedReadSequence) return;
    const observed = conversation.latestSequence;
    this.observedReadSequence = observed;
    void this.persistConversationRead(
      conversation.id,
      observed,
      this.selectionVersion,
    );
  }
  private async persistConversationRead(
    conversationId: ConversationId,
    observed: number,
    selectionVersion: number,
  ): Promise<void> {
    try {
      await markChatRead(this.props.organisationId, conversationId, observed);
      if (this.mounted)
        this.setState(
          applyConversationRead.bind(null, conversationId, observed),
        );
    } catch {
      if (
        this.mounted &&
        selectionVersion === this.selectionVersion &&
        this.observedReadSequence === observed
      )
        this.observedReadSequence = 0;
    }
  }
  private changeThreadQuery(event: React.ChangeEvent<HTMLInputElement>): void {
    const query = event.currentTarget.value;
    this.setState({ threadQuery: query });
    this.cancelDirectorySearch();
    const version = ++this.directorySearchVersion;
    this.directorySearchTimer = window.setTimeout(
      this.refreshDirectory.bind(this, query, version),
      250,
    );
  }
  private cancelDirectorySearch(): void {
    if (this.directorySearchTimer !== null)
      window.clearTimeout(this.directorySearchTimer);
    this.directorySearchTimer = null;
  }
  private async refreshDirectory(
    query: string,
    version: number,
  ): Promise<void> {
    this.directorySearchTimer = null;
    try {
      const data = await readChat(this.props.organisationId, null, query);
      if (this.mounted && version === this.directorySearchVersion)
        this.setState(mergeDirectoryResult.bind(null, data));
    } catch (error) {
      if (this.mounted && version === this.directorySearchVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    }
  }
  private changeDraft(event: React.ChangeEvent<HTMLTextAreaElement>): void {
    this.draftDirty = true;
    this.setState({ draft: event.currentTarget.value });
    this.scheduleDraftSave();
  }
  private scheduleDraftSave(): void {
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(this.saveDraft.bind(this), 500);
  }
  private async saveDraft(): Promise<void> {
    this.draftSaveTimer = null;
    if (this.draftSavePromise !== null) {
      await this.draftSavePromise;
      if (this.draftDirty) await this.saveDraft();
      return;
    }
    const save = this.persistDraft();
    this.draftSavePromise = save;
    try {
      await save;
    } finally {
      if (this.draftSavePromise === save) this.draftSavePromise = null;
    }
  }
  private async persistDraft(): Promise<void> {
    if (
      !this.draftDirty ||
      this.conversationId === null ||
      this.state.page.kind !== "ready" ||
      this.state.page.data.conversation === null
    )
      return;
    const conversation = this.state.page.data.conversation;
    let expectedUpdatedAt = conversation.draft.updatedAt;
    try {
      while (this.draftDirty && this.conversationId === conversation.id) {
        const draft = this.state.draft;
        const saved = await saveChatDraft(
          this.props.organisationId,
          conversation.id,
          draft,
          expectedUpdatedAt,
        );
        expectedUpdatedAt = saved.updatedAt;
        if (this.conversationId !== conversation.id) return;
        if (this.state.draft === draft) this.draftDirty = false;
        if (this.mounted) {
          this.setState(updateSavedDraft.bind(null, saved, conversation.id));
          this.setState({ draftConflictNotice: null });
        }
      }
    } catch (error) {
      if (!this.mounted) return;
      if (error instanceof ChatDraftConflictError) {
        this.draftDirty = true;
        this.setState({
          draftConflictNotice: { conversationId: conversation.id },
        });
        return;
      }
      this.setState({
        error: errorMessage(error, "Something went wrong. Try again."),
      });
    }
  }
  private cancelDraftSave(): void {
    if (this.draftSaveTimer === null) return;
    window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = null;
  }
  private dismissDraftConflict(): void {
    this.setState({ draftConflictNotice: null });
  }
  private async flushDraftSave(): Promise<void> {
    this.cancelDraftSave();
    await this.saveDraft();
  }
  private retryLoad(): void {
    this.setState({ page: { kind: "loading" } });
    void this.refresh();
  }
  private choosePrompt(text: string): void {
    this.draftDirty = true;
    this.setState({ draft: text });
    this.scheduleDraftSave();
    this.composer.current?.focus();
  }
  private scrollToLatest(): void {
    this.transcript.current?.scrollToEnd();
  }
  private submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    this.submitDraft(false);
  }
  private isWorking(): boolean {
    return (
      this.submissions.sending(this.conversationId) ||
      this.state.sending ||
      (this.state.page.kind === "ready" &&
        chatWorkIsActive(this.state.page.data.conversation?.work))
    );
  }
  private isArchived(): boolean {
    return (
      this.state.page.kind === "ready" &&
      this.state.page.data.conversation?.lifecycle === "archived"
    );
  }
  private composerKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    this.submitDraft(event.ctrlKey);
  }
  private submitDraft(steer: boolean): void {
    const text = this.state.draft.trim();
    if (!text || text.length > 8000 || this.state.steering || this.isArchived())
      return;
    const goalCommand = /^\/goal(?:\s+([\s\S]+))?$/.exec(text);
    if (goalCommand !== null) {
      void this.runGoalCommand(goalCommand[1]?.trim() ?? null);
      return;
    }
    if (holdSendForScreenQuestion(text)) return;
    if (this.isWorking()) {
      if (steer) {
        void this.steer(text);
        return;
      }
      void this.enqueue(text);
      return;
    }
    void this.send(text, null);
  }
  /** "New chat from this page": the draft leaves this chat for a new one. */
  private async moveDraftToNewChat(text: string): Promise<void> {
    await new Promise<void>((done) => this.setState({ draft: "" }, done));
    this.draftDirty = true;
    await this.selectThread(null, true);
    this.draftDirty = true;
    this.setState({ draft: text });
  }
  private clearDraft(): void {
    this.draftDirty = true;
    this.setState({ draft: "" });
    this.scheduleDraftSave();
  }
  /** `/goal` opens the goal drawer; `/goal <objective>` sets it and starts. */
  private async runGoalCommand(objective: string | null): Promise<void> {
    const goal = this.goal.current;
    if (goal === null) {
      // A new chat has no goal to edit yet. `/goal <objective>` starts the chat
      // with the message as its goal; the server sets it before the turn runs.
      if (objective === null) {
        this.setState({ error: "Type /goal followed by what you want done." });
        return;
      }
      this.draftDirty = true;
      this.setState({ draft: objective, error: null }, () => {
        void this.send(objective, null, DEFAULT_GOAL_TOKEN_BUDGET);
      });
      return;
    }
    if (objective === null) {
      this.clearDraft();
      goal.openEditor();
      return;
    }
    if (!(await goal.startGoal(objective))) return;
    this.draftDirty = true;
    this.setState({ draft: objective, error: null }, () => {
      void this.send(objective, null);
    });
  }
  private async enqueue(text: string): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.conversationId === null || this.state.page.kind !== "ready")
      return;
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null) return;
    const effort = selectedEffortFromState(
      this.state.selectedEffort,
      this.state.page.data,
    );
    const conversationId = this.conversationId;
    const ticket = this.submissions.begin(conversationId, "queue", text);
    if (ticket === null) return;
    try {
      if (
        this.pendingQueueAdmission === null ||
        this.pendingQueueAdmission.text !== text ||
        this.pendingQueueAdmission.model !== model ||
        this.pendingQueueAdmission.effort !== effort ||
        this.pendingQueueAdmission.files !== this.state.files
      ) {
        const capture = await this.captureBakeryContext();
        if (!this.mounted || selectionVersion !== this.selectionVersion) return;
        if (capture.kind === "failed") {
          this.setState({ error: capture.message });
          return;
        }
        this.pendingQueueAdmission = {
          inputId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          model,
          text,
          effort,
          files: this.state.files,
          browserContext: capture.browserContext,
        };
      }
      const pending = this.pendingQueueAdmission;
      await this.prepareComposerSubmission(text, selectionVersion);
      this.cancelDraftSave();
      this.draftDirty = false;
      this.setState(clearSubmittedDraft.bind(null, text));
      this.setState({ error: null, draftConflictNotice: null });
      const conversation = await sendChat(
        this.props.organisationId,
        {
          kind: "next",
          conversationId,
          requestId: pending.requestId,
          inputId: pending.inputId,
          model: pending.model,
          text: pending.text,
          browserContext: pending.browserContext,
          effort: pending.effort,
        },
        pending.files,
      );
      this.clearSubmittedFiles(conversationId, pending.files);
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.pendingQueueAdmission = null;
        this.acceptConversation(conversation);
      }
    } catch (error) {
      if (!this.mounted || selectionVersion !== this.selectionVersion) return;
      if (error instanceof ChatNotRunningError) {
        this.sendAfterFinishedTurn(text);
        return;
      }
      this.setState(
        restoreQueuedDraft.bind(
          null,
          text,
          errorMessage(error, "Something went wrong. Try again."),
        ),
      );
    } finally {
      this.submissions.settle(ticket);
    }
  }
  /**
   * The server finished the turn while the Portal still showed it. The message
   * starts the next turn, with its files, and the person does nothing.
   */
  private sendAfterFinishedTurn(text: string): void {
    this.pendingQueueAdmission = null;
    this.pendingSteering = null;
    this.setState(
      restoreQueuedDraft.bind(null, text, null),
      this.sendRestoredDraft.bind(this, text),
    );
  }
  private sendRestoredDraft(text: string): void {
    void this.send(text, null);
  }
  private removeQueued(id: string): void {
    void this.withdrawQueued(id);
  }
  private async withdrawQueued(inputId: string): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.conversationId === null) return;
    try {
      const conversation = await sendChat(this.props.organisationId, {
        kind: "withdraw",
        conversationId: this.conversationId,
        inputId,
      });
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.acceptConversation(conversation);
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    }
  }
  /** The message stays in the queue until the server has moved it. */
  private async steerQueued(inputId: string): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.state.page.kind !== "ready" || this.conversationId === null)
      return;
    const conversation = this.state.page.data.conversation;
    if (conversation === null || this.state.steeringQueuedId !== null) return;
    this.setState({ steeringQueuedId: inputId, error: null });
    try {
      const steered = await sendChat(this.props.organisationId, {
        kind: "steer_queued",
        conversationId: this.conversationId,
        inputId,
        cancellationId: crypto.randomUUID(),
        model: conversation.model,
      });
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.acceptConversation(steered);
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    } finally {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ steeringQueuedId: null });
    }
  }
  /** A stop and a steer settle in seconds, so Retry stop waits for a stuck one. */
  private watchStopRetry(): void {
    const work =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation?.work
        : undefined;
    const cancellation =
      work?.kind === "cancelling" ? work.cancellationId : null;
    if (cancellation === this.watchedCancellation) return;
    this.watchedCancellation = cancellation;
    if (this.stopRetryTimer !== null) window.clearTimeout(this.stopRetryTimer);
    this.stopRetryTimer =
      cancellation === null
        ? null
        : window.setTimeout(
            this.offerStopRetry.bind(this, cancellation),
            STOP_RETRY_AFTER_MS,
          );
  }
  private offerStopRetry(cancellation: string): void {
    this.stopRetryTimer = null;
    this.setState({ stopRetryDueFor: cancellation });
  }
  private async stop(): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.state.page.kind !== "ready" || this.conversationId === null)
      return;
    const conversation = this.state.page.data.conversation;
    if (
      conversation === null ||
      (conversation.work.kind !== "running" &&
        conversation.work.kind !== "cancelling")
    )
      return;
    const work = conversation.work;
    this.stopStream();
    this.setState({ sending: true, error: null });
    try {
      const stopped = await cancelChat(this.props.organisationId, {
        conversationId: conversation.id,
        requestId: work.requestId,
        sessionId: work.sessionId,
        turnId: work.turnId,
        cancellationId:
          work.kind === "cancelling"
            ? work.cancellationId
            : crypto.randomUUID(),
      });
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.acceptConversation(stopped);
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
        await this.refresh();
      }
    } finally {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  }
  private async steer(text: string): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.conversationId === null || this.state.page.kind !== "ready")
      return;
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null) return;
    const effort = selectedEffortFromState(
      this.state.selectedEffort,
      this.state.page.data,
    );
    const conversationId = this.conversationId;
    const ticket = this.submissions.begin(conversationId, "steer", text);
    if (ticket === null) return;
    try {
      if (
        this.pendingSteering === null ||
        this.pendingSteering.text !== text ||
        this.pendingSteering.model !== model ||
        this.pendingSteering.effort !== effort ||
        this.pendingSteering.files !== this.state.files
      ) {
        const capture = await this.captureBakeryContext();
        if (!this.mounted || selectionVersion !== this.selectionVersion) return;
        if (capture.kind === "failed") {
          this.setState({ error: capture.message });
          return;
        }
        this.pendingSteering = {
          inputId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          cancellationId: crypto.randomUUID(),
          model,
          text,
          effort,
          files: this.state.files,
          browserContext: capture.browserContext,
        };
      }
      const pending = this.pendingSteering;
      this.setState({ steering: true, error: null });
      await this.prepareComposerSubmission(text, selectionVersion);
      const conversation = await sendChat(
        this.props.organisationId,
        {
          kind: "steer",
          conversationId,
          requestId: pending.requestId,
          inputId: pending.inputId,
          cancellationId: pending.cancellationId,
          model: pending.model,
          text: pending.text,
          browserContext: pending.browserContext,
          effort: pending.effort,
        },
        pending.files,
      );
      this.clearSubmittedFiles(conversationId, pending.files);
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.pendingSteering = null;
        this.acceptConversation(conversation);
        this.draftDirty = false;
        this.setState(clearSubmittedDraft.bind(null, text));
      }
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion) {
        if (error instanceof ChatNotRunningError) {
          this.sendAfterFinishedTurn(text);
          return;
        }
        if (this.state.draft.trim() === text.trim()) this.draftDirty = true;
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
      }
    } finally {
      this.submissions.settle(ticket);
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ steering: false });
    }
  }
  private async attachBakeryFile(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    const surface = bakerySurfaceForOrganisation(this.props.organisationId);
    if (file === undefined || surface === null) return;
    const selectionVersion = this.selectionVersion;
    try {
      const attached = await surface.attachFile(file);
      if (!this.mounted || selectionVersion !== this.selectionVersion) return;
      const draft = `${this.state.draft}\nAttached Kitchen file: ${JSON.stringify(attached.name)}; SHA-256: ${attached.digest}; bytes: ${attached.bytes}. Prepare this file for review.`;
      if (draft.length > 8000)
        throw new Error("Shorten the message before attaching a file.");
      this.draftDirty = true;
      this.setState({ draft, error: null });
      this.scheduleDraftSave();
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(
            error,
            "Unable to attach the Kitchen file.",
          ),
        });
    }
  }
  private attachFiles(event: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    this.addFiles(files);
  }
  private addFiles(added: readonly File[]): void {
    if (added.length === 0 || !this.canAttachFiles()) return;
    const files = [...this.state.files, ...added];
    if (
      files.length > MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage ||
      files.some(invalidChatFile) ||
      files.reduce(totalFileBytes, 0) > MESSAGE_ATTACHMENT_POLICY.maxBatchBytes
    ) {
      this.setState({ error: chatAttachmentLimits() });
      return;
    }
    this.threadFiles.set(this.conversationId ?? "draft", files);
    this.setState({ files, error: null });
  }
  private canAttachFiles(): boolean {
    if (
      this.state.page.kind !== "ready" ||
      this.state.page.data.model.kind !== "ready" ||
      this.state.sending ||
      this.state.steering ||
      chatWorkIsRetryable(this.state.page.data.conversation?.work)
    )
      return false;
    const conversation = this.state.page.data.conversation;
    return (
      conversation?.lifecycle !== "archived" &&
      conversation?.sharing?.role !== "viewer" &&
      conversation?.work.kind !== "cancelling"
    );
  }
  private dragFiles(event: React.DragEvent<HTMLFormElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = this.canAttachFiles() ? "copy" : "none";
  }
  private dropFiles(event: React.DragEvent<HTMLFormElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    this.addFiles(Array.from(event.dataTransfer.files));
  }
  private pasteFiles(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    this.addFiles(files);
    if (event.clipboardData.getData("text/plain").length === 0)
      event.preventDefault();
  }
  private removeFile(file: File): void {
    const files = this.state.files.filter(keepSelectedFile.bind(null, file));
    this.threadFiles.set(this.conversationId ?? "draft", files);
    this.setState({ files });
  }
  private renderSelectedFile(file: File, index: number): React.ReactNode {
    return (
      <ChatSelectedFile
        key={index}
        file={file}
        disabled={this.state.sending || this.state.steering}
        onRemove={this.removeFile.bind(this, file)}
      />
    );
  }
  private clearSubmittedFiles(
    conversationId: ConversationId,
    files: readonly File[],
  ): void {
    if (this.threadFiles.get(conversationId) === files)
      this.threadFiles.delete(conversationId);
    if (
      this.mounted &&
      this.conversationId === conversationId &&
      this.state.files === files
    )
      this.setState({ files: [] });
  }
  private async prepareComposerSubmission(
    text: string,
    selectionVersion: number,
  ): Promise<void> {
    await this.flushDraftSave();
    if (!this.mounted || selectionVersion !== this.selectionVersion)
      throw new Error("The selected conversation changed.");
    if (
      this.state.page.kind === "ready" &&
      this.state.page.data.conversation !== null &&
      this.draftDirty
    )
      throw new Error("Your draft could not be saved. Try again.");
    // Navigation must not autosave accepted text back into the composer.
    if (this.state.draft.trim() === text.trim()) {
      this.cancelDraftSave();
      this.draftDirty = false;
    }
  }
  private renderQueued(
    canSteer: boolean,
    item: {
      readonly id: string;
      readonly text: string;
    },
  ): React.ReactNode {
    const steering = this.state.steeringQueuedId === item.id;
    return (
      <li key={item.id}>
        <CornerDownRight size={14} aria-hidden="true" />
        <p title={item.text}>{item.text}</p>
        {canSteer ? (
          <button
            type="button"
            className="chat-queue-steer"
            title="Send this message now, into the running response"
            aria-label={`Steer now: ${item.text.slice(0, 60)}`}
            disabled={this.state.steeringQueuedId !== null}
            onClick={this.steerQueued.bind(this, item.id)}
          >
            {steering ? (
              <LoaderCircle
                size={13}
                className="chat-queue-spinner"
                aria-hidden="true"
              />
            ) : (
              <ArrowUp size={13} aria-hidden="true" />
            )}
            Steer
          </button>
        ) : null}
        <button
          type="button"
          className="chat-queue-remove"
          title="Remove from the queue"
          aria-label={`Remove from the queue: ${item.text.slice(0, 60)}`}
          disabled={steering}
          onClick={this.removeQueued.bind(this, item.id)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </li>
    );
  }
  private async answerQuestion(
    eventId: string,
    title: string,
    answer: QuestionAnswer,
  ): Promise<QuestionSubmitResult> {
    const availability = this.questionAvailability(eventId);
    if (availability !== undefined)
      return { kind: "failed", message: availability.message };
    const text = questionAnswerText(answer);
    return this.send(`${title}\n\n${text}`, null);
  }
  private questionAvailability(
    eventId: string,
  ): QuestionAvailability | undefined {
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    if (
      conversation === null ||
      conversation.lifecycle === "archived" ||
      (conversation.sharing?.visibility === "shared" &&
        conversation.sharing.role === "viewer")
    )
      return { kind: "closed", message: "This conversation is read-only." };
    const selected = conversation.timeline.find(
      timelineEventHasId.bind(null, eventId),
    );
    if (
      conversation.lineage.kind === "fork" &&
      selected !== undefined &&
      selected.sequence <= conversation.lineage.throughSequence
    )
      return {
        kind: "closed",
        message: "Inherited question from the source chat.",
      };
    const latestMessage = latestConversationMessage(conversation.timeline);
    if (latestMessage?.eventId !== eventId)
      return {
        kind: "closed",
        message: "Continued below in the conversation.",
      };
    if (
      this.isWorking() ||
      this.state.page.kind !== "ready" ||
      this.state.page.data.model.kind !== "ready"
    )
      return {
        kind: "paused",
        message: "Wait until the assistant is ready to receive your answer.",
      };
    return undefined;
  }
  private async send(
    text: string,
    queuedId: string | null,
    goalTokenBudget: number | null = null,
  ): Promise<QuestionSubmitResult> {
    const selectionVersion = this.selectionVersion;
    if (
      text.trim().length === 0 ||
      this.submissions.sending(this.conversationId) ||
      this.state.sending ||
      this.state.page.kind !== "ready"
    ) {
      const message = "Wait for the current message to finish sending.";
      if (text.trim().length > 0) this.setState({ error: message });
      return { kind: "failed", message };
    }
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null)
      return {
        kind: "failed",
        message: "Connect an AI before sending your answer.",
      };
    const effort = selectedEffortFromState(
      this.state.selectedEffort,
      this.state.page.data,
    );
    const started = this.startConversation();
    const ticket = this.submissions.begin(started, "send", text);
    this.setState({ sending: true, error: null });
    try {
      // The thread shows the message before the context capture, the draft
      // save and the send finish; the composer shows it as sent.
      this.setState(
        { outgoing: { conversationId: started, text: text.trim() } },
        this.scrollToLatest.bind(this),
      );
      if (
        this.pending === null ||
        this.pending.text !== text.trim() ||
        this.pending.model !== model ||
        this.pending.effort !== effort ||
        this.pending.goalTokenBudget !== goalTokenBudget ||
        this.pending.files !== this.state.files
      ) {
        const capture = await this.captureBakeryContext();
        if (capture.kind === "failed") throw new Error(capture.message);
        if (!this.mounted || selectionVersion !== this.selectionVersion)
          return {
            kind: "failed",
            message: "The selected conversation changed.",
          };
        this.pending = {
          requestId: crypto.randomUUID(),
          model,
          text: text.trim(),
          effort,
          files: this.state.files,
          browserContext: capture.browserContext,
          goalTokenBudget,
        };
      }
      await this.prepareComposerSubmission(text, selectionVersion);
      const submittedFiles = this.pending.files;
      const conversationId = started;
      this.scrollToLatest();
      const conversation = await sendChat(
        this.props.organisationId,
        {
          kind: "message",
          conversationId,
          requestId: this.pending.requestId,
          model: this.pending.model,
          text: this.pending.text,
          browserContext: this.pending.browserContext,
          effort: this.pending.effort,
          ...(this.pending.goalTokenBudget === null
            ? {}
            : { goalTokenBudget: this.pending.goalTokenBudget }),
        },
        this.pending.files,
      );
      this.clearSubmittedFiles(conversationId, submittedFiles);
      if (!this.mounted || selectionVersion !== this.selectionVersion)
        return { kind: "accepted" };
      this.pending = null;
      if (queuedId !== null)
        this.setState(removeAcceptedQueue.bind(null, queuedId));
      this.acceptConversation(conversation);
      if (this.state.draft.trim() === text.trim()) this.draftDirty = false;
      this.setState(clearSubmittedDraft.bind(null, text));
      this.setState({ outgoing: null });
      return { kind: "accepted" };
    } catch (error) {
      const message = errorMessage(error, "Something went wrong. Try again.");
      if (this.mounted && selectionVersion === this.selectionVersion) {
        // A failed message goes back to the composer, unless the person
        // typed a new one while it was sending.
        if (this.state.draft.trim() === "") this.setState({ draft: text });
        if (this.state.draft.trim() === text.trim()) this.draftDirty = true;
        this.setState({ error: message, outgoing: null });
        await this.refresh();
      }
      return { kind: "failed", message };
    } finally {
      this.submissions.settle(ticket);
      if (this.mounted) this.setState(withoutOutgoing.bind(null, started));
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  }
  /** The selected conversation, or a new one for the first message of a new chat. */
  private startConversation(): ConversationId {
    if (this.conversationId !== null) return this.conversationId;
    this.conversationId = newConversationId();
    this.threadFiles.delete("draft");
    this.threadFiles.set(this.conversationId, this.state.files);
    this.updateLocation(false);
    return this.conversationId;
  }
  /** The sent message that this thread shows before the server accepts it. */
  private outgoingText(): string | null {
    const outgoing = this.state.outgoing;
    return outgoing !== null && outgoing.conversationId === this.conversationId
      ? outgoing.text
      : null;
  }
  private renderOutgoing(): React.ReactNode {
    const text = this.outgoingText();
    if (text === null) return null;
    return (
      <article
        className="chat-message chat-user"
        aria-label="You"
        data-outgoing="true"
      >
        <p>{text}</p>
      </article>
    );
  }
  /** "Do it here" on a side Case card: the brief is the next message. */
  private async sendSideCaseHere(card: ChatSideCaseView): Promise<void> {
    if (this.isArchived())
      throw new Error("Restore this chat to do the work here.");
    if (this.isWorking())
      throw new Error(
        "Wait for the current answer to finish, then choose Do it here.",
      );
    if (
      this.submissions.sending(this.conversationId) ||
      this.state.sending ||
      this.state.page.kind !== "ready" ||
      this.conversationId === null
    )
      throw new Error("Wait for the current message to finish sending.");
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null)
      throw new Error("Connect an AI before sending your answer.");
    const selectionVersion = this.selectionVersion;
    const ticket = this.submissions.begin(
      this.conversationId,
      "send",
      card.brief,
    );
    this.setState({ sending: true, error: null });
    try {
      // A proposal is a complete brief. Keep its retry payload independent of
      // the browser session, the current composer draft and selected files.
      const conversation = await sendChat(
        this.props.organisationId,
        {
          kind: "message",
          conversationId: this.conversationId,
          requestId: sideCaseHereRequestId(card.proposalId),
          model,
          effort: selectedEffortFromState(
            this.state.selectedEffort,
            this.state.page.data,
          ),
          text: card.brief,
          browserContext: { kind: "unavailable" },
        },
        [],
      );
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.acceptConversation(conversation);
        this.scrollToLatest();
      }
    } finally {
      this.submissions.settle(ticket);
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  }
  private acceptConversation(conversation: Chat): void {
    if (this.state.page.kind !== "ready") return;
    if (isOlderSnapshot(this.state.page.data.conversation, conversation))
      return;
    conversation = {
      ...conversation,
      sharing:
        conversation.sharing ??
        this.state.page.data.conversation?.sharing ??
        null,
    };
    this.setState({
      page: { kind: "ready", data: { ...this.state.page.data, conversation } },
      selectedModel: conversation.model,
      selectedEffort: selectedEffortFromConversation(
        conversation,
        this.state.page.data,
      ),
      queued: conversation.pendingInputs.map(toQueuedInput),
      stream: streamAfterConversationRefresh(
        conversation.work,
        this.state.stream,
      ),
    });
  }
  private syncStream(): void {
    if (this.state.page.kind !== "ready") return;
    const conversation = this.state.page.data.conversation;
    if (
      conversation === null ||
      conversation.work.kind === "ready" ||
      conversation.work.kind === "failed" ||
      // A run that waits for a person has no stream; the resume starts one.
      conversation.work.kind === "awaiting_permission"
    ) {
      this.stopStream();
      return;
    }
    const identity: DeliveryIdentity = {
      organisationId: this.props.organisationId,
      conversationId: conversation.id,
      requestId: conversation.work.requestId,
      generation: this.selectionVersion,
    };
    if (!this.delivery?.matches(identity)) {
      this.stopStream();
      this.delivery = new ChatDelivery(identity, conversation.revision, {
        changed: this.acceptDeliveryState.bind(this),
        refresh: this.refreshDelivery.bind(this),
        signalsLive: this.signalsLive.bind(this),
      });
    }
    this.delivery.observe(conversation.revision, conversation.work);
  }
  private signalsLive(): boolean {
    return this.signals?.live() === true;
  }
  private stopStream(): void {
    this.delivery?.dispose();
    this.delivery = null;
  }
  private acceptDeliveryState(
    identity: DeliveryIdentity,
    stream: ChatStreamState,
  ): void {
    if (this.mounted && this.delivery?.matches(identity))
      this.setState({ stream });
  }
  private async refreshDelivery(identity: DeliveryIdentity): Promise<void> {
    if (this.mounted && this.delivery?.matches(identity))
      await this.refresh("observe");
  }
  private readonly acceptPermissionDecision = (conversation: Chat): void => {
    if (!this.mounted) return;
    this.stopStream();
    this.setState(
      { stream: { kind: "idle" } },
      this.acceptConversation.bind(this, conversation),
    );
  };
  private async retry(): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.state.page.kind !== "ready" || this.state.sending) return;
    const conversation = this.state.page.data.conversation;
    if (conversation === null || !chatWorkIsRetryable(conversation.work))
      return;
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    if (model === null) return;
    const effort = selectedEffortFromState(
      this.state.selectedEffort,
      this.state.page.data,
    );
    this.setState({ sending: true, error: null });
    try {
      const result = await sendChat(this.props.organisationId, {
        kind: "retry",
        conversationId: conversation.id,
        requestId: conversation.work.requestId,
        model,
        effort,
      });
      if (this.mounted && selectionVersion === this.selectionVersion) {
        this.stopStream();
        this.setState(
          { stream: { kind: "idle" } },
          this.acceptConversation.bind(this, result),
        );
      }
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    } finally {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ sending: false });
    }
  }
  private updateLocation(includeSetup: boolean): void {
    const url = new URL(this.props.basePath, window.location.origin);
    if (this.conversationId !== null)
      url.searchParams.set("conversation", this.conversationId);
    if (includeSetup) {
      const current = new URLSearchParams(window.location.search);
      for (const name of ["customConnector", "setupAttempt"]) {
        const value = current.get(name);
        if (value !== null) url.searchParams.set(name, value);
      }
    }
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}`,
    );
    notifySurfaceListeners();
  }
  private async connect(
    message: Variant<ChatMessage, "connector">,
  ): Promise<void> {
    const selectionVersion = this.selectionVersion;
    if (this.state.savingCard !== null || this.state.page.kind !== "ready")
      return;
    this.setState({ savingCard: message.id, error: null });
    try {
      const latest = await readChat(
        this.props.organisationId,
        this.conversationId,
      );
      const path =
        message.target.kind === "new"
          ? customConnectorCollectionPath(this.props.organisationId)
          : `${customConnectorPath(this.props.organisationId, message.target.connectorId)}/revisions`;
      const body =
        message.target.kind === "new"
          ? { document: message.connector.document }
          : {
              document: message.connector.document,
              expectedHeadRevision: message.target.expectedHeadRevision,
            };
      const created = await mutateCustomConnector(
        path,
        "POST",
        body,
        latest.configurationVersion,
        `chat-${message.id}-create`,
      );
      const connectorId =
        message.target.kind === "revision"
          ? message.target.connectorId
          : created.connectorId;
      if (connectorId === null || created.revision === null)
        throw new Error("Could not open the saved connector.");
      const validated = await mutateCustomConnector(
        customConnectorRevisionPath(
          this.props.organisationId,
          connectorId,
          created.revision.revision,
          "validate",
        ),
        "POST",
        { authoringDigest: created.revision.authoringDigest },
        Math.max(created.configurationVersion, latest.configurationVersion),
        `chat-${message.id}-validate`,
      );
      if (!this.mounted || selectionVersion !== this.selectionVersion) return;
      const url = new URL(this.props.basePath, window.location.origin);
      if (this.conversationId !== null)
        url.searchParams.set("conversation", this.conversationId);
      url.searchParams.set("customConnector", connectorId);
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}`,
      );
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          setupOpen: true,
          page: {
            kind: "ready",
            data: {
              ...latest,
              configurationVersion: Math.max(
                validated.configurationVersion,
                latest.configurationVersion,
                created.configurationVersion,
              ),
            },
          },
        });
    } catch (error) {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    } finally {
      if (this.mounted && selectionVersion === this.selectionVersion)
        this.setState({ savingCard: null });
    }
  }
  private closeSetup(): void {
    this.setState({ setupOpen: false });
    this.updateLocation(false);
    void this.refresh();
  }
  private continueAfterSetup(): void {
    this.closeSetup();
    void this.send(
      "Check the current connector setup result. Explain any failure and help me continue, or tell me what I can do next if the connection is ready.",
      null,
    );
  }
  private chatBasePath(): string {
    if (this.conversationId === null) return this.props.basePath;
    return `${this.props.basePath}?conversation=${encodeURIComponent(this.conversationId)}`;
  }
  private async restoreConversation(
    conversation: Pick<ChatConversationSummary, "id" | "title" | "revision">,
    event: React.MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (this.state.metadataUpdate.kind === "updating") return;
    this.setState({
      metadataUpdate: {
        kind: "updating",
        conversationId: conversation.id,
      },
      error: null,
    });
    try {
      await updateChatConversation(this.props.organisationId, conversation.id, {
        kind: "restore",
        expectedRevision: conversation.revision,
      });
      if (!this.mounted) return;
      await this.refresh();
      if (this.mounted) this.setState({ metadataUpdate: { kind: "idle" } });
    } catch (error) {
      if (this.mounted)
        this.setState({
          metadataUpdate: { kind: "idle" },
          error: errorMessage(error, "Something went wrong. Try again."),
        });
    }
  }
  private renderMessage(message: ChatMessage): React.ReactNode {
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    const event = conversation?.timeline.find(
      timelineEventHasId.bind(null, message.id),
    );
    const inherited =
      conversation?.lineage.kind === "fork" &&
      event !== undefined &&
      event.sequence <= conversation.lineage.throughSequence;
    const sources = chatSourceParts(
      event?.kind === "assistant" ? (event.sources ?? []) : [],
    );
    if (message.kind === "activity")
      return (
        <p className="chat-activity" key={message.id}>
          {message.text}
        </p>
      );
    if (message.kind === "connector")
      return (
        <article className="chat-message chat-assistant" key={message.id}>
          <p>{message.text}</p>
          <section
            className="chat-connector-card"
            aria-label={`${message.connector.name} connector`}
          >
            <div className="chat-card-title">
              <Plug size={24} aria-hidden="true" />
              <div>
                <h3>{message.connector.name}</h3>
                <span>Custom connector</span>
              </div>
            </div>
            <p>{message.connector.description}</p>
            <span className="chat-destination">{message.connector.origin}</span>
            <ul aria-label="Proposed access">
              {message.connector.operations.map(renderOperation)}
            </ul>
            {message.connector.documentationUrls.length === 0 ? null : (
              <section aria-label="Sources">
                <h4>Sources</h4>
                <ul>{message.connector.documentationUrls.map(renderSource)}</ul>
              </section>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={inherited || conversation?.lifecycle === "archived"}
              aria-disabled={this.state.savingCard !== null}
              aria-busy={this.state.savingCard === message.id}
              onClick={this.connect.bind(this, message)}
            >
              {this.state.savingCard === message.id
                ? "Opening connector…"
                : message.target.kind === "revision"
                  ? "Review revision"
                  : "Connect"}
            </button>
            <small>
              <ShieldCheck size={14} aria-hidden="true" /> Your API key stays
              out of chat.
            </small>
          </section>
        </article>
      );
    return (
      <article
        key={message.id}
        id={`message-${message.id}`}
        tabIndex={-1}
        className={`chat-message chat-${message.kind}`}
        aria-label={message.kind === "user" ? "You" : "Assistant"}
      >
        {message.kind === "assistant" ? (
          <>
            <StreamingText text={withoutCommerceActionLinks(message.text)} trailing={sources.citations} />
            {sources.details}{chatCommerceActionCards(message.text, this.props.organisationId, this.props.canManage)}
            <div className="chat-message-actions">
              {this.renderResponseActions(message.id, message.text)}
              {this.renderMessageTime(message.id)}
              {this.usageForMessage(message.id) === null ? null : (
                <small
                  className="chat-usage"
                  title={formatUsage(this.usageForMessage(message.id))}
                >
                  {formatUsage(this.usageForMessage(message.id))}
                </small>
              )}
            </div>
          </>
        ) : (
          <>
            <p>
              {message.text}
              {event?.kind === "user" ? <UserMessageMarks event={event} /> : null}
            </p>
            {event?.kind === "user" ? (
              <ul
                className="chat-retained-files"
                aria-label="Message attachments"
              >
                {event.attachments.map(renderChatAttachmentPart)}
              </ul>
            ) : null}
            <div className="chat-message-actions">
              <ResponseActions text={message.text} subject="message" />
              {this.renderMessageTime(message.id)}
            </div>
          </>
        )}
      </article>
    );
  }
  private usageForMessage(messageId: string): ChatTurnUsage | null {
    if (
      this.state.page.kind !== "ready" ||
      this.state.page.data.conversation === null
    )
      return null;
    const event = this.state.page.data.conversation.timeline.find(
      timelineEventHasId.bind(null, messageId),
    );
    return event?.kind === "assistant" ? (event.usage ?? null) : null;
  }
  private renderMessageTime(messageId: string): React.ReactNode {
    if (this.state.page.kind !== "ready") return null;
    const event = this.state.page.data.conversation?.timeline.find(
      timelineEventHasId.bind(null, messageId),
    );
    if (event === undefined) return null;
    const date = new Date(event.createdAt);
    return (
      <time
        className="chat-message-time"
        dateTime={date.toISOString()}
        title={date.toLocaleString()}
      >
        {date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time>
    );
  }
  private renderResponseActions(
    eventId: string,
    text: string,
  ): React.ReactNode {
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    if (conversation === null) return null;
    const event = conversation.timeline.find(
      timelineEventHasId.bind(null, eventId),
    );
    const latest = latestConversationMessage(conversation.timeline);
    const inherited =
      conversation.lineage.kind === "fork" &&
      event !== undefined &&
      event.sequence <= conversation.lineage.throughSequence;
    const readOnly = conversation.lifecycle === "archived" || inherited;
    return (
      <div className="chat-response-actions">
        <ResponseActions
          key={eventId}
          text={text}
          rating={event?.kind === "assistant" ? (event.rating ?? null) : null}
          onRate={
            readOnly
              ? undefined
              : this.rateResponse.bind(this, conversation.id, eventId)
          }
          ratingDisabled={this.isWorking()}
          onRegenerate={
            readOnly || latest?.eventId !== eventId
              ? undefined
              : this.regenerateResponse.bind(this, conversation.id, eventId)
          }
          regenerateDisabled={
            this.isWorking() ||
            this.state.page.kind !== "ready" ||
            this.state.page.data.model.kind !== "ready"
          }
          onFork={this.requestFork.bind(this, conversation.id, eventId)}
          forkDisabled={!conversation.forkableResponseIds.includes(eventId)}
          forking={this.state.forking}
        />
        {inherited ? <small>Inherited history</small> : null}
      </div>
    );
  }
  private requestFork(sourceId: ConversationId, messageId: string): void {
    if (this.forkPending) return;
    this.setState({ forkConfirmation: { sourceId, messageId } });
  }
  private closeForkConfirmation(): void {
    this.setState({ forkConfirmation: null });
  }
  private confirmFork(): void {
    const target = this.state.forkConfirmation;
    if (target === null) return;
    this.setState(
      { forkConfirmation: null },
      this.forkResponse.bind(this, target.sourceId, target.messageId),
    );
  }
  private async forkResponse(
    sourceId: ConversationId,
    messageId: string,
  ): Promise<void> {
    if (this.forkPending) return;
    this.forkPending = true;
    const key = `pantry:chat-fork:${this.props.organisationId}:${sourceId}:${messageId}`;
    const operationId = localStorage.getItem(key) ?? crypto.randomUUID();
    localStorage.setItem(key, operationId);
    this.setState({ error: null, forking: true });
    try {
      await this.flushDraftSave();
      const destinationId = await forkChatThread(
        this.props.organisationId,
        sourceId,
        messageId,
        operationId,
      );
      if (this.mounted) await this.selectThread(destinationId, true);
      if (this.mounted && this.conversationId === destinationId) {
        localStorage.removeItem(key);
        this.setState(
          { threadsExpanded: true },
          this.revealSelectedFork.bind(this),
        );
        toast.success("Opened a new branch", {
          description:
            "This chat includes history through the selected response.",
        });
      }
    } catch (error) {
      if (this.mounted)
        this.setState({
          error: errorMessage(
            error,
            "Could not fork this response. Retry to recover the same chat.",
          ),
        });
    } finally {
      this.forkPending = false;
      if (this.mounted) this.setState({ forking: false });
    }
  }
  private revealSelectedFork(): void {
    this.layout.current
      ?.querySelector<HTMLAnchorElement>(
        '.chat-layout > .chat-thread-sidebar a[aria-current="page"]',
      )
      ?.scrollIntoView({ block: "nearest" });
    this.composer.current?.focus({ preventScroll: true });
  }
  private renderBranchNavigation(conversation: Chat): React.ReactNode {
    const derived =
      this.state.page.kind === "ready"
        ? this.state.page.data.derivedThreads
        : [];
    if (conversation.lineage.kind === "side_case")
      return this.renderSideCaseSource();
    if (conversation.lineage.kind === "original" && derived.length === 0)
      return null;
    return (
      <nav className="chat-branch-navigation" aria-label="Chat branches">
        {conversation.lineage.kind === "fork" ? (
          <div className="chat-branch-origin">
            <a
              href={`${this.props.basePath}?conversation=${encodeURIComponent(conversation.lineage.sourceConversationId)}#message-${encodeURIComponent(conversation.lineage.sourceMessageId)}`}
              onClick={this.openBranchPoint.bind(
                this,
                conversation.lineage.sourceConversationId,
                conversation.lineage.sourceMessageId,
              )}
            >
              <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>Continued from chat</span>
            </a>
          </div>
        ) : null}
        {derived.length > 0 ? (
          <ul>{derived.map(this.renderDerivedThread.bind(this))}</ul>
        ) : null}
      </nav>
    );
  }
  /** Where a side Case came from: a link while its reader can open it. */
  private renderSideCaseSource(): React.ReactNode {
    const source =
      this.state.page.kind === "ready"
        ? this.state.page.data.sideCaseSource
        : null;
    if (source === null) return null;
    return (
      <nav className="chat-branch-navigation" aria-label="Chat branches">
        <div className="chat-branch-origin">
          {source.kind === "available" ? (
            <a
              href={`${this.props.basePath}?conversation=${encodeURIComponent(source.conversationId)}`}
              onClick={this.openThread.bind(this, source.conversationId)}
            >
              <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>Proposed in {source.title}</span>
            </a>
          ) : (
            <span className="chat-branch-unavailable">
              <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>Proposed in a chat that you cannot open</span>
            </span>
          )}
        </div>
      </nav>
    );
  }
  private async openBranchPoint(
    sourceId: ConversationId,
    messageId: string,
    event: React.MouseEvent<HTMLAnchorElement>,
  ): Promise<void> {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    await this.selectThread(sourceId, true);
    const url = new URL(window.location.href);
    url.hash = `message-${messageId}`;
    window.history.replaceState(window.history.state, "", url);
    requestAnimationFrame(focusBranchPoint.bind(null, messageId));
  }
  private renderDerivedThread(
    thread: import("@purin-labs/control-api").ChatDerivedThread,
  ): React.ReactNode {
    return (
      <li key={thread.id}>
        <a
          href={`${this.props.basePath}?conversation=${encodeURIComponent(thread.id)}`}
          onClick={this.openThread.bind(this, thread.id)}
        >
          {thread.title}
        </a>
      </li>
    );
  }
  private async rateResponse(
    conversationId: ConversationId,
    eventId: string,
    rating: ResponseRating,
  ): Promise<ResponseActionResult> {
    if (this.isWorking())
      return {
        kind: "failed",
        message: "Wait for the current response to finish.",
      };
    try {
      await rateChatResponse(
        this.props.organisationId,
        conversationId,
        eventId,
        rating,
      );
      if (this.mounted && this.conversationId === conversationId)
        await this.refresh();
      return { kind: "accepted" };
    } catch (error) {
      return {
        kind: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Could not save feedback. Try again.",
      };
    }
  }
  private async regenerateResponse(
    conversationId: ConversationId,
    eventId: string,
  ): Promise<ResponseActionResult> {
    if (this.conversationId !== conversationId)
      return { kind: "failed", message: "This conversation has changed." };
    const availability = this.questionAvailability(eventId);
    if (availability !== undefined)
      return { kind: "failed", message: availability.message };
    return this.send(
      "Please revise your previous answer using the information already collected. Give me an alternative response without repeating any actions or changing external systems.",
      null,
    );
  }
  private isInheritedEvent(event: ChatTimelineView): boolean {
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    return (
      conversation?.lineage.kind === "fork" &&
      event.sequence <= conversation.lineage.throughSequence
    );
  }
  private renderTimelineEvent(event: ChatTimelineView): React.ReactNode {
    if (event.kind === "progress" || event.kind === "activity")
      return (
        <TraceCollapsible key={event.eventId}>
          <TraceCollapsibleTrigger>
            <TraceLine status="completed">
              <TraceIcon>
                <ListTodo />
              </TraceIcon>
              <TraceTitle>
                {event.kind === "progress"
                  ? "Progress update"
                  : "Activity update"}
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <p>{event.text}</p>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      );
    if (event.kind === "assistant")
      return (
        <React.Fragment key={event.eventId}>
          {event.question === undefined ? (
            this.renderMessage({
              kind: "assistant",
              id: event.eventId,
              text: event.text,
            })
          ) : (
            <div id={`message-${event.eventId}`} tabIndex={-1}>
              <QuestionCard
                question={{ id: event.eventId, ...event.question }}
                availability={this.questionAvailability(event.eventId)}
                onSubmit={this.answerQuestion.bind(
                  this,
                  event.eventId,
                  event.question.title,
                )}
              />
              {this.renderResponseActions(event.eventId, event.text)}
            </div>
          )}
          {event.question === undefined ||
          event.sources === undefined ||
          event.sources.length === 0 ? null : (
            <ChatSources sources={event.sources} />
          )}
        </React.Fragment>
      );
    if (
      event.kind === "user" ||
      event.kind === "context" ||
      event.kind === "run_failed" ||
      event.kind === "run_cancelled"
    )
      return this.renderMessage({
        kind:
          event.kind === "context" ||
          event.kind === "run_failed" ||
          event.kind === "run_cancelled"
            ? "activity"
            : event.kind,
        id: event.eventId,
        text: event.text,
      });
    if (event.kind === "connector")
      return this.renderMessage({
        kind: "connector",
        id: event.eventId,
        text: event.text,
        connector: event.connector,
        target: event.target,
      });
    if (event.kind === "approval")
      return (
        <ChatApprovalTrace
          key={event.eventId}
          approval={event.approval}
          inherited={this.isInheritedEvent(event)}
        />
      );
    if (event.kind === "receipt")
      return <ChatReceiptTrace key={event.eventId} receipt={event.receipt} />;
    return null;
  }
  private openNewChat(event: React.MouseEvent<HTMLAnchorElement>): void {
    this.openThread(null, event);
  }
  private openThread(
    id: ConversationId | null,
    event: React.MouseEvent<HTMLAnchorElement>,
  ): void {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    void this.selectThread(id, true);
  }
  private restoreLocation(): void {
    void this.selectThread(initialConversationId(), false);
  }
  /** The read starts when the pointer rests on a row, before the click. */
  private previewThread(id: ConversationId): void {
    this.endThreadPreviewWait();
    if (
      id === this.conversationId ||
      (this.threadPreview?.id === id &&
        threadPreviewIsFresh(this.threadPreview))
    )
      return;
    this.threadPreviewTimer = window.setTimeout(
      this.startThreadPreview.bind(this, id),
      THREAD_PREVIEW_REST_MS,
    );
  }
  private endThreadPreviewWait(): void {
    if (this.threadPreviewTimer !== null)
      window.clearTimeout(this.threadPreviewTimer);
    this.threadPreviewTimer = null;
  }
  private startThreadPreview(id: ConversationId): void {
    this.threadPreviewTimer = null;
    const preview: ThreadPreview = {
      id,
      finishedAt: null,
      read: readChat(this.props.organisationId, id, "", "observe")
        .catch(readNoThreadPreview)
        .finally(() => {
          preview.finishedAt = Date.now();
        }),
    };
    this.threadPreview = preview;
  }
  /** Null when the click must read: an old answer, or a chat with open work. */
  private takeThreadPreview(
    id: ConversationId | null,
  ): Promise<ChatPageData | null> {
    this.endThreadPreviewWait();
    const preview = this.threadPreview;
    this.threadPreview = null;
    if (preview?.id !== id || !threadPreviewIsFresh(preview))
      return Promise.resolve(null);
    return preview.read.then(previewOfReadyThread);
  }
  private organizerChanged(): Promise<void> {
    this.threadPreview = null;
    return this.refresh();
  }
  private async selectThread(
    id: ConversationId | null,
    pushHistory: boolean,
  ): Promise<void> {
    // A second click on the row that is opening must not restart its read.
    if (id !== null && id === this.state.openingConversationId) return;
    this.setState({ selectedProject: null, openingConversationId: null });
    const navigationVersion = ++this.navigationVersion;
    if (id === this.conversationId) {
      this.closeHistory();
      this.composer.current?.focus();
      return;
    }
    this.setState({ openingConversationId: id, error: null });
    // The chat view changes at the click. The read can wait for a cold Actor.
    if (id !== null) this.closeHistory();
    const scrollTop = this.transcript.current?.scrollPosition();
    if (this.conversationId !== null && scrollTop !== undefined)
      this.threadScrollPositions.set(this.conversationId, scrollTop);
    try {
      const preview = this.takeThreadPreview(id);
      await this.flushDraftSave();
      const data =
        (await preview) ?? (await readChat(this.props.organisationId, id));
      if (!this.mounted || navigationVersion !== this.navigationVersion) return;
      this.selectionVersion++;
      this.observedReadSequence = 0;
      this.directorySearchVersion++;
      this.stopStream();
      this.cancelDraftSave();
      this.cancelDirectorySearch();
      // A draft that could not be saved must not hold the person in this chat.
      // Its text waits here and returns when they open this chat again.
      if (this.draftDirty && this.conversationId !== null)
        this.threadDrafts.set(this.conversationId, this.state.draft);
      const keptDraft = id === null ? undefined : this.threadDrafts.get(id);
      if (id !== null) this.threadDrafts.delete(id);
      this.draftDirty = keptDraft !== undefined;
      this.loading = false;
      this.conversationId = id;
      this.setState({ files: this.threadFiles.get(id ?? "draft") ?? [] });
      this.pending = null;
      this.pendingQueueAdmission = null;
      this.pendingSteering = null;
      if (pushHistory) {
        window.history.pushState(window.history.state, "", this.chatBasePath());
      }
      notifySurfaceListeners();
      this.setState({
        page: { kind: "ready", data },
        selectedModel: selectedModelFromData(data),
        selectedEffort: selectedEffortFromData(data),
        draft: keptDraft ?? data.conversation?.draft.text ?? "",
        queued: data.conversation?.pendingInputs.map(toQueuedInput) ?? [],
        sending: false,
        steering: false,
        steeringQueuedId: null,
        error: null,
        setupOpen: false,
        savingCard: null,
        stream: { kind: "idle" },
        metadataUpdate: { kind: "idle" },
        threadQuery: "",
        history: this.state.history === "closed" ? "closed" : "closing",
        openingConversationId: null,
      });
    } catch (error) {
      if (this.mounted && navigationVersion === this.navigationVersion)
        this.setState({
          error: errorMessage(error, "Something went wrong. Try again."),
          openingConversationId: null,
        });
    }
  }
  private openHistory(): void {
    this.setState({ history: "open" });
  }
  private closeHistory(): void {
    if (this.state.history !== "open") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.setState({ history: "closed" });
      return;
    }
    this.setState({ history: "closing" });
  }
  private finishHistoryClose(
    event: React.TransitionEvent<HTMLDialogElement>,
  ): void {
    if (
      event.target === event.currentTarget &&
      event.propertyName === "opacity" &&
      this.state.history === "closing"
    ) {
      this.setState({ history: "closed" });
    }
  }

  private dismissHistoryBackdrop(
    event: React.MouseEvent<HTMLDialogElement>,
  ): void {
    if (isBackdropClick(event)) this.closeHistory();
  }

  private toggleThreads(): void {
    this.setState(
      { threadsExpanded: !this.state.threadsExpanded },
      this.focusThreadsToggle.bind(this),
    );
  }
  private focusThreadsToggle(): void {
    const panel = this.state.threadsExpanded
      ? ".chat-thread-sidebar"
      : ".chat-main-panel";
    this.layout.current
      ?.querySelector<HTMLButtonElement>(`${panel} .dashboard-sidebar-toggle`)
      ?.focus({ preventScroll: true });
  }

  // Fullscreen chat opens with the thread list showing.
  private expandThreads(): void {
    this.setState({ threadsExpanded: true });
  }

  private resizeThreads(event: React.PointerEvent<HTMLDivElement>): void {
    const resize = this.threadsResize;
    if (
      resize === null ||
      resize.pointerId !== event.pointerId ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    resize.moved = true;
    resize.width = clampThreadsWidth(
      threadsWidthFromPointer(resize, event.clientX),
    );
    this.layout.current?.style.setProperty(
      "--chat-threads-width",
      `${resize.width}px`,
    );
    event.currentTarget.setAttribute("aria-valuenow", String(resize.width));
  }

  private startThreadsResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const sidebar = event.currentTarget.closest(".chat-thread-sidebar");
    if (sidebar === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.flushThreadsWidth();
    event.currentTarget.focus();
    const bounds = sidebar.getBoundingClientRect();
    this.layout.current?.setAttribute("data-threads-resizing", "true");
    this.threadsResize = {
      pointerId: event.pointerId,
      anchor: bounds.left,
      width: bounds.width,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  private finishThreadsResize(event: React.PointerEvent<HTMLDivElement>): void {
    const resize = this.threadsResize;
    if (resize === null || resize.pointerId !== event.pointerId) return;
    this.releaseThreadsResize();
    if (event.type === "pointerup" && resize.moved) {
      this.setState({ threadsWidth: resize.width });
      this.saveThreadsWidth(resize.width);
    } else {
      this.restoreThreadsWidth();
    }
  }

  private releaseThreadsResize(): void {
    const resize = this.threadsResize;
    if (resize === null) return;
    this.threadsResize = null;
    this.layout.current?.removeAttribute("data-threads-resizing");
    const handle = this.layout.current?.querySelector<HTMLDivElement>(
      ".chat-threads-resize",
    );
    if (handle?.hasPointerCapture(resize.pointerId)) {
      handle.releasePointerCapture(resize.pointerId);
    }
  }

  private restoreThreadsWidth(): void {
    this.layout.current?.style.setProperty(
      "--chat-threads-width",
      `${this.state.threadsWidth}px`,
    );
    this.layout.current
      ?.querySelector<HTMLDivElement>(".chat-threads-resize")
      ?.setAttribute("aria-valuenow", String(this.state.threadsWidth));
    this.syncChatPreferences();
  }

  private cancelThreadsResize(): void {
    if (this.threadsResize === null) return;
    const handle = this.layout.current?.querySelector<HTMLDivElement>(
      ".chat-threads-resize",
    );
    this.releaseThreadsResize();
    this.restoreThreadsWidth();
    if (handle?.getClientRects().length === 0) {
      this.composer.current?.focus({ preventScroll: true });
    }
  }

  private currentThreadsWidth(): number {
    return this.threadsResize?.width ?? this.state.threadsWidth;
  }

  private resizeThreadsWithKeyboard(
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void {
    const sidebar = event.currentTarget.closest(".chat-thread-sidebar");
    let width =
      this.sidebarSaveTimer === null
        ? (sidebar?.getBoundingClientRect().width ?? this.currentThreadsWidth())
        : this.currentThreadsWidth();
    switch (event.key) {
      case "ArrowLeft":
        width -= 20;
        break;
      case "ArrowRight":
        width += 20;
        break;
      case "Home":
        width = 200;
        break;
      case "End":
        width = 500;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.cancelThreadsResize();
    this.setState({ threadsWidth: clampThreadsWidth(width) });
    if (this.sidebarSaveTimer !== null) clearTimeout(this.sidebarSaveTimer);
    this.sidebarSaveTimer = setTimeout(this.flushThreadsWidth.bind(this), 250);
  }

  private syncChatPreferences(): void {
    if (this.threadsResize !== null || this.sidebarSaveTimer !== null) return;
    const document = this.props.preferences?.document("chat");
    if (
      document?.area === "chat" &&
      document.values.fullscreenSidebarWidthPx !== this.state.threadsWidth
    ) {
      this.setState({ threadsWidth: document.values.fullscreenSidebarWidthPx });
    }
  }
  private saveThreadsWidth(width: number): void {
    this.props.preferences?.edit({
      area: "chat",
      command: {
        kind: "set_fullscreen_chat_sidebar_width",
        widthPx: Math.round(clampThreadsWidth(width)),
      },
    });
  }
  private flushThreadsWidth(): void {
    if (this.sidebarSaveTimer === null) return;
    clearTimeout(this.sidebarSaveTimer);
    this.sidebarSaveTimer = null;
    this.saveThreadsWidth(this.state.threadsWidth);
  }
  private chooseProject(project: Project): void {
    this.setState({ selectedProject: project });
  }
  private async organizerSelect(
    conversationId: ConversationId | null,
  ): Promise<void> {
    await this.selectThread(conversationId, true);
  }
  private async organizerRemoved(
    conversationId: ConversationId,
  ): Promise<void> {
    if (this.conversationId === conversationId)
      await this.selectThread(null, true);
  }
  private renderProjectOverview(): React.ReactNode {
    if (this.state.page.kind !== "ready" || this.state.selectedProject === null)
      return null;
    const project = this.state.page.data.projectDirectory.projects.find(
      projectHasId.bind(null, this.state.selectedProject.id),
    );
    if (project === undefined) return null;
    const conversations = this.state.page.data.conversations.filter(
      chatInProject.bind(null, project.id),
    );
    const directory = this.state.page.data.projectDirectory;
    const isDefault = directory.defaultProjectId === project.id;
    return (
      <section className="project-overview" aria-label={project.name}>
        <header className="project-overview-heading">
          <div>
            <span className="project-overview-label">
              <Folder size={16} aria-hidden="true" />
              {isDefault ? "Default project" : "Project"}
            </span>
            <h2>{project.name}</h2>
          </div>
          {!isDefault &&
          project.access.kind === "shared" &&
          project.access.role === "owner" ? (
            <button
              type="button"
              title="New work that names no project will be filed here. Work already filed stays where it is."
              onClick={this.makeDefault.bind(this, project.id)}
            >
              Make default
            </button>
          ) : null}
          <button
            className="primary-button"
            type="button"
            aria-label={`New chat in ${project.name}`}
            onClick={this.startProjectChat.bind(this, project.id)}
          >
            <Plus size={16} aria-hidden="true" /> New chat
          </button>
        </header>
        {this.state.error === null ? null : (
          <p role="alert">{this.state.error}</p>
        )}
        <section
          className="project-overview-section"
          aria-label="Project brief"
        >
          <h3>Brief</h3>
          <p>
            {project.brief.length === 0
              ? "Add a brief to give these chats shared working context."
              : project.brief}
          </p>
        </section>
        <section
          className="project-overview-section"
          aria-label="Project references"
        >
          <h3>References</h3>
          {project.references.length === 0 ? (
            <p className="project-overview-empty">
              No references added. Use Edit project in the sidebar to link saved
              runs or workspace records.
            </p>
          ) : (
            <ul className="project-overview-references">
              {project.references.map(renderProjectReference)}
            </ul>
          )}
        </section>
        <section
          className="project-overview-section"
          aria-label="Project chats"
        >
          <h3>Chats</h3>
          {conversations.length === 0 ? (
            <p className="project-overview-empty">
              Start a chat to work with this project’s brief and references.
            </p>
          ) : (
            <ul className="project-overview-list">
              {conversations.map(this.renderProjectChatLink.bind(this))}
            </ul>
          )}
        </section>
        <ProjectCases
          organisationId={this.props.organisationId}
          project={project}
          projects={directory.projects}
          defaultProjectId={directory.defaultProjectId}
          observation={this.state.observationVersion}
          onChanged={this.refresh.bind(this)}
        />
      </section>
    );
  }
  private async makeDefault(projectId: ProjectId): Promise<void> {
    try {
      await makeDefaultProject(this.props.organisationId, projectId);
      await this.refresh();
    } catch (error) {
      this.setState({
        error: errorMessage(error, "Could not change the default project."),
      });
    }
  }
  private renderProjectChatLink(
    conversation: ChatConversationSummary,
  ): React.ReactNode {
    return (
      <li key={conversation.id}>
        <a
          href={`${this.props.basePath}?conversation=${encodeURIComponent(conversation.id)}`}
          onClick={this.openThread.bind(this, conversation.id)}
        >
          <MessageSquare size={16} aria-hidden="true" />
          <span>{conversation.title}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </a>
      </li>
    );
  }
  private async startProjectChat(projectId: ProjectId): Promise<void> {
    try {
      const conversationId = await createProjectChat(
        this.props.organisationId,
        projectId,
        newConversationId(),
      );
      await this.organizerSelect(conversationId);
    } catch (error) {
      this.setState({
        error: errorMessage(error, "Could not start this project chat."),
      });
    }
  }

  private renderThreadSidebar(history: boolean): React.ReactNode {
    const expanded = history || this.state.threadsExpanded;
    const inactive = !expanded || (!history && this.state.history !== "closed");
    return (
      <aside
        id={history ? "chat-history-threads" : "chat-threads"}
        className="chat-thread-sidebar"
        aria-label="Threads"
        data-expanded={expanded}
        aria-hidden={inactive}
        inert={inactive}
      >
        {history ? null : (
          <header className="chat-underlay-header chat-sidebar-header">
            {this.renderChatIdentity()}
          </header>
        )}
        <div
          id={history ? "chat-history-threads-content" : "chat-threads-content"}
          className="chat-threads-content"
          inert={!expanded}
          aria-hidden={!expanded}
        >
          <div
            className="chat-threads-resize"
            data-resize-handle
            role="separator"
            aria-label="Resize threads sidebar"
            aria-orientation="vertical"
            aria-valuemin={200}
            aria-valuemax={500}
            aria-valuenow={this.currentThreadsWidth()}
            tabIndex={0}
            onPointerDown={this.startThreadsResize.bind(this)}
            onPointerMove={this.resizeThreads.bind(this)}
            onPointerUp={this.finishThreadsResize.bind(this)}
            onPointerCancel={this.finishThreadsResize.bind(this)}
            onLostPointerCapture={this.finishThreadsResize.bind(this)}
            onKeyDown={this.resizeThreadsWithKeyboard.bind(this)}
            onBlur={this.flushThreadsWidth.bind(this)}
          />
          <div className="chat-library-search-actions">
            <label className="chat-thread-search">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search chats</span>
              <input
                type="search"
                value={this.state.threadQuery}
                onChange={this.changeThreadQuery.bind(this)}
                placeholder="Search chats"
                maxLength={120}
              />
            </label>
            <a
              className="chat-new"
              aria-label="New chat"
              title="New chat"
              href={this.props.basePath}
              onClick={this.openNewChat.bind(this)}
            >
              <Plus size={17} aria-hidden="true" />
              <span>New chat</span>
            </a>
          </div>
          {this.state.page.kind === "ready" ? (
            <ChatOrganizer
              surface={history ? "history" : "sidebar"}
              organisationId={this.props.organisationId}
              query={this.state.threadQuery}
              data={this.state.page.data}
              basePath={this.props.basePath}
              selectedId={this.conversationId}
              openingId={this.state.openingConversationId}
              onSelect={this.organizerSelect.bind(this)}
              onPreview={this.previewThread.bind(this)}
              onPreviewEnd={this.endThreadPreviewWait.bind(this)}
              onChanged={this.organizerChanged.bind(this)}
              onRemoved={this.organizerRemoved.bind(this)}
              onProject={this.chooseProject.bind(this)}
            />
          ) : null}
        </div>
      </aside>
    );
  }
  private chooseModel(
    model: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ): void {
    if (
      this.isWorking() ||
      this.isArchived() ||
      this.state.page.kind !== "ready" ||
      this.state.page.data.model.kind !== "ready" ||
      !this.state.page.data.model.options.some(
        modelOptionHasId.bind(null, model),
      )
    )
      return;
    const option = this.state.page.data.model.options.find(
      modelOptionHasId.bind(null, model),
    );
    if (option === undefined) return;
    event.currentTarget.closest("details")?.removeAttribute("open");
    this.pending = null;
    this.setState({
      selectedModel: model,
      selectedEffort: chooseSupportedEffort(
        this.state.selectedEffort,
        option.capabilities.effortOptions,
      ),
      error: null,
    });
  }
  private chooseEffort(
    effort: ChatEffort,
    event: React.MouseEvent<HTMLButtonElement>,
  ): void {
    if (
      this.isWorking() ||
      this.isArchived() ||
      this.state.page.kind !== "ready" ||
      this.state.page.data.model.kind !== "ready"
    )
      return;
    const model = selectedModelFromState(
      this.state.selectedModel,
      this.state.page.data,
    );
    const option = this.state.page.data.model.options.find(
      modelOptionHasId.bind(null, model ?? ""),
    );
    if (
      option === undefined ||
      !option.capabilities.effortOptions.includes(effort)
    )
      return;
    event.currentTarget.closest("details")?.removeAttribute("open");
    this.pending = null;
    this.setState({ selectedEffort: effort, error: null });
  }
  private renderModelOption(option: ChatModelOption): React.ReactNode {
    if (this.state.page.kind !== "ready") return null;
    const selected =
      selectedModelFromState(this.state.selectedModel, this.state.page.data) ===
      option.id;
    return (
      <button
        key={option.id}
        type="button"
        className="chat-model-option"
        data-selected={selected ? "true" : "false"}
        aria-pressed={selected}
        disabled={this.isWorking() || this.isArchived()}
        onClick={this.chooseModel.bind(this, option.id)}
      >
        <span>
          {option.name}
          <small>{option.description}</small>
        </span>
        {selected ? <Check size={17} aria-hidden="true" /> : null}
      </button>
    );
  }
  /** The directory already holds the title of the chat that is opening. */
  private openingTitle(): string | null {
    const id = this.state.openingConversationId;
    if (id === null || this.state.page.kind !== "ready") return null;
    const data = this.state.page.data;
    return (
      [...data.conversations, ...data.archivedConversations].find(
        summaryHasConversationId.bind(null, id),
      )?.title ?? null
    );
  }
  private renderChatIdentity(): React.ReactNode {
    const agent =
      this.state.page.kind === "ready" &&
      this.state.page.data.model.kind === "ready"
        ? this.state.page.data.model.agent
        : "AI assistant";
    const conversation =
      this.state.page.kind === "ready"
        ? this.state.page.data.conversation
        : null;
    return (
      <>
        <div className="chat-underlay-heading">
          <h2>
            <ThreadTitle title={this.openingTitle() ?? conversation?.title ?? agent} />
          </h2>
          <div className="chat-underlay-sidebar-controls">
            <button
              type="button"
              className="dashboard-sidebar-toggle"
              aria-label={
                this.state.threadsExpanded
                  ? "Collapse threads"
                  : "Expand threads"
              }
              aria-expanded={this.state.threadsExpanded}
              aria-controls="chat-threads-content"
              onClick={this.toggleThreads.bind(this)}
            >
              <DashboardSidebarToggleIcon
                expanded={this.state.threadsExpanded}
              />
            </button>
          </div>
        </div>
        <div className="chat-context-workspace">
          <ChatContextChip
            organisationId={this.props.organisationId}
            context={this.props.context}
            projects={
              this.state.page.kind === "ready"
                ? this.state.page.data.projectDirectory
                : null
            }
            conversation={
              this.state.page.kind === "ready"
                ? this.state.page.data.conversation
                : null
            }
          />
        </div>
      </>
    );
  }
  render(): React.ReactNode {
    const sidebarVisible =
      this.context?.fullscreen === true && this.state.threadsExpanded;
    return (
      <>
        <div
          ref={this.layout}
          className="chat-layout"
          style={threadSidebarStyle(this.currentThreadsWidth())}
          data-threads-expanded={sidebarVisible}
        >
          {this.context?.fullscreen === true
            ? this.renderThreadSidebar(false)
            : null}
          <div className="chat-main-panel">
            <header className="chat-underlay-header">
              <div
                className="chat-main-identity"
                aria-hidden={sidebarVisible}
                inert={sidebarVisible}
              >
                {this.renderChatIdentity()}
              </div>
              <div className="chat-header-actions">
                <VoiceHeaderMark session={this.voice} />
                <a
                  className="chat-underlay-close"
                  aria-label="New chat"
                  title="New chat"
                  href={this.props.basePath}
                  onClick={this.openNewChat.bind(this)}
                >
                  <SquarePen size={18} aria-hidden="true" />
                </a>
                <ChatFullscreenButton onEnter={this.expandThreads.bind(this)} />
                <button
                  type="button"
                  className="chat-underlay-close"
                  aria-label="Open history"
                  title="Open history"
                  aria-haspopup="dialog"
                  aria-controls="chat-history"
                  onClick={this.openHistory.bind(this)}
                >
                  <History size={18} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="chat-underlay-close"
                  aria-label="Close chat"
                  onClick={this.props.close}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            </header>
            {this.renderChatContent()}
          </div>
        </div>
        <dialog
          ref={this.forkDialog}
          className="access35-dialog chat-fork-dialog"
          aria-labelledby="chat-fork-title"
          onCancel={cancelDialog.bind(
            null,
            this.closeForkConfirmation.bind(this),
          )}
        >
          <DialogHeading
            id="chat-fork-title"
            title="Branch in new chat"
            close={this.closeForkConfirmation.bind(this)}
          />
          <button
            type="button"
            className="chat-fork-choice"
            aria-labelledby="chat-fork-choice-title"
            aria-describedby="chat-fork-description"
            onClick={this.confirmFork.bind(this)}
          >
            <Split
              size={20}
              className="response-fork-icon"
              aria-hidden="true"
            />
            <span>
              <strong id="chat-fork-choice-title">In this workspace</strong>
              <span id="chat-fork-description">
                A new chat with the history up to this response.
              </span>
            </span>
          </button>
        </dialog>
        <dialog
          id="chat-history"
          className="chat-history-dialog"
          data-state={this.state.history}
          onClick={this.dismissHistoryBackdrop.bind(this)}
          onTransitionEnd={this.finishHistoryClose.bind(this)}
          aria-labelledby="chat-history-title"
          ref={this.historyDialog}
          onCancel={cancelDialog.bind(null, this.closeHistory.bind(this))}
        >
          <DialogHeading
            id="chat-history-title"
            title="Chat history"
            close={this.closeHistory.bind(this)}
          />
          {this.state.history !== "closed"
            ? this.renderThreadSidebar(true)
            : null}
          {this.state.page.kind === "loading" ? (
            <p role="status">Loading history…</p>
          ) : null}
          {this.state.page.kind === "failed" ? (
            <p role="alert">{this.state.page.message}</p>
          ) : null}
          {this.state.error ? <p role="alert">{this.state.error}</p> : null}
        </dialog>
      </>
    );
  }

  private renderChatContent(): React.ReactNode {
    return this.renderConversationPage();
  }
  private renderConversationPage(): React.ReactNode {
    if (!this.props.canManage)
      return (
        <p className="chat-panel-status">
          A workspace admin can use chat to connect apps.
        </p>
      );
    if (this.state.page.kind === "loading")
      return (
        <p className="chat-panel-status" role="status">
          Opening chat…
        </p>
      );
    if (this.state.page.kind === "failed")
      return (
        <div className="chat-load-error">
          <span className="chat-load-error-icon" aria-hidden="true">
            <MessageSquareWarning size={24} strokeWidth={1.5} />
          </span>
          <p role="alert">{this.state.page.message}</p>
          <button
            type="button"
            className="chat-load-error-retry"
            onClick={this.retryLoad.bind(this)}
          >
            Retry opening chat
          </button>
        </div>
      );
    const data = this.state.page.data;
    const conversation = data.conversation;
    const archived = conversation?.lifecycle === "archived";
    const readOnly =
      conversation?.sharing?.visibility === "shared" &&
      conversation.sharing.role === "viewer";
    const active =
      !readOnly && (this.state.sending || chatWorkIsActive(conversation?.work));
    const opening = this.state.openingConversationId !== null;
    const inputBlocked =
      opening ||
      readOnly ||
      conversation?.work.kind === "cancelling";
    const needsRetry = !readOnly && chatWorkIsRetryable(conversation?.work);
    const cancelling = conversation?.work.kind === "cancelling";
    const retryStop =
      conversation?.work.kind === "cancelling" &&
      conversation.work.cancellationId === this.state.stopRetryDueFor;
    const stopping =
      (active && conversation?.work.kind === "running") || cancelling;
    const selectedModel = selectedModelFromState(
      this.state.selectedModel,
      data,
    );
    const selectedModelName = modelName(data, selectedModel);
    const selectedEffort = selectedEffortFromState(
      this.state.selectedEffort,
      data,
    );
    const selectedModelOption =
      data.model.kind === "ready"
        ? data.model.options.find(
            modelOptionHasId.bind(null, selectedModel ?? ""),
          )
        : undefined;
    return (
      <>
        {this.state.selectedProject === null ? (
          <section className="chat-thread" aria-label="AI conversation">
            {opening ||
            conversation?.sharing?.visibility !== "shared" ? null : (
              <div className="chat-visibility" role="status">
                Shared with project
                {readOnly
                  ? " · View only — start a private chat to work with this context"
                  : ""}
              </div>
            )}
            {opening ? (
              <p className="chat-panel-status" role="status">
                Opening chat…
              </p>
            ) : (
              <MessageScroller
                key={conversation?.id ?? "new"}
                ref={this.transcript}
                className="chat-scroller"
                contentClassName="chat-transcript"
                label="Messages"
                initialScrollTop={
                  conversation === null
                    ? undefined
                    : this.threadScrollPositions.get(conversation.id)
                }
                onEndReached={this.markConversationRead.bind(this)}
              >
                {data.model.kind === "unavailable" ? (
                  // A new chat cannot start, so the setup card takes the place
                  // of the starter prompts.
                  <EmptyState
                    className={
                      conversation === null
                        ? "chat-empty chat-model-gate"
                        : "chat-model-gate"
                    }
                    icon={<Plug size={18} />}
                    title="Set up workspace chat"
                    description={data.model.message}
                    actions={
                      <a
                        className="primary-button button-link"
                        href={this.props.integrationsPath}
                      >
                        Open integrations
                      </a>
                    }
                  />
                ) : null}
                {conversation === null ? (
                  data.model.kind === "unavailable" ||
                  this.outgoingText() !== null ? null : (
                    <EmptyState
                      className="chat-empty"
                      title="What would you like to do?"
                      description="Describe what you need. I’ll help find the API, set up a secure connection, and use it with you."
                      actions={
                        <>
                          <button
                            type="button"
                            onClick={this.choosePrompt.bind(
                              this,
                              "Connect an app",
                            )}
                          >
                            Connect an app
                          </button>
                          <button
                            type="button"
                            onClick={this.choosePrompt.bind(
                              this,
                              "Connect EasyPost so I can see my latest shipments",
                            )}
                          >
                            See my latest shipments
                          </button>
                        </>
                      }
                    />
                  )
                ) : (
                  <VoiceApprovalContext.Provider
                    value={{
                      session: this.voice,
                      conversationId: conversation.id,
                    }}
                  >
                    {this.renderBranchNavigation(conversation)}
                    {renderChatTimeline(
                      conversation.timeline,
                      conversation.work,
                      this.renderTimelineEvent.bind(this),
                      [
                        ...emailDraftInserts(data.emailReview, {
                          actions: createEmailReviewActions(
                            this.props.organisationId,
                          ),
                          canManage:
                            this.props.canManage &&
                            conversation.sharing?.role !== "viewer",
                          onChanged: this.refresh.bind(this),
                          sourceLinks: this.props.sourceLinks ?? null,
                        }),
                        ...slackDraftInserts(data.slackDrafts, {
                          actions: createSlackDraftActions(
                            this.props.organisationId,
                            conversation.id,
                          ),
                          canManage:
                            this.props.canManage &&
                            conversation.sharing?.role !== "viewer",
                          onChanged: this.refresh.bind(this),
                        }),
                        ...configurationDraftInserts(data.configurationDrafts, {
                          actions: createConfigurationDraftActions(
                            this.props.organisationId,
                            conversation.id,
                          ),
                          canManage:
                            this.props.canManage &&
                            conversation.sharing?.role !== "viewer",
                          onChanged: this.refresh.bind(this),
                        }),
                        ...sideCaseInserts(data.sideCases, {
                          actions: createSideCaseActions(
                            this.props.organisationId,
                            conversation.id,
                          ),
                          canManage:
                            this.props.canManage &&
                            conversation.sharing?.role !== "viewer",
                          basePath: this.props.basePath,
                          onOpen: this.openThread.bind(this),
                          onChanged: this.refresh.bind(this),
                          sendHere: this.sendSideCaseHere.bind(this),
                          timeline: conversation.timeline,
                        }),
                      ],
                    )}
                    <ChatExecutionTrace
                      key={conversation.id}
                      organisationId={this.props.organisationId}
                      conversationId={conversation.id}
                      revision={conversation.revision}
                      work={conversation.work}
                    />
                  </VoiceApprovalContext.Provider>
                )}
                {conversation === null ? null : (
                  <ChatHeldStepPrompt
                    organisationId={this.props.organisationId}
                    conversationId={conversation.id}
                    workspaceName={this.props.context.workspace}
                    workKey={`${conversation.revision}:${conversation.work.kind}`}
                  />
                )}
                {conversation?.work.kind === "awaiting_permission" ? (
                  <ChatPermissionPrompt
                    key={conversation.work.permission.permissionRequestId}
                    organisationId={this.props.organisationId}
                    conversationId={conversation.id}
                    permission={conversation.work.permission}
                    workspaceName={this.props.context.workspace}
                    signedInAs={this.props.signedInAs}
                    accessPath={this.props.accessPath}
                    access={this.props.access}
                    onDecided={this.acceptPermissionDecision}
                  />
                ) : null}
                {this.renderOutgoing()}
                <ChatResponseIndicator
                  key={
                    conversation === null || conversation.work.kind === "ready"
                      ? "idle"
                      : `${conversation.id}:${conversation.work.requestId}:${conversation.work.kind}`
                  }
                  work={conversation?.work ?? null}
                  stream={this.state.stream}
                  sending={this.state.sending}
                />
                {this.renderStreamingMessage()}
                {conversation?.work.kind === "failed" ? (
                  <p role="alert">{conversation.work.error}</p>
                ) : null}
                {this.state.stream.kind === "failed" &&
                conversation?.work.kind !== "failed" ? (
                  <p role="alert">{this.state.stream.message}</p>
                ) : null}
                {conversation?.work.kind === "failed" &&
                conversation.work.recovery === "projection_capacity" ? (
                  <a
                    href={`/v1/control/organisations/${encodeURIComponent(this.props.organisationId)}/chat/stream?${new URLSearchParams({ conversation: conversation.id, request: conversation.work.requestId, after: "-1", download: "true" })}`}
                    download
                  >
                    Download saved response stream
                  </a>
                ) : null}
                {conversation?.work.kind === "running" &&
                needsRetry &&
                !active &&
                !archived ? (
                  <p role="status">
                    This response was interrupted. Retry to continue from the
                    saved conversation.
                  </p>
                ) : null}
                {needsRetry &&
                !archived &&
                !(
                  conversation?.work.kind === "failed" &&
                  conversation.work.recovery === "projection_capacity"
                ) ? (
                  <button
                    type="button"
                    disabled={this.state.sending}
                    onClick={this.retry.bind(this)}
                  >
                    Retry response
                  </button>
                ) : null}
                {archived ? (
                  <section
                    className="chat-archived-banner"
                    aria-label="Archived chat"
                  >
                    <Archive size={18} aria-hidden="true" />
                    <p>
                      This chat is archived. Restore it to continue the
                      conversation.
                    </p>
                    <button
                      type="button"
                      disabled={this.state.metadataUpdate.kind === "updating"}
                      onClick={this.restoreConversation.bind(
                        this,
                        conversation,
                      )}
                    >
                      Restore chat
                    </button>
                  </section>
                ) : null}
                {this.state.error === null ? null : (
                  <p role="alert">{this.state.error}</p>
                )}
              </MessageScroller>
            )}
            {!opening &&
            conversation !== null &&
            this.state.draftConflictNotice?.conversationId ===
              conversation.id ? (
              <aside
                className="chat-draft-notice"
                aria-label="Draft updated elsewhere"
              >
                <MessageSquareWarning size={18} aria-hidden="true" />
                <div role="status">
                  <strong>Draft updated elsewhere</strong>
                  <p>
                    This draft was updated elsewhere. Your local text is still
                    here; refresh when you are ready to compare.
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss draft notice"
                  onClick={this.dismissDraftConflict.bind(this)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </aside>
            ) : null}
            {conversation !== null ? (
              <ChatGoalControl
                key={`${this.props.organisationId}:${conversation.id}`}
                ref={this.goal}
                organisationId={this.props.organisationId}
                conversationId={conversation.id}
                observationVersion={this.state.observationVersion}
                busy={
                  this.state.sending ||
                  (conversation.work.kind !== "ready" &&
                    conversation.work.kind !== "failed")
                }
              />
            ) : null}
            <form
              className="chat-composer"
              onSubmit={this.submit.bind(this)}
              onDragOver={this.dragFiles.bind(this)}
              onDrop={this.dropFiles.bind(this)}
            >
              <label htmlFor="chat-message">Message your AI</label>
              {!opening && this.state.queued.length > 0 ? (
                <section className="chat-queue" aria-label="Queued messages">
                  <h3>
                    {this.state.queued.length} queued
                    <span>Sends when this response ends</span>
                  </h3>
                  <ul>
                    {this.state.queued.map(
                      this.renderQueued.bind(
                        this,
                        !archived && conversation?.work.kind === "running",
                      ),
                    )}
                  </ul>
                </section>
              ) : null}
              <div className="chat-composer-surface">
                <ComposerGlow
                  work={archived ? null : (conversation?.work ?? null)}
                  stream={this.state.stream}
                  sending={!archived && this.state.sending}
                  voice={this.voice}
                />
                <VoiceControl
                  session={this.voice}
                  organisationId={this.props.organisationId}
                  workspaceName={this.props.context.workspace}
                  signedInAs={this.props.signedInAs}
                  accessPath={this.props.accessPath}
                  access={this.props.access}
                />
                <textarea
                  id="chat-message"
                  ref={this.composer}
                  value={
                    opening ||
                    this.outgoingText()?.trim() === this.state.draft.trim()
                      ? ""
                      : this.state.draft
                  }
                  onChange={this.changeDraft.bind(this)}
                  onKeyDown={this.composerKeyDown.bind(this)}
                  onPaste={this.pasteFiles.bind(this)}
                  rows={2}
                  maxLength={8000}
                  placeholder="Ask anything…"
                  disabled={
                    archived ||
                    needsRetry ||
                    inputBlocked ||
                    data.model.kind !== "ready"
                  }
                />
                {this.state.files.length > 0 ? (
                  <ul
                    className="chat-selected-files"
                    aria-label="Attached files"
                  >
                    {this.state.files.map(this.renderSelectedFile.bind(this))}
                  </ul>
                ) : null}
                <span role="status">
                  {this.state.sending && this.state.files.length > 0
                    ? "Uploading attached files…"
                    : ""}
                </span>
                <div className="chat-composer-toolbar">
                  <details name="composer-menu" className="chat-add-menu">
                    <summary aria-label="Add files and context">
                      <Plus size={20} aria-hidden="true" />
                    </summary>
                    <div className="chat-composer-menu">
                      <p className="chat-menu-title">Add context</p>
                      <label className="chat-file-option">
                        <Paperclip size={18} aria-hidden="true" />
                        <span>
                          Kitchen file
                          <small>
                            Run, request, recording or handoff for review
                          </small>
                        </span>
                        <input
                          type="file"
                          accept=".json"
                          disabled={archived}
                          onChange={this.attachBakeryFile.bind(this)}
                          aria-label="Attach Kitchen file"
                        />
                      </label>
                      <label className="chat-file-option">
                        <Paperclip size={18} aria-hidden="true" />
                        <span>
                          Files<small>Documents, images, audio, video</small>
                        </span>
                        <input
                          type="file"
                          multiple
                          onChange={this.attachFiles.bind(this)}
                          disabled={
                            archived ||
                            inputBlocked ||
                            this.state.sending ||
                            this.state.steering
                          }
                          aria-label="Attach files"
                        />
                      </label>
                      <a href={this.props.integrationsPath}>
                        <Plug size={18} aria-hidden="true" />
                        <span>
                          Connected apps<small>Manage your integrations</small>
                        </span>
                      </a>
                    </div>
                  </details>
                  <ScreenChip
                    chat={data.conversation}
                    organisationId={this.props.organisationId}
                    draft={this.state.draft}
                    onNewChat={this.moveDraftToNewChat.bind(this)}
                  />
                  <WorkspaceAccessMenu accessPath={this.props.accessPath} />
                  <ContextEstimateMenu data={data} draft={this.state.draft} />
                  <details name="composer-menu" className="chat-model-menu">
                    <summary>
                      {selectedModelName ?? "Choose model"}
                      <ChevronDown size={14} aria-hidden="true" />
                    </summary>
                    <div className="chat-composer-menu">
                      <p className="chat-menu-title">Choose model</p>
                      {data.model.kind === "ready"
                        ? data.model.options.map(
                            this.renderModelOption.bind(this),
                          )
                        : null}
                    </div>
                  </details>
                  {selectedModelOption !== undefined &&
                  selectedModelOption.capabilities.effortOptions.length > 1 ? (
                    <details name="composer-menu" className="chat-effort-menu">
                      <summary>
                        {effortLabel(selectedEffort)}
                        <ChevronDown size={14} aria-hidden="true" />
                      </summary>
                      <div className="chat-composer-menu">
                        <p className="chat-menu-title">Reasoning effort</p>
                        {selectedModelOption.capabilities.effortOptions.map(
                          renderEffortOption.bind(
                            null,
                            selectedEffort,
                            this.chooseEffort.bind(this),
                          ),
                        )}
                      </div>
                    </details>
                  ) : null}
                  {/* One shape for send, pending, stop and retry: the icon
                    swaps inside it and the pill widens for the label. */}
                  <button
                    type={stopping ? "button" : "submit"}
                    className="primary-button chat-send-button"
                    data-state={
                      retryStop
                        ? "retry-stop"
                        : cancelling || (this.state.sending && !stopping)
                          ? "pending"
                          : stopping
                            ? "stop"
                            : "send"
                    }
                    aria-label={
                      retryStop
                        ? "Retry stopping response"
                        : cancelling
                          ? "Stopping response"
                          : stopping
                            ? "Stop response"
                            : active
                              ? "Queue message"
                              : "Send message"
                    }
                    onClick={stopping ? this.stop.bind(this) : undefined}
                    disabled={
                      stopping
                        ? this.state.sending || (cancelling && !retryStop)
                        : archived ||
                          needsRetry ||
                          inputBlocked ||
                          data.model.kind !== "ready"
                    }
                  >
                    <span className="chat-send-icons" aria-hidden="true">
                      <ArrowUp data-icon="send" size={20} />
                      <LoaderCircle data-icon="pending" size={20} />
                      <span data-icon="stop" className="chat-stop-icon" />
                    </span>
                    <span className="chat-send-label" aria-hidden="true">
                      <span>
                        <span>Retry stop</span>
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            </form>
          </section>
        ) : (
          this.renderProjectOverview()
        )}
        <dialog
          ref={this.dialog}
          className="chat-setup-dialog"
          aria-labelledby="chat-setup-title"
          onCancel={cancelDialog.bind(null, this.closeSetup.bind(this))}
        >
          <DialogHeading
            id="chat-setup-title"
            title="Connect your app"
            close={this.closeSetup.bind(this)}
          />
          {this.state.setupOpen ? (
            <CustomConnectorsWorkspace
              organisationId={this.props.organisationId}
              configurationVersion={data.configurationVersion}
              canManage={true}
              query=""
              basePath={this.chatBasePath()}
              accessPath={this.props.accessPath}
              directory={EMPTY_DIRECTORY}
              presentation={{ kind: "embedded" }}
            />
          ) : null}
          <button
            type="button"
            className="primary-button"
            onClick={this.continueAfterSetup.bind(this)}
          >
            Continue in chat
          </button>
        </dialog>
      </>
    );
  }
  private renderStreamingMessage(): React.ReactNode {
    if (
      (this.state.stream.kind !== "active" &&
        this.state.stream.kind !== "reconnecting") ||
      this.state.stream.text.length === 0
    )
      return null;
    return (
      <article
        className="chat-message chat-assistant chat-streaming"
        aria-label="Assistant response in progress"
        aria-live="off"
      >
        <StreamingText text={this.state.stream.text} streaming />
      </article>
    );
  }
}

function streamAfterConversationRefresh(
  work: Chat["work"] | undefined,
  stream: ChatStreamState,
): ChatStreamState {
  if (
    work === undefined ||
    work.kind === "ready" ||
    work.kind === "failed" ||
    work.kind === "awaiting_permission"
  )
    return { kind: "idle" };
  if (stream.kind === "paused" && stream.requestId === work.requestId)
    return { kind: "idle" };
  return stream;
}

function timelineEventHasId(eventId: string, event: ChatTimelineView): boolean {
  return event.eventId === eventId;
}
function formatUsage(usage: ChatTurnUsage | null): string {
  if (usage === null) return "";
  return `Usage · ${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output · ${usage.totalTokens.toLocaleString()} total`;
}
function renderOperation(text: string): React.ReactNode {
  return <li key={text}>{text}</li>;
}

/** How long a stop or a steer settles before the Portal offers Retry stop. */
const STOP_RETRY_AFTER_MS = 6_000;

function renderSource(url: string): React.ReactNode {
  return (
    <li key={url}>
      <a href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
    </li>
  );
}


function applyReadSequence<
  T extends { id: ConversationId; lastReadSequence: number },
>(conversationId: ConversationId, observed: number, conversation: T): T {
  if (conversation.id !== conversationId) return conversation;
  return {
    ...conversation,
    lastReadSequence: Math.max(conversation.lastReadSequence, observed),
  };
}

function applyReadSequences<
  T extends { id: ConversationId; lastReadSequence: number },
>(
  conversationId: ConversationId,
  observed: number,
  conversations: readonly T[],
): T[] {
  const updated: T[] = [];
  for (const conversation of conversations)
    updated.push(applyReadSequence(conversationId, observed, conversation));
  return updated;
}

function applyConversationRead(
  conversationId: ConversationId,
  observed: number,
  state: State,
): Pick<State, "page"> {
  if (state.page.kind !== "ready") return { page: state.page };
  const data = state.page.data;
  return {
    page: {
      kind: "ready",
      data: {
        ...data,
        conversation:
          data.conversation === null
            ? null
            : applyReadSequence(conversationId, observed, data.conversation),
        conversations: applyReadSequences(
          conversationId,
          observed,
          data.conversations,
        ),
        archivedConversations: applyReadSequences(
          conversationId,
          observed,
          data.archivedConversations,
        ),
        pinnedConversations: applyReadSequences(
          conversationId,
          observed,
          data.pinnedConversations,
        ),
      },
    },
  };
}


function chatWorkIsActive(work: Chat["work"] | undefined): boolean {
  return (
    work !== undefined &&
    work.kind !== "ready" &&
    work.kind !== "failed" &&
    work.kind !== "awaiting_permission" &&
    work.expiresAt > Date.now()
  );
}

function chatWorkIsRetryable(
  work: Chat["work"] | undefined,
): work is Variant<Chat["work"], "failed" | "running"> {
  return (
    work !== undefined &&
    (work.kind === "failed" ||
      (work.kind === "running" && work.expiresAt <= Date.now()))
  );
}

function threadSidebarStyle(
  width: number,
): React.CSSProperties & { "--chat-threads-width": string } {
  return { "--chat-threads-width": `${width}px` };
}

function clampThreadsWidth(width: number): number {
  return Math.max(200, Math.min(500, width));
}

function threadsWidthFromPointer(
  resize: ChatThreadsResize,
  pointerX: number,
): number {
  return pointerX - resize.anchor;
}

function latestConversationMessage(
  events: readonly ChatTimelineView[],
): ChatTimelineView | null {
  for (const event of [...events].reverse()) {
    if (
      event.kind === "user" ||
      event.kind === "assistant" ||
      event.kind === "connector"
    )
      return event;
  }
  return null;
}

function projectHasId(id: string, project: Project): boolean {
  return project.id === id;
}
function chatInProject(
  projectId: ProjectId,
  conversation: ChatConversationSummary,
): boolean {
  return conversation.placement.projectId === projectId;
}
function renderProjectReference(reference: ProjectReference): React.ReactNode {
  return (
    <li key={JSON.stringify(reference)}>
      <FileText size={16} aria-hidden="true" />
      <span>{reference.label}</span>
    </li>
  );
}

function focusBranchPoint(messageId: string): void {
  const message = document.getElementById(`message-${messageId}`);
  message?.scrollIntoView({ block: "center" });
  message?.focus({ preventScroll: true });
}

function summaryHasConversationId(
  id: ConversationId,
  summary: ChatConversationSummary,
): boolean {
  return summary.id === id;
}

function initialConversationId(): ConversationId | null {
  const raw = new URLSearchParams(window.location.search).get("conversation");
  return isConversationId(raw) ? raw : null;
}

export function ConnectedChatPage(props: Props): React.ReactNode {
  const preferences = useUserPreferences("chat");
  return <ChatPage {...props} preferences={preferences} />;
}

function keepSelectedFile(removed: File, file: File): boolean {
  return file !== removed;
}
function invalidChatFile(file: File): boolean {
  return file.size === 0 || file.size > MESSAGE_ATTACHMENT_POLICY.maxFileBytes;
}
function totalFileBytes(total: number, file: File): number {
  return total + file.size;
}
function chatAttachmentLimits(): string {
  return `Attach up to ${MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage} non-empty files, ${MESSAGE_ATTACHMENT_POLICY.maxFileBytes / (1024 * 1024)} MiB each and ${MESSAGE_ATTACHMENT_POLICY.maxBatchBytes / (1024 * 1024)} MiB total.`;
}

function renderChatAttachmentPart(part: ChatAttachmentView): React.ReactNode {
  return (
    <li key={part.attachmentId}>
      <Paperclip size={14} aria-hidden="true" />
      {part.filename}
    </li>
  );
}
