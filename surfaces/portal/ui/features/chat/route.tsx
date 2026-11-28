// Loads here, before the other imports, so that the CSS order stays the same.
import "./operation-events";
import { ChatGoalControl } from "./goal";
import { ChatExecutionTrace } from "./execution-trace";
import { effortLabel } from "@purin-labs/ui/features/chat/effort-labels";
import { useUserPreferences } from "@purin-labs/ui/preferences/context";
import type { UserPreferenceOwner } from "@purin-labs/ui/preferences/owner";
import type { ConversationId, VoiceHeard } from "@purin-labs/control-api";
import { publishChatAgentRequest } from "./agent-request";
import {
  ComposerSubmissions,
  isOlderSnapshot,
  toQueuedInput,
} from "./submission";
import { captureBakeryBrowserContext } from "@purin-labs/area-kitchen-contract/ui/features/bakery-browser-context";
import { type BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import {
  StreamingText,
  EmptyState,
  MessageScroller,
  ResponseActions,
} from "@purin-labs/ui/index";
import React from "react";
import {
  Archive,
  ArrowUp,
  ChevronDown,
  History,
  LoaderCircle,
  MessageSquareWarning,
  Paperclip,
  Plug,
  Plus,
  ShieldCheck,
  Split,
  SquarePen,
  X,
} from "lucide-react";
import { ChatDisplayContext, ChatFullscreenButton } from "./underlay";
// Loads here so that the CSS order stays the same (see the first import).
import "./organizer";
import { chatSourceParts } from "./sources";
import type { ChatWorkspaceContext } from "./context";
import { ChatResponseIndicator, renderChatTimeline } from "./activity";
import { ComposerGlow } from "./composer-glow";
import { ChatPermissionPrompt } from "./permission-prompt";
import { ChatHeldStepPrompt } from "@purin-labs/area-organisation/ui/features/access/chat-held-step-prompt";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";
import { DialogHeading, syncDialog, cancelDialog } from "@purin-labs/ui/dialog";
import { soundsLikeStop, type VoiceCommand } from "@purin-labs/surface-voice/ui/features/voice/command";
import {
  lastAssistantEvent,
  speakVoiceAnswer,
  type VoiceAnswerWait,
} from "@purin-labs/surface-voice/ui/features/voice/answer";
import { VoiceControl, VoiceHeaderMark } from "@purin-labs/surface-voice/ui/features/voice/control";
import { UserMessageMarks } from "./message-marks";
import { ScreenChip } from "./screen-chip";
import { ContextEstimateMenu, WorkspaceAccessMenu } from "./composer-menus";
import { mergeDirectoryResult, type PageState } from "./page-state";
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
import {
  ChatAccessError,
  markChatRead,
  readChat,
  updateChatConversation,
} from "./api";
import { sendChat } from "./screen-send";
import type {
  Chat,
  ChatConversationSummary,
  ChatMessage,
} from "@purin-labs/control-api/portal/chat";
import {
  ChatDelivery,
  type ChatStreamState,
  type DeliveryIdentity,
} from "./delivery";
import { ChatSignalSocket } from "./signals";
import {
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
import type { ChatEffort, Project } from "@purin-labs/control-api";
import { errorMessage } from "@purin-labs/std";
import {
  modelName,
  modelOptionHasId,
  renderEffortOption,
  selectedEffortFromConversation,
  selectedEffortFromData,
  selectedEffortFromState,
  selectedModelFromData,
  selectedModelFromState,
} from "./model-choice";
import {
  EMPTY_DIRECTORY,
  SIGNAL_READ_DELAY_MS,
  SIGNAL_SAFETY_READ_MS,
  applyConversationRead,
  chatWorkIsActive,
  chatWorkIsRetryable,
  focusBranchPoint,
  formatUsage,
  initialConversationId,
  projectHasId,
  renderChatAttachmentPart,
  renderOperation,
  renderSource,
  streamAfterConversationRefresh,
  threadSidebarStyle,
  timelineEventHasId,
} from "./chat-route-helpers";
import type { ChatThreadsResize, ThreadPreview } from "./chat-route-helpers";
import { chatComposerMethods } from "./chat-composer";
import { chatMessageViews } from "./chat-message-views";
import { chatThreadSidebar } from "./chat-thread-sidebar";
import { chatIdentityViews } from "./chat-identity";

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
export type State = {
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

type ChatMetadataUpdateState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "updating";
      readonly conversationId: ConversationId;
    };

type BakeryContextCapture =
  | Readonly<{ kind: "captured"; browserContext: BakeryBrowserContext }>
  | Readonly<{ kind: "failed"; message: string }>;

export class ChatPage extends React.Component<Props, State> {
  private unsubscribePreferences: (() => void) | null = null;
  sidebarSaveTimer: ReturnType<typeof setTimeout> | null = null;
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
  readonly composer = React.createRef<HTMLTextAreaElement>();
  readonly goal = React.createRef<ChatGoalControl>();
  readonly transcript = React.createRef<MessageScroller>();
  readonly threadFiles = new Map<string, readonly File[]>();
  readonly threadDrafts = new Map<ConversationId, string>();
  readonly threadScrollPositions = new Map<string, number>();
  readonly layout = React.createRef<HTMLDivElement>();
  threadsResize: ChatThreadsResize | null = null;
  private delivery: ChatDelivery | null = null;
  private signals: ChatSignalSocket | null = null;
  private signalTimer: number | null = null;
  private signalPending = false;
  private lastReadAt = 0;
  private readonly onVisibilityChange = this.acceptVisibility.bind(this);
  mounted = false;
  loading = false;
  readonly submissions = new ComposerSubmissions();
  selectionVersion = 0;
  navigationVersion = 0;
  threadPreview: ThreadPreview | null = null;
  threadPreviewTimer: number | null = null;
  private readonly onHistoryChange = this.restoreLocation.bind(this);
  private readonly onThreadsViewportChange =
    this.cancelThreadsResize.bind(this);
  forkPending = false;
  conversationId = initialConversationId();
  pending: {
    readonly requestId: string;
    readonly model: string;
    readonly text: string;
    readonly files: readonly File[];
    readonly effort: ChatEffort;
    readonly browserContext: BakeryBrowserContext;
    readonly goalTokenBudget: number | null;
  } | null = null;
  pendingQueueAdmission: {
    readonly inputId: string;
    readonly requestId: string;
    readonly model: string;
    readonly text: string;
    readonly files: readonly File[];
    readonly effort: ChatEffort;
    readonly browserContext: BakeryBrowserContext;
  } | null = null;
  pendingSteering: {
    readonly inputId: string;
    readonly requestId: string;
    readonly cancellationId: string;
    readonly model: string;
    readonly text: string;
    readonly files: readonly File[];
    readonly effort: ChatEffort;
    readonly browserContext: BakeryBrowserContext;
  } | null = null;
  observedReadSequence = 0;
  private branchPointLocation: string | null = null;
  draftSaveTimer: number | null = null;
  stopRetryTimer: number | null = null;
  watchedCancellation: string | null = null;
  private chatRefreshTimer: number | null = null;
  draftSavePromise: Promise<void> | null = null;
  private directorySearchTimer: number | null = null;
  directorySearchVersion = 0;
  draftDirty = false;
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
  async captureBakeryContext(): Promise<BakeryContextCapture> {
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
  async refresh(
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
  changeThreadQuery(event: React.ChangeEvent<HTMLInputElement>): void {
    const query = event.currentTarget.value;
    this.setState({ threadQuery: query });
    this.cancelDirectorySearch();
    const version = ++this.directorySearchVersion;
    this.directorySearchTimer = window.setTimeout(
      this.refreshDirectory.bind(this, query, version),
      250,
    );
  }
  cancelDirectorySearch(): void {
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
  private changeDraft(
    ...args: Parameters<typeof chatComposerMethods.changeDraft>
  ) {
    return chatComposerMethods.changeDraft.apply(this, args);
  }
  scheduleDraftSave(
    ...args: Parameters<typeof chatComposerMethods.scheduleDraftSave>
  ) {
    return chatComposerMethods.scheduleDraftSave.apply(this, args);
  }
  saveDraft(...args: Parameters<typeof chatComposerMethods.saveDraft>) {
    return chatComposerMethods.saveDraft.apply(this, args);
  }
  persistDraft(...args: Parameters<typeof chatComposerMethods.persistDraft>) {
    return chatComposerMethods.persistDraft.apply(this, args);
  }
  cancelDraftSave(
    ...args: Parameters<typeof chatComposerMethods.cancelDraftSave>
  ) {
    return chatComposerMethods.cancelDraftSave.apply(this, args);
  }
  private dismissDraftConflict(
    ...args: Parameters<typeof chatComposerMethods.dismissDraftConflict>
  ) {
    return chatComposerMethods.dismissDraftConflict.apply(this, args);
  }
  flushDraftSave(
    ...args: Parameters<typeof chatComposerMethods.flushDraftSave>
  ) {
    return chatComposerMethods.flushDraftSave.apply(this, args);
  }
  private retryLoad(): void {
    this.setState({ page: { kind: "loading" } });
    void this.refresh();
  }
  private choosePrompt(
    ...args: Parameters<typeof chatComposerMethods.choosePrompt>
  ) {
    return chatComposerMethods.choosePrompt.apply(this, args);
  }
  scrollToLatest(): void {
    this.transcript.current?.scrollToEnd();
  }
  private submit(...args: Parameters<typeof chatComposerMethods.submit>) {
    return chatComposerMethods.submit.apply(this, args);
  }
  isWorking(): boolean {
    return (
      this.submissions.sending(this.conversationId) ||
      this.state.sending ||
      (this.state.page.kind === "ready" &&
        chatWorkIsActive(this.state.page.data.conversation?.work))
    );
  }
  isArchived(): boolean {
    return (
      this.state.page.kind === "ready" &&
      this.state.page.data.conversation?.lifecycle === "archived"
    );
  }
  private composerKeyDown(
    ...args: Parameters<typeof chatComposerMethods.composerKeyDown>
  ) {
    return chatComposerMethods.composerKeyDown.apply(this, args);
  }
  submitDraft(...args: Parameters<typeof chatComposerMethods.submitDraft>) {
    return chatComposerMethods.submitDraft.apply(this, args);
  }
  private moveDraftToNewChat(
    ...args: Parameters<typeof chatComposerMethods.moveDraftToNewChat>
  ) {
    return chatComposerMethods.moveDraftToNewChat.apply(this, args);
  }
  clearDraft(...args: Parameters<typeof chatComposerMethods.clearDraft>) {
    return chatComposerMethods.clearDraft.apply(this, args);
  }
  runGoalCommand(
    ...args: Parameters<typeof chatComposerMethods.runGoalCommand>
  ) {
    return chatComposerMethods.runGoalCommand.apply(this, args);
  }
  enqueue(...args: Parameters<typeof chatComposerMethods.enqueue>) {
    return chatComposerMethods.enqueue.apply(this, args);
  }
  sendAfterFinishedTurn(
    ...args: Parameters<typeof chatComposerMethods.sendAfterFinishedTurn>
  ) {
    return chatComposerMethods.sendAfterFinishedTurn.apply(this, args);
  }
  sendRestoredDraft(
    ...args: Parameters<typeof chatComposerMethods.sendRestoredDraft>
  ) {
    return chatComposerMethods.sendRestoredDraft.apply(this, args);
  }
  removeQueued(...args: Parameters<typeof chatComposerMethods.removeQueued>) {
    return chatComposerMethods.removeQueued.apply(this, args);
  }
  withdrawQueued(
    ...args: Parameters<typeof chatComposerMethods.withdrawQueued>
  ) {
    return chatComposerMethods.withdrawQueued.apply(this, args);
  }
  steerQueued(...args: Parameters<typeof chatComposerMethods.steerQueued>) {
    return chatComposerMethods.steerQueued.apply(this, args);
  }
  private watchStopRetry(
    ...args: Parameters<typeof chatComposerMethods.watchStopRetry>
  ) {
    return chatComposerMethods.watchStopRetry.apply(this, args);
  }
  offerStopRetry(
    ...args: Parameters<typeof chatComposerMethods.offerStopRetry>
  ) {
    return chatComposerMethods.offerStopRetry.apply(this, args);
  }
  private stop(...args: Parameters<typeof chatComposerMethods.stop>) {
    return chatComposerMethods.stop.apply(this, args);
  }
  steer(...args: Parameters<typeof chatComposerMethods.steer>) {
    return chatComposerMethods.steer.apply(this, args);
  }
  private attachBakeryFile(
    ...args: Parameters<typeof chatComposerMethods.attachBakeryFile>
  ) {
    return chatComposerMethods.attachBakeryFile.apply(this, args);
  }
  private attachFiles(
    ...args: Parameters<typeof chatComposerMethods.attachFiles>
  ) {
    return chatComposerMethods.attachFiles.apply(this, args);
  }
  addFiles(...args: Parameters<typeof chatComposerMethods.addFiles>) {
    return chatComposerMethods.addFiles.apply(this, args);
  }
  canAttachFiles(
    ...args: Parameters<typeof chatComposerMethods.canAttachFiles>
  ) {
    return chatComposerMethods.canAttachFiles.apply(this, args);
  }
  private dragFiles(...args: Parameters<typeof chatComposerMethods.dragFiles>) {
    return chatComposerMethods.dragFiles.apply(this, args);
  }
  private dropFiles(...args: Parameters<typeof chatComposerMethods.dropFiles>) {
    return chatComposerMethods.dropFiles.apply(this, args);
  }
  private pasteFiles(
    ...args: Parameters<typeof chatComposerMethods.pasteFiles>
  ) {
    return chatComposerMethods.pasteFiles.apply(this, args);
  }
  removeFile(...args: Parameters<typeof chatComposerMethods.removeFile>) {
    return chatComposerMethods.removeFile.apply(this, args);
  }
  private renderSelectedFile(
    ...args: Parameters<typeof chatMessageViews.renderSelectedFile>
  ) {
    return chatMessageViews.renderSelectedFile.apply(this, args);
  }
  clearSubmittedFiles(
    ...args: Parameters<typeof chatComposerMethods.clearSubmittedFiles>
  ) {
    return chatComposerMethods.clearSubmittedFiles.apply(this, args);
  }
  prepareComposerSubmission(
    ...args: Parameters<typeof chatComposerMethods.prepareComposerSubmission>
  ) {
    return chatComposerMethods.prepareComposerSubmission.apply(this, args);
  }
  private renderQueued(
    ...args: Parameters<typeof chatMessageViews.renderQueued>
  ) {
    return chatMessageViews.renderQueued.apply(this, args);
  }
  answerQuestion(
    ...args: Parameters<typeof chatComposerMethods.answerQuestion>
  ) {
    return chatComposerMethods.answerQuestion.apply(this, args);
  }
  questionAvailability(
    ...args: Parameters<typeof chatComposerMethods.questionAvailability>
  ) {
    return chatComposerMethods.questionAvailability.apply(this, args);
  }
  send(...args: Parameters<typeof chatComposerMethods.send>) {
    return chatComposerMethods.send.apply(this, args);
  }
  startConversation(
    ...args: Parameters<typeof chatComposerMethods.startConversation>
  ) {
    return chatComposerMethods.startConversation.apply(this, args);
  }
  outgoingText(...args: Parameters<typeof chatComposerMethods.outgoingText>) {
    return chatComposerMethods.outgoingText.apply(this, args);
  }
  private renderOutgoing(
    ...args: Parameters<typeof chatMessageViews.renderOutgoing>
  ) {
    return chatMessageViews.renderOutgoing.apply(this, args);
  }
  private sendSideCaseHere(
    ...args: Parameters<typeof chatComposerMethods.sendSideCaseHere>
  ) {
    return chatComposerMethods.sendSideCaseHere.apply(this, args);
  }
  acceptConversation(conversation: Chat): void {
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
  stopStream(): void {
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
  private retry(...args: Parameters<typeof chatComposerMethods.retry>) {
    return chatComposerMethods.retry.apply(this, args);
  }
  updateLocation(includeSetup: boolean): void {
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
  chatBasePath(): string {
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
  renderMessage(message: ChatMessage): React.ReactNode {
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
  private usageForMessage(
    ...args: Parameters<typeof chatMessageViews.usageForMessage>
  ) {
    return chatMessageViews.usageForMessage.apply(this, args);
  }
  private renderMessageTime(
    ...args: Parameters<typeof chatMessageViews.renderMessageTime>
  ) {
    return chatMessageViews.renderMessageTime.apply(this, args);
  }
  renderResponseActions(
    ...args: Parameters<typeof chatMessageViews.renderResponseActions>
  ) {
    return chatMessageViews.renderResponseActions.apply(this, args);
  }
  requestFork(...args: Parameters<typeof chatMessageViews.requestFork>) {
    return chatMessageViews.requestFork.apply(this, args);
  }
  private closeForkConfirmation(
    ...args: Parameters<typeof chatMessageViews.closeForkConfirmation>
  ) {
    return chatMessageViews.closeForkConfirmation.apply(this, args);
  }
  private confirmFork(
    ...args: Parameters<typeof chatMessageViews.confirmFork>
  ) {
    return chatMessageViews.confirmFork.apply(this, args);
  }
  forkResponse(...args: Parameters<typeof chatMessageViews.forkResponse>) {
    return chatMessageViews.forkResponse.apply(this, args);
  }
  revealSelectedFork(
    ...args: Parameters<typeof chatMessageViews.revealSelectedFork>
  ) {
    return chatMessageViews.revealSelectedFork.apply(this, args);
  }
  private renderBranchNavigation(
    ...args: Parameters<typeof chatMessageViews.renderBranchNavigation>
  ) {
    return chatMessageViews.renderBranchNavigation.apply(this, args);
  }
  renderSideCaseSource(
    ...args: Parameters<typeof chatMessageViews.renderSideCaseSource>
  ) {
    return chatMessageViews.renderSideCaseSource.apply(this, args);
  }
  openBranchPoint(
    ...args: Parameters<typeof chatMessageViews.openBranchPoint>
  ) {
    return chatMessageViews.openBranchPoint.apply(this, args);
  }
  renderDerivedThread(
    ...args: Parameters<typeof chatMessageViews.renderDerivedThread>
  ) {
    return chatMessageViews.renderDerivedThread.apply(this, args);
  }
  rateResponse(...args: Parameters<typeof chatMessageViews.rateResponse>) {
    return chatMessageViews.rateResponse.apply(this, args);
  }
  regenerateResponse(
    ...args: Parameters<typeof chatMessageViews.regenerateResponse>
  ) {
    return chatMessageViews.regenerateResponse.apply(this, args);
  }
  isInheritedEvent(
    ...args: Parameters<typeof chatMessageViews.isInheritedEvent>
  ) {
    return chatMessageViews.isInheritedEvent.apply(this, args);
  }
  private renderTimelineEvent(
    ...args: Parameters<typeof chatMessageViews.renderTimelineEvent>
  ) {
    return chatMessageViews.renderTimelineEvent.apply(this, args);
  }
  openNewChat(...args: Parameters<typeof chatThreadSidebar.openNewChat>) {
    return chatThreadSidebar.openNewChat.apply(this, args);
  }
  openThread(...args: Parameters<typeof chatThreadSidebar.openThread>) {
    return chatThreadSidebar.openThread.apply(this, args);
  }
  private restoreLocation(): void {
    void this.selectThread(initialConversationId(), false);
  }
  previewThread(...args: Parameters<typeof chatThreadSidebar.previewThread>) {
    return chatThreadSidebar.previewThread.apply(this, args);
  }
  endThreadPreviewWait(
    ...args: Parameters<typeof chatThreadSidebar.endThreadPreviewWait>
  ) {
    return chatThreadSidebar.endThreadPreviewWait.apply(this, args);
  }
  startThreadPreview(
    ...args: Parameters<typeof chatThreadSidebar.startThreadPreview>
  ) {
    return chatThreadSidebar.startThreadPreview.apply(this, args);
  }
  takeThreadPreview(
    ...args: Parameters<typeof chatThreadSidebar.takeThreadPreview>
  ) {
    return chatThreadSidebar.takeThreadPreview.apply(this, args);
  }
  organizerChanged(
    ...args: Parameters<typeof chatThreadSidebar.organizerChanged>
  ) {
    return chatThreadSidebar.organizerChanged.apply(this, args);
  }
  selectThread(...args: Parameters<typeof chatThreadSidebar.selectThread>) {
    return chatThreadSidebar.selectThread.apply(this, args);
  }
  private openHistory(
    ...args: Parameters<typeof chatThreadSidebar.openHistory>
  ) {
    return chatThreadSidebar.openHistory.apply(this, args);
  }
  closeHistory(...args: Parameters<typeof chatThreadSidebar.closeHistory>) {
    return chatThreadSidebar.closeHistory.apply(this, args);
  }
  private finishHistoryClose(
    ...args: Parameters<typeof chatThreadSidebar.finishHistoryClose>
  ) {
    return chatThreadSidebar.finishHistoryClose.apply(this, args);
  }

  private dismissHistoryBackdrop(
    ...args: Parameters<typeof chatThreadSidebar.dismissHistoryBackdrop>
  ) {
    return chatThreadSidebar.dismissHistoryBackdrop.apply(this, args);
  }

  toggleThreads(...args: Parameters<typeof chatThreadSidebar.toggleThreads>) {
    return chatThreadSidebar.toggleThreads.apply(this, args);
  }
  focusThreadsToggle(
    ...args: Parameters<typeof chatThreadSidebar.focusThreadsToggle>
  ) {
    return chatThreadSidebar.focusThreadsToggle.apply(this, args);
  }

  private expandThreads(
    ...args: Parameters<typeof chatThreadSidebar.expandThreads>
  ) {
    return chatThreadSidebar.expandThreads.apply(this, args);
  }

  resizeThreads(...args: Parameters<typeof chatThreadSidebar.resizeThreads>) {
    return chatThreadSidebar.resizeThreads.apply(this, args);
  }

  startThreadsResize(
    ...args: Parameters<typeof chatThreadSidebar.startThreadsResize>
  ) {
    return chatThreadSidebar.startThreadsResize.apply(this, args);
  }

  finishThreadsResize(
    ...args: Parameters<typeof chatThreadSidebar.finishThreadsResize>
  ) {
    return chatThreadSidebar.finishThreadsResize.apply(this, args);
  }

  releaseThreadsResize(
    ...args: Parameters<typeof chatThreadSidebar.releaseThreadsResize>
  ) {
    return chatThreadSidebar.releaseThreadsResize.apply(this, args);
  }

  restoreThreadsWidth(
    ...args: Parameters<typeof chatThreadSidebar.restoreThreadsWidth>
  ) {
    return chatThreadSidebar.restoreThreadsWidth.apply(this, args);
  }

  cancelThreadsResize(
    ...args: Parameters<typeof chatThreadSidebar.cancelThreadsResize>
  ) {
    return chatThreadSidebar.cancelThreadsResize.apply(this, args);
  }

  currentThreadsWidth(
    ...args: Parameters<typeof chatThreadSidebar.currentThreadsWidth>
  ) {
    return chatThreadSidebar.currentThreadsWidth.apply(this, args);
  }

  resizeThreadsWithKeyboard(
    ...args: Parameters<typeof chatThreadSidebar.resizeThreadsWithKeyboard>
  ) {
    return chatThreadSidebar.resizeThreadsWithKeyboard.apply(this, args);
  }

  syncChatPreferences(): void {
    if (this.threadsResize !== null || this.sidebarSaveTimer !== null) return;
    const document = this.props.preferences?.document("chat");
    if (
      document?.area === "chat" &&
      document.values.fullscreenSidebarWidthPx !== this.state.threadsWidth
    ) {
      this.setState({ threadsWidth: document.values.fullscreenSidebarWidthPx });
    }
  }
  saveThreadsWidth(
    ...args: Parameters<typeof chatThreadSidebar.saveThreadsWidth>
  ) {
    return chatThreadSidebar.saveThreadsWidth.apply(this, args);
  }
  flushThreadsWidth(
    ...args: Parameters<typeof chatThreadSidebar.flushThreadsWidth>
  ) {
    return chatThreadSidebar.flushThreadsWidth.apply(this, args);
  }
  chooseProject(...args: Parameters<typeof chatThreadSidebar.chooseProject>) {
    return chatThreadSidebar.chooseProject.apply(this, args);
  }
  organizerSelect(
    ...args: Parameters<typeof chatThreadSidebar.organizerSelect>
  ) {
    return chatThreadSidebar.organizerSelect.apply(this, args);
  }
  organizerRemoved(
    ...args: Parameters<typeof chatThreadSidebar.organizerRemoved>
  ) {
    return chatThreadSidebar.organizerRemoved.apply(this, args);
  }
  private renderProjectOverview(
    ...args: Parameters<typeof chatThreadSidebar.renderProjectOverview>
  ) {
    return chatThreadSidebar.renderProjectOverview.apply(this, args);
  }
  makeDefault(...args: Parameters<typeof chatThreadSidebar.makeDefault>) {
    return chatThreadSidebar.makeDefault.apply(this, args);
  }
  renderProjectChatLink(
    ...args: Parameters<typeof chatThreadSidebar.renderProjectChatLink>
  ) {
    return chatThreadSidebar.renderProjectChatLink.apply(this, args);
  }
  startProjectChat(
    ...args: Parameters<typeof chatThreadSidebar.startProjectChat>
  ) {
    return chatThreadSidebar.startProjectChat.apply(this, args);
  }

  private renderThreadSidebar(
    ...args: Parameters<typeof chatThreadSidebar.renderThreadSidebar>
  ) {
    return chatThreadSidebar.renderThreadSidebar.apply(this, args);
  }
  chooseModel(...args: Parameters<typeof chatIdentityViews.chooseModel>) {
    return chatIdentityViews.chooseModel.apply(this, args);
  }
  private chooseEffort(
    ...args: Parameters<typeof chatIdentityViews.chooseEffort>
  ) {
    return chatIdentityViews.chooseEffort.apply(this, args);
  }
  private renderModelOption(
    ...args: Parameters<typeof chatIdentityViews.renderModelOption>
  ) {
    return chatIdentityViews.renderModelOption.apply(this, args);
  }
  openingTitle(...args: Parameters<typeof chatIdentityViews.openingTitle>) {
    return chatIdentityViews.openingTitle.apply(this, args);
  }
  renderChatIdentity(
    ...args: Parameters<typeof chatIdentityViews.renderChatIdentity>
  ) {
    return chatIdentityViews.renderChatIdentity.apply(this, args);
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
  private renderStreamingMessage(
    ...args: Parameters<typeof chatMessageViews.renderStreamingMessage>
  ) {
    return chatMessageViews.renderStreamingMessage.apply(this, args);
  }
}

export function ConnectedChatPage(props: Props): React.ReactNode {
  const preferences = useUserPreferences("chat");
  return <ChatPage {...props} preferences={preferences} />;
}
