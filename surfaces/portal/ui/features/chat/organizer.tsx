import { chatThreadActivity } from "@purin-labs/control-api";
import { ConversationSharingDialog, type ConversationSharingIntent } from "./conversation-sharing";
import { ProjectSharing } from "./project-sharing";
import { isProjectId } from "@purin-labs/control-api";
import { newProjectId } from "@purin-labs/control-api";
import type { ConversationId, ProjectId } from "@purin-labs/control-api";
import React from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  LoaderCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ChatDestination,
  ChatInsertion,
  Project,
  ProjectContent,
  ProjectDirectory,
  ProjectReference,
} from "@purin-labs/control-api";
import { projectReferenceIdentity } from "@purin-labs/control-api";
import { assertNever, errorMessage } from "@purin-labs/std";
import { ActionMenu } from "@purin-labs/ui/action-menu";
import { DialogHeading, cancelDialog, syncDialog } from "@purin-labs/ui/dialog";
import { mutateChatDirectory, mutateProject, permanentlyDeleteChat, updateChatConversation, readProjectReferences, readChat } from "./api";
import type { Chat, ChatConversationSummary, ChatPageData, PendingChatDeletion } from "@purin-labs/control-api/portal/chat";
import { ThreadTitle } from "./thread-title";
import { ChatOriginLine } from "./origin-chips";
import "./organizer.css";

type Props = Readonly<{
  surface: "sidebar" | "history";
  organisationId: string;
  query: string;
  data: ChatPageData;
  basePath: string;
  selectedId: string | null;
  openingId: string | null;
  onSelect: (conversationId: ConversationId | null) => Promise<void>;
  /** The pointer rests on this row, and a click on it may follow. */
  onPreview: (conversationId: ConversationId) => void;
  onPreviewEnd: () => void;
  onChanged: () => Promise<void>;
  onRemoved: (conversationId: ConversationId) => Promise<void>;
  onProject: (project: Project) => void;
}>;
// Shown to a member who cannot open the Organisation's default Project. Its
// own name stays with the members who can.
const DEFAULT_PROJECT_LABEL = "Default project";

type DropPosition = Readonly<{
  destination: ChatDestination;
  insertion: ChatInsertion;
  label: string;
}>;
type PointerPosition = Readonly<{ x: number; y: number }>;
type DragState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "pressed";
      conversation: ChatConversationSummary;
      pointerId: number;
      origin: PointerPosition;
    }>
  | Readonly<{
      kind: "dragging";
      conversation: ChatConversationSummary;
      input: { kind: "pointer"; pointerId: number } | { kind: "keyboard" };
      target: DropPosition | null;
    }>;
type Editor =
  | Readonly<{ kind: "delete_project"; project: Project }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{
      kind: "project";
      project: Project | null;
      name: string;
      brief: string;
      references: readonly ProjectReference[];
      query: string;
      results: readonly ProjectReference[];
      loading: boolean;
    }>
  | Readonly<{
      kind: "rename";
      conversation: ChatConversationSummary;
      title: string;
    }>
  | Readonly<{
      kind: "delete";
      conversation: ChatConversationSummary;
      operationId: string;
    }>;
type Pagination =
  | Readonly<{ kind: "initial" }>
  | Readonly<{ kind: "loaded"; next: string | null }>;
type State = Readonly<{
  sharingIntent: ConversationSharingIntent | null;
  tab: "chats" | "archived";
  collapsed: ReadonlySet<string>;
  busy: string | null;
  drag: DragState;
  announcement: string;
  editor: Editor;
  error: string | null;
  extraActive: ChatPageData["conversations"];
  extraArchived: ChatPageData["archivedConversations"];
  activePagination: Pagination;
  archivedPagination: Pagination;
}>;

export class ChatOrganizer extends React.Component<Props, State> {
  state: State = {
    sharingIntent: null,
    tab: readOrganizerTab(this.props.organisationId),
    collapsed: collapsedProjects(this.props.data.projectDirectory),
    busy: null,
    drag: { kind: "idle" },
    announcement: "",
    editor: { kind: "closed" },
    error: null,
    extraActive: [],
    extraArchived: [],
    activePagination: { kind: "initial" },
    archivedPagination: { kind: "initial" },
  };
  private readonly dialog = React.createRef<HTMLDialogElement>();
  private readonly cancelButton = React.createRef<HTMLButtonElement>();
  private readonly list = React.createRef<HTMLElement>();
  private searchVersion = 0;
  private suppressPointerClick = false;
  private pointerPosition: PointerPosition | null = null;
  private pointerFrame: number | null = null;
  private pointerFrameAt: number | null = null;
  componentDidUpdate(previous: Props, previousState: State): void {
    if (
      this.state.drag.kind !== "dragging" ||
      this.state.drag.input.kind !== "pointer"
    )
      this.stopPointerFrames();
    if (
      previous.data.projectDirectory.revision !==
        this.props.data.projectDirectory.revision ||
      previous.query !== this.props.query
    )
      this.setState({
        collapsed: collapsedProjects(this.props.data.projectDirectory),
        extraActive: [],
        extraArchived: [],
        activePagination: { kind: "initial" },
        archivedPagination: { kind: "initial" },
      });
    syncDialog(this.dialog, this.state.editor.kind !== "closed");
    if (
      previousState.editor.kind !== "delete" &&
      this.state.editor.kind === "delete"
    )
      this.cancelButton.current?.focus({ preventScroll: true });
  }
  componentWillUnmount(): void {
    this.searchVersion += 1;
    this.stopPointerFrames();
  }

