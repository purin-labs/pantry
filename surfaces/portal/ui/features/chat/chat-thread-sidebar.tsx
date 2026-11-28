import { newConversationId } from "@purin-labs/control-api";
import type { ConversationId, ProjectId } from "@purin-labs/control-api";
import { toQueuedInput } from "./submission";
import React from "react";
import {
  ChevronRight,
  Folder,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
import { ChatOrganizer } from "./organizer";
import { ProjectCases } from "./project-cases";
import { isBackdropClick } from "@purin-labs/ui/dialog";
import { createProjectChat, makeDefaultProject, readChat } from "./api";
import type {
  ChatConversationSummary,
  ChatPageData,
} from "@purin-labs/control-api/portal/chat";
import { notifySurfaceListeners } from "@purin-labs/area-kitchen-contract/ui/features/bakery-surface-registry";
import type { Project } from "@purin-labs/control-api";
import { errorMessage } from "@purin-labs/std";
import { selectedEffortFromData, selectedModelFromData } from "./model-choice";
import type { ChatPage } from "./route";
import {
  THREAD_PREVIEW_REST_MS,
  chatInProject,
  clampThreadsWidth,
  previewOfReadyThread,
  projectHasId,
  readNoThreadPreview,
  renderProjectReference,
  threadPreviewIsFresh,
  threadsWidthFromPointer,
} from "./chat-route-helpers";
import type { ThreadPreview } from "./chat-route-helpers";

export const chatThreadSidebar = {
  openNewChat(
    this: ChatPage,
    event: React.MouseEvent<HTMLAnchorElement>,
  ): void {
    this.openThread(null, event);
  },

  openThread(
    this: ChatPage,
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
  },

  /** The read starts when the pointer rests on a row, before the click. */
  previewThread(this: ChatPage, id: ConversationId): void {
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
  },

  endThreadPreviewWait(this: ChatPage): void {
    if (this.threadPreviewTimer !== null)
      window.clearTimeout(this.threadPreviewTimer);
    this.threadPreviewTimer = null;
  },

  startThreadPreview(this: ChatPage, id: ConversationId): void {
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
  },

  /** Null when the click must read: an old answer, or a chat with open work. */
  takeThreadPreview(
    this: ChatPage,
    id: ConversationId | null,
  ): Promise<ChatPageData | null> {
    this.endThreadPreviewWait();
    const preview = this.threadPreview;
    this.threadPreview = null;
    if (preview?.id !== id || !threadPreviewIsFresh(preview))
      return Promise.resolve(null);
    return preview.read.then(previewOfReadyThread);
  },

  organizerChanged(this: ChatPage): Promise<void> {
    this.threadPreview = null;
    return this.refresh();
  },

  async selectThread(
    this: ChatPage,
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
  },

  openHistory(this: ChatPage): void {
    this.setState({ history: "open" });
  },

  closeHistory(this: ChatPage): void {
    if (this.state.history !== "open") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.setState({ history: "closed" });
      return;
    }
    this.setState({ history: "closing" });
  },

  finishHistoryClose(
    this: ChatPage,
    event: React.TransitionEvent<HTMLDialogElement>,
  ): void {
    if (
      event.target === event.currentTarget &&
      event.propertyName === "opacity" &&
      this.state.history === "closing"
    ) {
      this.setState({ history: "closed" });
    }
  },

  dismissHistoryBackdrop(
    this: ChatPage,
    event: React.MouseEvent<HTMLDialogElement>,
  ): void {
    if (isBackdropClick(event)) this.closeHistory();
  },

  toggleThreads(this: ChatPage): void {
    this.setState(
      { threadsExpanded: !this.state.threadsExpanded },
      this.focusThreadsToggle.bind(this),
    );
  },

  focusThreadsToggle(this: ChatPage): void {
    const panel = this.state.threadsExpanded
      ? ".chat-thread-sidebar"
      : ".chat-main-panel";
    this.layout.current
      ?.querySelector<HTMLButtonElement>(`${panel} .dashboard-sidebar-toggle`)
      ?.focus({ preventScroll: true });
  },

  // Fullscreen chat opens with the thread list showing.
  expandThreads(this: ChatPage): void {
    this.setState({ threadsExpanded: true });
  },

  resizeThreads(
    this: ChatPage,
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
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
  },

  startThreadsResize(
    this: ChatPage,
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
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
  },

  finishThreadsResize(
    this: ChatPage,
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    const resize = this.threadsResize;
    if (resize === null || resize.pointerId !== event.pointerId) return;
    this.releaseThreadsResize();
    if (event.type === "pointerup" && resize.moved) {
      this.setState({ threadsWidth: resize.width });
      this.saveThreadsWidth(resize.width);
    } else {
      this.restoreThreadsWidth();
    }
  },

  releaseThreadsResize(this: ChatPage): void {
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
  },

  restoreThreadsWidth(this: ChatPage): void {
    this.layout.current?.style.setProperty(
      "--chat-threads-width",
      `${this.state.threadsWidth}px`,
    );
    this.layout.current
      ?.querySelector<HTMLDivElement>(".chat-threads-resize")
      ?.setAttribute("aria-valuenow", String(this.state.threadsWidth));
    this.syncChatPreferences();
  },

  cancelThreadsResize(this: ChatPage): void {
    if (this.threadsResize === null) return;
    const handle = this.layout.current?.querySelector<HTMLDivElement>(
      ".chat-threads-resize",
    );
    this.releaseThreadsResize();
    this.restoreThreadsWidth();
    if (handle?.getClientRects().length === 0) {
      this.composer.current?.focus({ preventScroll: true });
    }
  },

  currentThreadsWidth(this: ChatPage): number {
    return this.threadsResize?.width ?? this.state.threadsWidth;
  },

  resizeThreadsWithKeyboard(
    this: ChatPage,
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
  },

  saveThreadsWidth(this: ChatPage, width: number): void {
    this.props.preferences?.edit({
      area: "chat",
      command: {
        kind: "set_fullscreen_chat_sidebar_width",
        widthPx: Math.round(clampThreadsWidth(width)),
      },
    });
  },

  flushThreadsWidth(this: ChatPage): void {
    if (this.sidebarSaveTimer === null) return;
    clearTimeout(this.sidebarSaveTimer);
    this.sidebarSaveTimer = null;
    this.saveThreadsWidth(this.state.threadsWidth);
  },

  chooseProject(this: ChatPage, project: Project): void {
    this.setState({ selectedProject: project });
  },

  async organizerSelect(
    this: ChatPage,
    conversationId: ConversationId | null,
  ): Promise<void> {
    await this.selectThread(conversationId, true);
  },

  async organizerRemoved(
    this: ChatPage,
    conversationId: ConversationId,
  ): Promise<void> {
    if (this.conversationId === conversationId)
      await this.selectThread(null, true);
  },

  renderProjectOverview(this: ChatPage): React.ReactNode {
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
  },

  async makeDefault(this: ChatPage, projectId: ProjectId): Promise<void> {
    try {
      await makeDefaultProject(this.props.organisationId, projectId);
      await this.refresh();
    } catch (error) {
      this.setState({
        error: errorMessage(error, "Could not change the default project."),
      });
    }
  },

  renderProjectChatLink(
    this: ChatPage,
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
  },

  async startProjectChat(
    this: ChatPage,
    projectId: ProjectId,
  ): Promise<void> {
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
  },

  renderThreadSidebar(this: ChatPage, history: boolean): React.ReactNode {
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
  },
};