  private chooseTab(tab: State["tab"]): void {
    rememberOrganizerTab(this.props.organisationId, tab);
    this.setState({ tab, drag: { kind: "idle" } });
  }
  private tabKey(
    tab: State["tab"],
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    let target: State["tab"] = tab === "chats" ? "archived" : "chats";
    if (event.key === "Home") target = "chats";
    if (event.key === "End") target = "archived";
    this.chooseTab(target);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-tab="${target}"]`)
      ?.focus();
  }
  private async toggleProject(projectId: ProjectId): Promise<void> {
    if (this.state.busy !== null) return;
    const collapsed = new Set(this.state.collapsed);
    if (collapsed.has(projectId)) collapsed.delete(projectId);
    else collapsed.add(projectId);
    this.setState({ collapsed, busy: "project-placement" });
    try {
      const placement = this.props.data.projectDirectory.placements.find(projectPlacementHasId.bind(null, projectId));
      await mutateChatDirectory(this.props.organisationId, { kind: "set_project_placement", operationId: crypto.randomUUID(), expectedDirectoryRevision: this.props.data.projectDirectory.revision,
        projectId, position: placement?.position ?? this.props.data.projectDirectory.projects.findIndex(projectHasId.bind(null, projectId)), collapsed: collapsed.has(projectId) });
      await this.props.onChanged();
    } catch (error) {
      this.setState({ collapsed: collapsedProjects(this.props.data.projectDirectory) });
      toast.error(errorMessage(error, "Could not save project layout."));
    } finally { this.setState({ busy: null }); }
  }
  private openProjectDeletion(project: Project): void {
    this.setState({ editor: { kind: "delete_project", project }, error: null });
  }
  private openChat(
    conversationId: ConversationId | null,
    event: React.MouseEvent<HTMLAnchorElement>,
  ): void {
    if (this.suppressPointerClick && event.detail !== 0) {
      event.preventDefault();
      this.suppressPointerClick = false;
      return;
    }
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    void this.props.onSelect(conversationId);
  }
  private previewChat(
    conversationId: ConversationId,
    event: React.PointerEvent<HTMLAnchorElement>,
  ): void {
    if (event.pointerType === "mouse" && this.state.drag.kind === "idle")
      this.props.onPreview(conversationId);
  }
  private openEditor(project: Project | null): void {
    this.setState({
      editor: {
        kind: "project",
        project,
        name: project?.name ?? "",
        brief: project?.brief ?? "",
        references: project?.references ?? [],
        query: "",
        results: [],
        loading: false,
      },
      error: null,
    });
  }
  private closeEditor(): void {
    if (this.state.busy === null)
      this.setState({ editor: { kind: "closed" }, error: null });
  }
  private editField(
    field: "name" | "brief" | "title",
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void {
    const editor = this.state.editor;
    if (editor.kind === "project" && (field === "name" || field === "brief"))
      this.setState({
        editor: { ...editor, [field]: event.currentTarget.value },
      });
    if (editor.kind === "rename" && field === "title")
      this.setState({
        editor: { ...editor, title: event.currentTarget.value },
      });
  }
  private async searchReferences(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const editor = this.state.editor;
    if (editor.kind !== "project") return;
    const query = event.currentTarget.value;
    const version = ++this.searchVersion;
    this.setState({
      editor: { ...editor, query, results: [], loading: true },
      error: null,
    });
    try {
      const results = await readProjectReferences(
        this.props.organisationId,
        query,
      );
      if (
        version === this.searchVersion &&
        this.state.editor.kind === "project"
      )
        this.setState({
          editor: { ...this.state.editor, results, loading: false },
        });
    } catch (error) {
      if (
        version === this.searchVersion &&
        this.state.editor.kind === "project"
      )
        this.setState({
          editor: { ...this.state.editor, loading: false },
          error: errorMessage(error, "Could not search workspace references."),
        });
    }
  }
  private addReference(reference: ProjectReference): void {
    const editor = this.state.editor;
    if (
      editor.kind !== "project" ||
      editor.references.length >= 12 ||
      editor.references.some(sameReference.bind(null, reference))
    )
      return;
    this.setState({
      editor: { ...editor, references: [...editor.references, reference] },
    });
  }
  private removeReference(reference: ProjectReference): void {
    const editor = this.state.editor;
    if (editor.kind === "project")
      this.setState({
        editor: {
          ...editor,
          references: editor.references.filter(
            differentReference.bind(null, reference),
          ),
        },
      });
  }
  private async saveEditor(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const editor = this.state.editor;
    if (editor.kind === "closed" || this.state.busy !== null) return;
    this.setState({ busy: "editor", error: null });
    try {
      switch (editor.kind) {
        case "project": {
          const content: ProjectContent = {
            name: editor.name,
            brief: editor.brief,
            references: editor.references,
          };
          const common = { operationId: crypto.randomUUID(), content };
          await mutateProject(
            this.props.organisationId,
            editor.project === null
              ? {
                  kind: "create_project",
                  ...common,
                  projectId: newProjectId(),
                }
              : {
                  kind: "edit_project",
                  ...common,
                  projectId: editor.project.id,
                  expectedProjectRevision: editor.project.revision,
                },
          );
          break;
        }
        case "delete_project":
          await mutateProject(this.props.organisationId, { kind: "delete_project", operationId: crypto.randomUUID(),
            projectId: editor.project.id, expectedProjectRevision: editor.project.revision, expectedAccessRevision: editor.project.access.accessRevision });
          break;
        case "rename":
          await updateChatConversation(
            this.props.organisationId,
            editor.conversation.id,
            {
              kind: "rename",
              title: editor.title,
              expectedRevision: editor.conversation.revision,
            },
          );
          break;
        case "delete":
          toast.dismiss(
            `archive-${editor.conversation.id}-${editor.conversation.revision}`,
          );
          await permanentlyDeleteChat(
            this.props.organisationId,
            editor.conversation.id,
            editor.conversation.revision,
            editor.operationId,
          );
          await this.props.onRemoved(editor.conversation.id);
          break;
        default:
          assertNever(editor);
      }
      await this.props.onChanged();
      this.setState({ busy: null, editor: { kind: "closed" } });
    } catch (error) {
      this.setState({
        busy: null,
        error: errorMessage(
          error,
          "The directory changed. Refresh and try again.",
        ),
      });
      await this.props.onChanged();
    }
  }
  private rename(conversation: ChatConversationSummary): void {
    this.setState({
      editor: { kind: "rename", conversation, title: conversation.title },
      error: null,
    });
  }
  private confirmDelete(conversation: ChatConversationSummary): void {
    this.setState({
      editor: {
        kind: "delete",
        conversation,
        operationId: crypto.randomUUID(),
      },
      error: null,
    });
  }

  private async metadata(
    action: "pin" | "unpin" | "archive" | "restore",
    conversation: ChatConversationSummary,
  ): Promise<void> {
    if (this.state.busy !== null) return;
    const row = this.list.current?.querySelector<HTMLElement>(
      `[data-chat-row="${conversation.id}"]`,
    );
    const nextId =
      row?.nextElementSibling instanceof HTMLElement
        ? (row.nextElementSibling.dataset.chatRow ?? null)
        : null;
    this.setState({ busy: conversation.id });
    try {
      const result = await updateChatConversation(
        this.props.organisationId,
        conversation.id,
        action === "archive" || action === "restore"
          ? { kind: action, expectedRevision: conversation.revision }
          : action,
      );
      if (action === "restore")
        toast.dismiss(`archive-${conversation.id}-${conversation.revision}`);
      if (action === "archive") {
        toast.success(`Archived “${conversation.title}”`, {
          id: `archive-${conversation.id}-${result.revision}`,
          duration: Infinity,
          closeButton: true,
          classNames: { closeButton: "chat-archive-toast-close" },
          action: {
            label: "Undo",
            onClick: this.undoArchive.bind(this, result),
          },
        });
        await this.props.onRemoved(conversation.id);
      }
      await this.props.onChanged();
      if (action === "archive")
        requestAnimationFrame(this.focusAfterRemoval.bind(this, nextId));
      this.setState({
        busy: null,
        announcement: `${conversation.title}: ${action === "archive" ? "archived" : action === "restore" ? "restored" : action === "pin" ? "pinned" : "unpinned"}.`,
      });
    } catch (error) {
      this.setState({ busy: null });
      toast.error(errorMessage(error, "Could not update this chat."));
      await this.props.onChanged();
    }
  }
  private focusAfterRemoval(nextId: string | null): void {
    const list = this.list.current;
    if (list === null) return;
    const next =
      nextId === null
        ? null
        : list.querySelector<HTMLAnchorElement>(
            `[data-chat-row="${nextId}"] > a`,
          );
    if (next !== null) next.focus();
    else list.focus();
  }
  private async undoArchive(
    conversation: ChatConversationSummary,
  ): Promise<void> {
    await this.metadata("restore", conversation);
  }
  private async move(
    conversation: ChatConversationSummary,
    target: DropPosition,
  ): Promise<void> {
    if (this.state.busy !== null) return;
    const destination = target.destination;
    const priorProject = conversation.placement.projectId;
    if (destination.projectId === priorProject) {
      this.setState({ drag: { kind: "idle" } });
      return;
    }
    if (conversation.sharing.visibility === "shared" && !this.props.data.projectDirectory.projects.some(projectHasId.bind(null, destination.projectId))) {
      toast.error("Shared chats belong to a shared project. Choose another shared project.");
      this.setState({ drag: { kind: "idle" } });
      return;
    }
    if (destination.projectId !== priorProject) {
      const project = this.props.data.projectDirectory.projects.find(projectHasId.bind(null, destination.projectId));
      if (project?.access.kind === "shared") {
        if (conversation.sharing.visibility === "shared" && (conversation.sharing.role !== "owner" || project.access.role !== "owner")) {
          toast.error("Moving shared chats requires owner access in both projects.");
          this.setState({ drag: { kind: "idle" } });
          return;
        }
        this.setState({ sharingIntent: { kind: "move", conversation, project, insertion: target.insertion }, drag: { kind: "idle" } });
        return;
      }
      if (conversation.sharing.visibility === "shared") {
        toast.error("Shared chats can move to another shared project.");
        this.setState({ drag: { kind: "idle" } });
        return;
      }
    }
    this.setState({ busy: conversation.id, drag: { kind: "idle" } });
    try {
      await mutateChatDirectory(this.props.organisationId, {
        kind: "move_chat",
        operationId: crypto.randomUUID(),
        expectedDirectoryRevision: this.props.data.projectDirectory.revision,
        conversationId: conversation.id,
        expectedMembershipRevision: conversation.placement.membershipRevision,
        destination: target.destination,
        insertion: target.insertion,
      });
      await this.props.onChanged();
      this.setState({
        busy: null,
        announcement: `${conversation.title} moved ${target.label}.`,
      });
    } catch (error) {
      this.setState({ busy: null });
      toast.error(
        errorMessage(
          error,
          "The order changed in another window. Try the move again.",
        ),
      );
      await this.props.onChanged();
    }
  }
  private closeSharing(): void {
    const conversationId = this.state.sharingIntent?.conversation.id;
    this.setState({ sharingIntent: null }, this.focusSharingTrigger.bind(this, conversationId));
  }
  private focusSharingTrigger(conversationId: ConversationId | undefined): void {
    if (conversationId === undefined) return;
    this.list.current?.querySelector<HTMLButtonElement>(
      `[data-chat-row="${conversationId}"] .chat-organizer-actions button`,
    )?.focus({ preventScroll: true });
  }
  private shareInProject(conversation: ChatConversationSummary, project: Project): void {
    this.setState({ sharingIntent: { kind: "share", conversation, project, insertion: { kind: "end" } } });
  }
  private menuMove(
    conversation: ChatConversationSummary,
    project: Project | null,
  ): void {
    void this.move(conversation, {
      destination: this.groupDestination(project),
      insertion: { kind: "end" },
      label: `to ${project?.name ?? DEFAULT_PROJECT_LABEL}`,
    });
  }
  private startPointer(
    conversation: ChatConversationSummary,
    event: React.PointerEvent<HTMLAnchorElement>,
  ): void {
    this.suppressPointerClick = false;
    if (
      event.button !== 0 ||
      this.state.busy !== null ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    this.setState({
      drag: {
        kind: "pressed",
        conversation,
        pointerId: event.pointerId,
        origin: { x: event.clientX, y: event.clientY },
      },
    });
  }
  private pointerMove(event: React.PointerEvent<HTMLAnchorElement>): void {
    const drag = this.state.drag;
    if (drag.kind === "pressed") {
      if (
        drag.pointerId !== event.pointerId ||
        Math.hypot(
          event.clientX - drag.origin.x,
          event.clientY - drag.origin.y,
        ) < 6
      )
        return;
      this.suppressPointerClick = true;
      event.currentTarget.focus({ preventScroll: true });
      this.setState({
        drag: {
          kind: "dragging",
          conversation: drag.conversation,
          input: { kind: "pointer", pointerId: event.pointerId },
          target: null,
        },
        announcement: `Moving ${drag.conversation.title}.`,
      });
    } else if (
      drag.kind !== "dragging" ||
      drag.input.kind !== "pointer" ||
      drag.input.pointerId !== event.pointerId
    )
      return;
    this.pointerPosition = { x: event.clientX, y: event.clientY };
    this.schedulePointerFrame();
  }
  private schedulePointerFrame(): void {
    if (this.pointerFrame === null)
      this.pointerFrame = requestAnimationFrame(this.updatePointer.bind(this));
  }
  private updatePointer(timestamp: number): void {
    this.pointerFrame = null;
    const drag = this.state.drag;
    const point = this.pointerPosition;
    if (
      drag.kind !== "dragging" ||
      drag.input.kind !== "pointer" ||
      point === null
    )
      return;
    const list = this.list.current;
    let scrolled = false;
    if (list !== null) {
      const rect = list.getBoundingClientRect();
      if (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      ) {
        const velocity = pointerScrollVelocity(point.y, rect);
        const elapsed =
          this.pointerFrameAt === null
            ? 16
            : Math.min(32, timestamp - this.pointerFrameAt);
        const previousScroll = list.scrollTop;
        list.scrollTop += (velocity * elapsed) / 1000;
        scrolled = list.scrollTop !== previousScroll;
      }
    }
    const target = this.pointerTarget(point, drag.conversation.id);
    if (!samePosition(drag.target, target))
      this.setState({
        drag: { ...drag, target },
        announcement: target?.label ?? "",
      });
    this.pointerFrameAt = scrolled ? timestamp : null;
    if (scrolled) this.schedulePointerFrame();
  }
  private pointerTarget(
    point: PointerPosition,
    conversationId: ConversationId,
  ): DropPosition | null {
    const group = document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(".project-group");
    if (
      group === null ||
      group === undefined ||
      !this.list.current?.contains(group)
    )
      return null;
    const destination = destinationFromElement(group);
    if (destination === null) return null;
    // Chats show newest first, so a drop picks a Project, not a place in it.
    return {
      destination,
      insertion: { kind: "end" },
      label: `to ${group.dataset.chatGroupLabel}`,
    };
  }
  private stopPointerFrames(): void {
    if (this.pointerFrame !== null) cancelAnimationFrame(this.pointerFrame);
    this.pointerFrame = null;
    this.pointerFrameAt = null;
    this.pointerPosition = null;
  }
  private finishPointer(event: React.PointerEvent<HTMLAnchorElement>): void {
    const drag = this.state.drag;
    if (drag.kind === "pressed" && drag.pointerId === event.pointerId) {
      this.setState({ drag: { kind: "idle" } });
      return;
    }
    if (
      drag.kind !== "dragging" ||
      drag.input.kind !== "pointer" ||
      drag.input.pointerId !== event.pointerId
    )
      return;
    const target = this.pointerTarget(
      { x: event.clientX, y: event.clientY },
      drag.conversation.id,
    );
    this.stopPointerFrames();
    this.setState({ drag: { kind: "idle" } });
    if (target !== null) void this.move(drag.conversation, target);
  }
  private cancelDrag(): void {
    this.stopPointerFrames();
    this.setState({ drag: { kind: "idle" }, announcement: "Move cancelled." });
  }
  private lostPointerCapture(
    event: React.PointerEvent<HTMLAnchorElement>,
  ): void {
    const drag = this.state.drag;
    if (
      (drag.kind === "pressed" && drag.pointerId === event.pointerId) ||
      (drag.kind === "dragging" &&
        drag.input.kind === "pointer" &&
        drag.input.pointerId === event.pointerId)
    )
      this.cancelDrag();
  }
  private dragKey(
    conversation: ChatConversationSummary,
    event: React.KeyboardEvent<HTMLAnchorElement>,
  ): void {
    const drag = this.state.drag;
    if (event.key === "Escape") {
      if (drag.kind === "idle") return;
      event.preventDefault();
      this.cancelDrag();
      return;
    }
    if (drag.kind === "idle") {
      if (event.key !== " ") return;
      event.preventDefault();
      const target: DropPosition = {
        destination: placementDestination(conversation),
        insertion: { kind: "end" },
        label: `to ${this.groupLabel(conversation.placement.projectId)}`,
      };
      this.setState({
        drag: {
          kind: "dragging",
          conversation,
          input: { kind: "keyboard" },
          target,
        },
        announcement: `Moving ${conversation.title}. Use arrows to choose a project, Enter to drop, Escape to cancel.`,
      });
      return;
    }
    if (drag.kind !== "dragging" || drag.input.kind !== "keyboard") return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (drag.target !== null) void this.move(drag.conversation, drag.target);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const positions = this.dropPositions();
    const index = positions.findIndex(samePosition.bind(null, drag.target));
    const target =
      positions[
        Math.max(
          0,
          Math.min(
            positions.length - 1,
            index + (event.key === "ArrowDown" ? 1 : -1),
          ),
        )
      ];
    if (target !== undefined) {
      this.setState({ drag: { ...drag, target }, announcement: target.label });
      requestAnimationFrame(this.scrollInsertionIntoView.bind(this));
    }
  }
  private scrollInsertionIntoView(): void {
    this.list.current
      ?.querySelector(".chat-insertion-line")
      ?.scrollIntoView({ block: "nearest" });
  }
  /** Every active chat of a Project, pinned ones too, newest first. */
  private chatsIn(
    destination: ChatDestination,
  ): readonly ChatConversationSummary[] {
    return mergeChats(this.state.extraActive, this.props.data.conversations)
      .filter(inDestination.bind(null, destination))
      .slice()
      .sort(compareRecent);
  }
  /** A pinned chat shows one time, under its pin, so its Project leaves it out. */
  private rowsFor(
    chats: readonly ChatConversationSummary[],
  ): readonly ChatConversationSummary[] {
    const pinned = new Set(this.props.data.pinnedConversations.map(chatId));
    return nestSideCases(chats.filter(notIn.bind(null, pinned)));
  }
  /** One drop per Project: chats show newest first inside it. */
  private dropPositions(): DropPosition[] {
    const positions: DropPosition[] = [];
    for (const project of this.groups())
      positions.push({
        destination: this.groupDestination(project),
        insertion: { kind: "end" },
        label: `to ${project?.name ?? DEFAULT_PROJECT_LABEL}`,
      });
    return positions;
  }
  private groupLabel(projectId: string): string {
    return (
      this.props.data.projectDirectory.projects.find(
        projectHasId.bind(null, projectId),
      )?.name ?? DEFAULT_PROJECT_LABEL
    );
  }
  private insertionLine(
    destination: ChatDestination,
    insertion: ChatInsertion,
  ): React.ReactNode {
    const drag = this.state.drag;
    if (
      drag.kind !== "dragging" ||
      drag.target === null ||
      !samePosition({ destination, insertion, label: "" }, drag.target)
    )
      return null;
    return <div className="chat-insertion-line" aria-hidden="true" />;
  }
  private renderRow(
    conversation: ChatConversationSummary,
    shortcut = false,
    /** The top chat that this side Case came from, when it shows under it. */
    nestedUnder: ChatConversationSummary | null = null,
  ): React.ReactNode {
    const active = conversation.lifecycle === "active";
    const busy = this.state.busy === conversation.id;
    const sections = [
      {
        id: "actions",
        items: [
          {
            id: "pin",
            label: conversation.pinnedAt === null ? "Pin" : "Unpin",
            icon:
              conversation.pinnedAt === null ? (
                <Pin size={16} />
              ) : (
                <PinOff size={16} />
              ),
            onSelect: this.metadata.bind(
              this,
              conversation.pinnedAt === null ? "pin" : "unpin",
              conversation,
            ),
          },
          {
            id: "rename",
            label: "Rename",
            icon: <Pencil size={16} />,
            disabled: conversation.sharing.visibility === "shared" && conversation.sharing.role === "viewer",
            onSelect: this.rename.bind(this, conversation),
          },
        ],
      },
      {
        id: "projects",
        label: "Move to project",
        items: [
          ...this.props.data.projectDirectory.projects.map(
            projectMenuItem.bind(null, this.menuMove.bind(this), conversation),
          ),
          ...(this.defaultProjectIsOpen()
            ? []
            : [
                {
                  id: "default-project",
                  label: DEFAULT_PROJECT_LABEL,
                  disabled: conversation.sharing.visibility === "shared",
                  onSelect: this.menuMove.bind(this, conversation, null),
                },
              ]),
        ],
      },
    ];
    const project = this.props.data.projectDirectory.projects.find(projectHasId.bind(null, conversation.placement.projectId));
    if (conversation.sharing.visibility === "private" && project?.access.kind === "shared" && project.access.role !== "viewer") {
      sections[0]?.items.push({ id: "share", label: "Share with project", icon: <Users size={16} />, disabled: false,
        onSelect: this.shareInProject.bind(this, conversation, project) });
    }
    return (
      <React.Fragment key={`${shortcut ? "pin" : "chat"}-${conversation.id}`}>
        <div
          className="chat-organizer-row"
          data-side-case={nestedUnder === null ? undefined : "true"}
          data-chat-drop={active && !shortcut ? "true" : undefined}
          data-chat-row={conversation.id}
          data-dragging={
            this.state.drag.kind === "dragging" &&
            this.state.drag.conversation.id === conversation.id
          }
        >
          {shortcut ? (
            <span className="chat-pinned-marker" aria-hidden="true">
              <Pin size={13} />
            </span>
          ) : null}
          <a
            href={`${this.props.basePath}?conversation=${encodeURIComponent(conversation.id)}`}
            onClick={this.openChat.bind(this, conversation.id)}
            onPointerEnter={this.previewChat.bind(this, conversation.id)}
            onPointerLeave={this.props.onPreviewEnd}
            draggable={false}
            data-reorderable={active && !shortcut ? "true" : undefined}
            aria-describedby={
              active && !shortcut
                ? `chat-drag-help-${this.props.surface}`
                : undefined
            }
            onPointerDown={
              active && !shortcut
                ? this.startPointer.bind(this, conversation)
                : undefined
            }
            onPointerMove={this.pointerMove.bind(this)}
            onPointerUp={this.finishPointer.bind(this)}
            onPointerCancel={this.cancelDrag.bind(this)}
            onLostPointerCapture={this.lostPointerCapture.bind(this)}
            onKeyDown={
              active && !shortcut
                ? this.dragKey.bind(this, conversation)
                : undefined
            }
            onBlur={this.cancelKeyboardDrag.bind(this)}
            aria-current={
              this.props.selectedId === conversation.id ? "page" : undefined
            }
            aria-busy={this.props.openingId === conversation.id}
          >
            {nestedUnder === null ? null : (
              <span className="visually-hidden">
                Started from {nestedUnder.title}:{" "}
              </span>
            )}
            <span className="chat-organizer-name">
              <ThreadTitle title={conversation.title} />
              <ChatOriginLine origin={conversation.origin} />
            </span>
            {conversation.sharing.visibility === "shared" ? <Users size={13} aria-label="Shared chat" className="chat-shared-marker" /> : null}
            {this.props.openingId === conversation.id ? (
              <span
                className="chat-thread-indicator"
                role="img"
                aria-label="Opening"
              >
                <LoaderCircle
                  size={14}
                  className="chat-thread-spinner"
                  aria-hidden="true"
                />
              </span>
            ) : (
              <ChatThreadIndicator
                summary={conversation}
                selected={this.props.data.conversation}
              />
            )}
          </a>
          <div className="chat-organizer-actions">
            {active ? (
              <>
                <ActionMenu
                  className="project-menu"
                  label={`Actions for ${conversation.title}`}
                  trigger={
                    <button
                      type="button"
                      aria-label={`Actions for ${conversation.title}`}
                      disabled={busy}
                    >
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </button>
                  }
                  sections={sections}
                />
                <button
                  type="button"
                  aria-label={`Archive ${conversation.title}`}
                  title="Archive chat"
                  disabled={busy}
                  onClick={this.metadata.bind(this, "archive", conversation)}
                >
                  <Archive size={16} aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={`Restore ${conversation.title}`}
                  title="Restore chat"
                  disabled={busy}
                  onClick={this.metadata.bind(this, "restore", conversation)}
                >
                  <ArchiveRestore size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Permanently delete ${conversation.title}`}
                  title="Permanently delete chat"
                  disabled={busy || (conversation.sharing.visibility === "shared" && conversation.sharing.role !== "owner")}
                  onClick={this.confirmDelete.bind(this, conversation)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>
        {!active ? (
          <small className="chat-former-project">
            {this.projectName(conversation.placement.projectId)}
          </small>
        ) : null}
      </React.Fragment>
    );
  }
  private cancelKeyboardDrag(): void {
    if (
      this.state.drag.kind === "dragging" &&
      this.state.drag.input.kind === "keyboard"
    )
      this.cancelDrag();
  }
  private projectName(projectId: Project["id"]): string {
    return (
      this.props.data.projectDirectory.projects.find(
        projectHasId.bind(null, projectId),
      )?.name ??
      (projectId === this.props.data.projectDirectory.defaultProjectId
        ? DEFAULT_PROJECT_LABEL
        : "Unavailable project")
    );
  }
  private defaultProjectIsOpen(): boolean {
    return this.props.data.projectDirectory.projects.some(
      projectHasId.bind(null, this.props.data.projectDirectory.defaultProjectId),
    );
  }
  // A null group is the default Project of a member who cannot open it: their
  // own chats still land there, under a plain label.
  private groups(): readonly (Project | null)[] {
    return this.defaultProjectIsOpen()
      ? this.props.data.projectDirectory.projects
      : [...this.props.data.projectDirectory.projects, null];
  }
  private groupDestination(project: Project | null): ChatDestination {
    return {
      projectId:
        project?.id ?? this.props.data.projectDirectory.defaultProjectId,
    };
  }
  private renderGroup(project: Project | null): React.ReactNode {
    const destination = this.groupDestination(project);
    const id = destination.projectId;
    const isDefault =
      id === this.props.data.projectDirectory.defaultProjectId;
    const chats = this.chatsIn(destination);
    const rows = this.rowsFor(chats);
    const collapsed = project !== null && this.state.collapsed.has(id);
    // A Project whose only chat is pinned is not empty.
    const showEmptyState =
      !collapsed &&
      chats.length === 0 &&
      (project !== null || this.props.data.projectDirectory.projects.length === 0);
    return (
      <section
        className="project-group"
        key={id}
        aria-label={project?.name ?? DEFAULT_PROJECT_LABEL}
        data-project={id}
        data-default-project={isDefault ? "true" : undefined}
        data-chat-group-label={project?.name ?? DEFAULT_PROJECT_LABEL}
      >
        {project === null ? null : (
          <div className="project-heading">
            <button
              type="button"
              className="project-title"
              onClick={this.props.onProject.bind(null, project)}
            >
              <Folder size={15} aria-hidden="true" />
              <span title={project.name}>{project.name}</span>
              {isDefault ? <small className="project-default">Default</small> : null}
            </button>
            <button
              type="button"
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${project.name}`}
              aria-expanded={!collapsed}
              onClick={this.toggleProject.bind(this, project.id)}
            >
              {collapsed ? (
                <ChevronRight size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
            <ProjectSharing organisationId={this.props.organisationId} project={project} onChanged={this.props.onChanged} />
            <button
              type="button"
              className="project-edit"
              disabled={project.access.kind === "shared" && project.access.role === "viewer"}
              aria-label={`Edit ${project.name}`}
              title="Edit project"
              onClick={this.openEditor.bind(this, project)}
            >
              <Pencil size={14} />
            </button>
            {!isDefault && (project.access.kind === "personal" || project.access.role === "owner") ? (
              <button type="button" className="project-edit" aria-label={`Delete ${project.name}`} title="Delete project"
                onClick={this.openProjectDeletion.bind(this, project)}><Trash2 size={14} /></button>
            ) : null}
          </div>
        )}
        {collapsed ? null : this.renderGroupRows(rows)}
        {this.insertionLine(destination, { kind: "end" })}
        {showEmptyState ? (
          <div className="project-empty">No chats yet</div>
        ) : null}
      </section>
    );
  }
  private renderReference(reference: ProjectReference): React.ReactNode {
    return (
      <li key={JSON.stringify(reference)}>
        <span>{reference.label}</span>
        <button
          type="button"
          onClick={this.removeReference.bind(this, reference)}
          aria-label={`Remove ${reference.label}`}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </li>
    );
  }
  private renderReferenceResult(
    reference: ProjectReference,
  ): React.ReactNode {
    const editor = this.state.editor;
    const added =
      editor.kind === "project" &&
      editor.references.some(sameReference.bind(null, reference));
    return (
      <button
        type="button"
        key={JSON.stringify(reference)}
        disabled={
          editor.kind !== "project" || editor.references.length >= 12 || added
        }
        onClick={this.addReference.bind(this, reference)}
      >
        <span>{reference.label}</span>
        {added ? (
          <>
            <Check size={14} aria-hidden="true" />
            <span className="sr-only">Added</span>
          </>
        ) : (
          <Plus size={14} aria-hidden="true" />
        )}
      </button>
    );
  }
  private renderEditor(): React.ReactNode {
    const editor = this.state.editor;
    const title =
      editor.kind === "project"
        ? editor.project === null
          ? "Create project"
          : "Edit project"
        : editor.kind === "rename"
          ? "Rename chat"
          : editor.kind === "delete_project" ? "Delete project" : "Permanently delete chat";
    return (
      <dialog
        ref={this.dialog}
        className="project-dialog"
        aria-labelledby={`project-dialog-title-${this.props.surface}`}
        onCancel={cancelDialog.bind(null, this.closeEditor.bind(this))}
      >
        <DialogHeading
          id={`project-dialog-title-${this.props.surface}`}
          title={title}
          close={this.closeEditor.bind(this)}
        />
        <form onSubmit={this.saveEditor.bind(this)}>
          {editor.kind === "project" ? (
            <>
              <label>
                Project name
                <input
                  required
                  maxLength={120}
                  value={editor.name}
                  onChange={this.editField.bind(this, "name")}
                />
              </label>
              <label>
                Brief
                <textarea
                  rows={5}
                  aria-describedby={`project-brief-hint-${this.props.surface}`}
                  maxLength={4000}
                  value={editor.brief}
                  onChange={this.editField.bind(this, "brief")}
                />
              </label>
              <p className="project-hint" id={`project-brief-hint-${this.props.surface}`}>
                Working defaults for chats in this project. Workspace
                permissions still apply.
              </p>
              <label>
                Workspace references
                <input
                  type="search"
                  aria-describedby={`project-reference-hint-${this.props.surface}`}
                  placeholder="Search saved runs and workspace records"
                  value={editor.query}
                  onChange={this.searchReferences.bind(this)}
                />
              </label>
              <p className="project-hint" id={`project-reference-hint-${this.props.surface}`}>
                Sources are read when needed. {editor.references.length} of 12
                references added.
              </p>
              {editor.loading ? (
                <p className="project-hint" role="status">
                  Searching…
                </p>
              ) : null}
              {!editor.loading &&
              editor.query.trim().length > 0 &&
              editor.results.length === 0 &&
              this.state.error === null ? (
                <p className="project-hint" role="status">
                  No matching references. Try another search.
                </p>
              ) : null}
              <div
                className="chat-reference-results"
                aria-busy={editor.loading}
              >
                {editor.results.map(this.renderReferenceResult.bind(this))}
              </div>
              <ul
                className="project-references"
                aria-label="Added references"
              >
                {editor.references.map(this.renderReference.bind(this))}
              </ul>
            </>
          ) : editor.kind === "rename" ? (
            <label>
              Chat name
              <input
                required
                maxLength={120}
                value={editor.title}
                onChange={this.editField.bind(this, "title")}
              />
            </label>
          ) : editor.kind === "delete_project" ? (
            <div className="chat-delete-description"><p>Delete <strong>“{editor.project.name}”</strong>?</p>
              <p>Private chats return to the default project. Shared chats must be moved or permanently deleted first.</p><p>This cannot be undone.</p></div>
          ) : editor.kind === "delete" ? (
            <div className="chat-delete-description">
              <p>
                Delete <strong>“{editor.conversation.title}”</strong>{" "}
                permanently?
              </p>
              <p>
                Its chat history, private session data, and chats forked from it will be removed.
                Linked workspace records and Case evidence are kept separately.
              </p>
              <p>This cannot be undone.</p>
            </div>
          ) : null}
          {this.state.error === null ? null : (
            <p role="alert">{this.state.error}</p>
          )}
          <div className="project-dialog-actions">
            <button
              type="button"
              ref={this.cancelButton}
              disabled={this.state.busy !== null}
              onClick={this.closeEditor.bind(this)}
            >
              Cancel
            </button>
            <button
              className={editor.kind === "delete" || editor.kind === "delete_project" ? "danger" : "primary-button"}
              type="submit"
              disabled={this.state.busy !== null}
            >
              {this.state.busy !== null
                ? editor.kind === "delete" || editor.kind === "delete_project"
                  ? "Deleting…"
                  : "Saving…"
                : editor.kind === "delete" || editor.kind === "delete_project"
                  ? "Delete permanently"
                  : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    );
  }
  render(): React.ReactNode {
    const pinned = this.props.data.pinnedConversations;
    return (
      <>
        <div className="chat-directory-bar">
          <div
            className="chat-directory-tabs"
            role="tablist"
            aria-label="Chat directory"
          >
            <button
              type="button"
              role="tab"
              data-tab="chats"
              aria-selected={this.state.tab === "chats"}
              tabIndex={this.state.tab === "chats" ? 0 : -1}
              onClick={this.chooseTab.bind(this, "chats")}
              onKeyDown={this.tabKey.bind(this, "chats")}
            >
              Chats
            </button>
            <button
              type="button"
              role="tab"
              data-tab="archived"
              aria-selected={this.state.tab === "archived"}
              tabIndex={this.state.tab === "archived" ? 0 : -1}
              onClick={this.chooseTab.bind(this, "archived")}
              onKeyDown={this.tabKey.bind(this, "archived")}
            >
              Archived
            </button>
          </div>
          {this.state.tab === "chats" ? (
            <div className="chat-directory-tools">
              <button
                type="button"
                aria-label="Project"
                title="Create project"
                onClick={this.openEditor.bind(this, null)}
              >
                <FolderPlus size={16} aria-hidden="true" />
                <span>Project</span>
              </button>
            </div>
          ) : null}
        </div>
        <p id={`chat-drag-help-${this.props.surface}`} className="sr-only">
          Press Space to pick up, arrows to choose a project, Enter to drop,
          Escape to cancel.
        </p>
        <p className="sr-only" role="status">
          {this.state.announcement}
        </p>
        <nav
          ref={this.list}
          tabIndex={-1}
          className="chat-thread-list chat-organizer-list"
          aria-label={
            this.state.tab === "chats" ? "Chat threads" : "Archived chats"
          }
        >
          {this.state.tab === "chats" ? (
            <>
              {pinned.length === 0 ? null : (
                <section className="chat-pinned-rows" aria-label="Pinned chats">
                  {pinned.map(renderPinnedRow.bind(null, this))}
                </section>
              )}
              {this.groups().map(this.renderGroup.bind(this))}
            </>
          ) : (
            this.renderArchived()
          )}
        </nav>
        {this.nextCursor() === null ? null : (
          <button
            className="chat-directory-load-more"
            type="button"
            disabled={this.state.busy !== null}
            onClick={this.loadMore.bind(this)}
          >
            {this.state.busy === "pagination" ? "Loading…" : "Load more chats"}
          </button>
        )}
        <ConversationSharingDialog organisationId={this.props.organisationId} intent={this.state.sharingIntent} close={this.closeSharing.bind(this)} onChanged={this.props.onChanged} />
      {this.renderEditor()}
      </>
    );
  }
  private renderArchived(): React.ReactNode {
    const conversations = mergeChats(
      this.state.extraArchived,
      this.props.data.archivedConversations,
    );
    const deletions = this.props.data.pendingDeletions;
    if (conversations.length === 0 && deletions.length === 0)
      return <p className="chat-history-empty">No archived chats.</p>;
    return (
      <>
        {conversations.map(renderOrganizerRow.bind(null, this))}
        {deletions.map(this.renderPendingDeletion.bind(this))}
      </>
    );
  }
  private renderPendingDeletion(
    deletion: PendingChatDeletion,
  ): React.ReactNode {
    return (
      <div className="chat-history-empty" key={deletion.conversationId}>
        <strong>{deletion.title}</strong>
        <p>
          {deletion.kind === "failed"
            ? "Deletion did not finish."
            : "Deletion is in progress."}
        </p>
        <button
          type="button"
          disabled={this.state.busy !== null}
          onClick={this.retryDeletion.bind(this, deletion)}
        >
          Retry deletion
        </button>
      </div>
    );
  }
  private async retryDeletion(deletion: PendingChatDeletion): Promise<void> {
    this.setState({ busy: deletion.conversationId });
    try {
      await permanentlyDeleteChat(
        this.props.organisationId,
        deletion.conversationId,
        deletion.expectedRevision,
        deletion.operationId,
      );
      await this.props.onChanged();
      toast.success(`Deleted “${deletion.title}”.`);
    } catch (error) {
      toast.error(
        errorMessage(error, "Deletion did not finish. Retry deletion."),
      );
      await this.props.onChanged();
    } finally {
      this.setState({ busy: null });
    }
  }
  private nextCursor(): string | null {
    const pagination =
      this.state.tab === "chats"
        ? this.state.activePagination
        : this.state.archivedPagination;
    if (pagination.kind === "loaded") return pagination.next;
    return this.state.tab === "chats"
      ? this.props.data.nextActiveCursor
      : this.props.data.nextArchivedCursor;
  }
  private async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (this.state.busy !== null || cursor === null) return;
    const tab = this.state.tab;
    const revision = this.props.data.projectDirectory.revision;
    const query = this.props.query;
    const cursors =
      tab === "chats"
        ? { active: cursor, archived: null }
        : { active: null, archived: cursor };
    this.setState({ busy: "pagination" });
    try {
      const page = await readChat(
        this.props.organisationId,
        null,
        query,
        "observe",
        cursors,
      );
      if (
        revision !== page.projectDirectory.revision ||
        revision !== this.props.data.projectDirectory.revision ||
        query !== this.props.query
      ) {
        this.setState({ busy: null });
        await this.props.onChanged();
        return;
      }
      if (tab === "chats")
        this.setState({
          busy: null,
          extraActive: mergeChats(this.state.extraActive, page.conversations),
          activePagination: { kind: "loaded", next: page.nextActiveCursor },
        });
      else
        this.setState({
          busy: null,
          extraArchived: mergeChats(
            this.state.extraArchived,
            page.archivedConversations,
          ),
          archivedPagination: { kind: "loaded", next: page.nextArchivedCursor },
        });
    } catch (error) {
      this.setState({ busy: null });
      toast.error(errorMessage(error, "Could not load more chats."));
    }
  }
  renderChatRow(
    conversation: ChatConversationSummary,
    shortcut: boolean,
  ): React.ReactNode {
    return this.renderRow(conversation, shortcut);
  }
  /** A group's rows: each side Case one level in, under its source chat. */
  private renderGroupRows(
    rows: readonly ChatConversationSummary[],
  ): React.ReactNode {
    const parents = sideCaseParents(rows);
    return rows.map((row) =>
      this.renderRow(row, false, parents.get(row.id) ?? null),
    );
  }
}

function readOrganizerTab(organisationId: string): State["tab"] {
  try {
    return sessionStorage.getItem(`pantry:chat-tab:${organisationId}`) === "archived"
      ? "archived"
      : "chats";
  } catch {
    return "chats";
  }
}
function rememberOrganizerTab(organisationId: string, tab: State["tab"]): void {
  try {
    sessionStorage.setItem(`pantry:chat-tab:${organisationId}`, tab);
  } catch {
    // Storage restrictions do not prevent switching tabs in the open panel.
  }
}
function renderOrganizerRow(
  organizer: ChatOrganizer,
  conversation: ChatConversationSummary,
): React.ReactNode {
  return organizer.renderChatRow(conversation, false);
}
function renderPinnedRow(
  organizer: ChatOrganizer,
  conversation: ChatConversationSummary,
): React.ReactNode {
  return organizer.renderChatRow(conversation, true);
}
function projectHasId(id: string, project: Project): boolean {
  return project.id === id;
}
function placementDestination(
  conversation: ChatConversationSummary,
): ChatDestination {
  return { projectId: conversation.placement.projectId };
}
function inDestination(
  destination: ChatDestination,
  conversation: ChatConversationSummary,
): boolean {
  return conversation.placement.projectId === destination.projectId;
}
function chatId(conversation: ChatConversationSummary): string {
  return conversation.id;
}
function notIn(
  ids: ReadonlySet<string>,
  conversation: ChatConversationSummary,
): boolean {
  return !ids.has(conversation.id);
}
/**
 * Places each side Case right under the top chat that it came from, when that
 * chat is in the same list (Plan 74). The sidebar has one level: a side Case
 * of a side Case shows under the top chat too. Every other row keeps its
 * place, and a side Case whose source chat is not in the list is a normal row.
 */
function nestSideCases<T extends ChatConversationSummary>(
  rows: readonly T[],
): readonly T[] {
  const parents = sideCaseParents(rows);
  const children = new Map<string, T[]>();
  for (const row of rows) {
    const parent = parents.get(row.id);
    if (parent === undefined) continue;
    const list = children.get(parent.id) ?? [];
    list.push(row);
    children.set(parent.id, list);
  }
  const ordered: T[] = [];
  for (const row of rows)
    if (!parents.has(row.id))
      ordered.push(row, ...(children.get(row.id) ?? []));
  return ordered;
}

/** The top chat in `rows` that each side Case in `rows` came from. */
function sideCaseParents<T extends ChatConversationSummary>(
  rows: readonly T[],
): ReadonlyMap<string, T> {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.id, row);
  const parents = new Map<string, T>();
  for (const row of rows) {
    let top: T | null = null;
    const seen = new Set<string>([row.id]);
    let next = row.parentConversationId;
    while (next !== null && !seen.has(next)) {
      const parent = byId.get(next);
      if (parent === undefined) break;
      top = parent;
      seen.add(next);
      next = parent.parentConversationId;
    }
    if (top !== null) parents.set(row.id, top);
  }
  return parents;
}

/** The chat with the latest turn comes first. */
function compareRecent(
  a: ChatConversationSummary,
  b: ChatConversationSummary,
): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}
function samePosition(a: DropPosition | null, b: DropPosition | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.destination.projectId === b.destination.projectId &&
    a.insertion.kind === b.insertion.kind &&
    (a.insertion.kind === "end" ||
      (b.insertion.kind === "before" &&
        a.insertion.conversationId === b.insertion.conversationId))
  );
}
function pointerScrollVelocity(y: number, rect: DOMRect): number {
  if (y < rect.top + 40) return -400 * (1 - (y - rect.top) / 40);
  if (y > rect.bottom - 40) return 400 * (1 - (rect.bottom - y) / 40);
  return 0;
}
function destinationFromElement(element: HTMLElement): ChatDestination | null {
  const projectId = element.dataset.project;
  return isProjectId(projectId) ? { projectId } : null;
}
function projectMenuItem(
  move: (
    conversation: ChatConversationSummary,
    project: Project | null,
  ) => void,
  conversation: ChatConversationSummary,
  project: Project,
) {
  return {
    id: project.id,
    label: project.name,
    disabled: conversation.sharing.visibility === "shared" && (conversation.sharing.role !== "owner" || project.access.kind !== "shared" || project.access.role !== "owner"),
    onSelect: move.bind(null, conversation, project),
  };
}
function sameReference(
  a: ProjectReference,
  b: ProjectReference,
): boolean {
  return projectReferenceIdentity(a) === projectReferenceIdentity(b);
}
function differentReference(
  a: ProjectReference,
  b: ProjectReference,
): boolean {
  return !sameReference(a, b);
}

function mergeChats<T extends ChatConversationSummary>(
  previous: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  const chats = new Map<string, T>();
  for (const chat of previous) chats.set(chat.id, chat);
  for (const chat of incoming) chats.set(chat.id, chat);
  return [...chats.values()];
}


function collapsedProjects(directory: ProjectDirectory): ReadonlySet<string> {
  return new Set(directory.placements.filter(isCollapsedPlacement).map(projectPlacementId));
}
function isCollapsedPlacement(placement: ProjectDirectory["placements"][number]): boolean { return placement.collapsed; }
function projectPlacementId(placement: ProjectDirectory["placements"][number]): string { return placement.projectId; }
function projectPlacementHasId(projectId: ProjectId, placement: ProjectDirectory["placements"][number]): boolean { return placement.projectId === projectId; }

function ChatThreadIndicator({
  summary,
  selected,
}: Readonly<{
  summary: ChatConversationSummary;
  selected: Chat | null;
}>): React.ReactNode {
  const current =
    selected?.id === summary.id && selected.revision >= summary.revision
      ? selected
      : null;
  const activity =
    current === null ? summary.activity : chatThreadActivity(current.work.kind);
  if (activity === "working") {
    return (
      <span className="chat-thread-indicator" role="img" aria-label="Working">
        <LoaderCircle
          size={14}
          className="chat-thread-spinner"
          aria-hidden="true"
        />
      </span>
    );
  }
  const unread =
    (current?.latestSequence ?? summary.latestSequence) >
    (current?.lastReadSequence ?? summary.lastReadSequence);
  if (!unread) return null;
  return (
    <span
      className="chat-thread-indicator"
      role="img"
      aria-label={activity === "idle" ? "Reply ready · Unread" : "Unread"}
    >
      <span className="chat-unread-dot" />
    </span>
  );
}
