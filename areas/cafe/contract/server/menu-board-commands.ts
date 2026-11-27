import type {
  MenuBoardCommentThread,
  MenuBoardVersionSummary,
} from "@purin-labs/control-api";
import type {
  MenuBoardRelease,
  MenuBoardSummary,
  MenuScreenSummary,
} from "@purin-labs/cafe-control-api";
import type {
  MenuBoardLayout,
  MenuBoardStart,
} from "@purin-labs/menu-board-crdt";
import type { PlacedActorRpc } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";

/**
 * The board and screen commands that the Organisation Actor runs for its
 * control routes and its screens (Plan 40B phase 1). The routes check the
 * caller's role; a screen command checks the screen's own secret here.
 */
export type MenuBoardCommand =
  | Readonly<{ kind: "list_boards" }>
  | Readonly<{
      kind: "create_board";
      title: string;
      layout: MenuBoardLayout;
      start?: MenuBoardStart;
      userId: UserId;
    }>
  | Readonly<{
      kind: "publish_board";
      boardId: string;
      documentRevision: number;
      expectedReleaseRevision: number | null;
      userId: UserId;
    }>
  | Readonly<{ kind: "list_screens" }>
  | Readonly<{
      kind: "pair_screen";
      screenId: string;
      secret: string;
      name: string;
      boardId: string;
      userId: UserId;
    }>
  | Readonly<{ kind: "assign_screen"; screenId: string; boardId: string }>
  | Readonly<{ kind: "remove_screen"; screenId: string }>
  | Readonly<{ kind: "screen_feed"; screenId: string; secret: string }>
  | Readonly<{ kind: "published_media"; mediaId: string }>
  // Plan 40B, board removal: archive or restore, and the boards that show
  // a library image before a person deletes it.
  | Readonly<{
      kind: "set_board_archived";
      boardId: string;
      archived: boolean;
      userId: UserId;
    }>
  | Readonly<{ kind: "media_on_boards"; mediaId: string }>
  // Plan 40B phase 5, slice 6: comments pinned to a board's elements.
  | Readonly<{ kind: "list_comments"; boardId: string; userId: UserId }>
  | Readonly<{
      kind: "add_comment";
      boardId: string;
      elementId: string | null;
      threadId: string | null;
      body: string;
      operationId: string;
      userId: UserId;
    }>
  | Readonly<{
      kind: "resolve_comment";
      boardId: string;
      threadId: string;
      resolved: boolean;
      userId: UserId;
    }>
  | Readonly<{
      kind: "delete_comment";
      boardId: string;
      commentId: string;
      userId: UserId;
    }>
  // Plan 40B phase 5, slice 7: the board's versions.
  | Readonly<{ kind: "list_versions"; boardId: string }>
  | Readonly<{
      kind: "save_version" | "restore_version";
      boardId: string;
      /** The name of a new version, or the version to restore. */
      value: string;
      operationId: string;
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>;

export type MenuBoardVersionsResult = Result<
  Readonly<{ versions: readonly MenuBoardVersionSummary[] }>,
  MenuBoardEditError
>;

export type MenuBoardCommentsResult = Result<
  Readonly<{ threads: readonly MenuBoardCommentThread[] }>,
  MenuBoardEditError
>;

type MenuScreenFeedRead = Readonly<{
  screen: Readonly<{ screenId: string; name: string }>;
  release: MenuBoardRelease | null;
}>;

/** The result of each command kind. */
export type MenuBoardCommandResults = Readonly<{
  list_boards: Result<
    Readonly<{
      boards: readonly MenuBoardSummary[];
      archivedBoards: readonly ArchivedMenuBoard[];
    }>,
    never
  >;
  set_board_archived: MenuBoardArchiveResult;
  media_on_boards: Result<Readonly<{ boards: readonly string[] }>, never>;
  create_board: Result<
    MenuBoardSummary,
    Readonly<{ code: "menu_board_limit" | "menu_board_unavailable" }>
  >;
  publish_board: MenuBoardPublication;
  published_media: Result<Readonly<{ named: boolean }>, never>;
  list_screens: Result<
    Readonly<{ screens: readonly MenuScreenSummary[] }>,
    never
  >;
  pair_screen: Result<
    Readonly<{ screenId: string }>,
    Readonly<{ code: "menu_board_missing" | "menu_screen_limit" }>
  >;
  assign_screen: Result<
    Readonly<{ screenId: string }>,
    Readonly<{ code: "menu_board_missing" | "menu_screen_missing" }>
  >;
  remove_screen: Result<
    Readonly<{ screenId: string }>,
    Readonly<{ code: "menu_screen_missing" }>
  >;
  screen_feed: Result<
    MenuScreenFeedRead,
    Readonly<{ code: "menu_screen_refused" }>
  >;
  list_comments: MenuBoardCommentsResult;
  add_comment: MenuBoardCommentsResult;
  resolve_comment: MenuBoardCommentsResult;
  delete_comment: MenuBoardCommentsResult;
  list_versions: MenuBoardVersionsResult;
  save_version: MenuBoardVersionsResult;
  restore_version: MenuBoardVersionsResult;
}>;

export type MenuBoardCommandResult<C extends MenuBoardCommand> =
  MenuBoardCommandResults[C["kind"]];

/** What the Actor answers: the result, or a refusal before the command ran. */
export type MenuBoardCommandReply<C extends MenuBoardCommand> =
  | MenuBoardCommandResult<C>
  | Result<never, Readonly<{ code: "organisation_placement_conflict" }>>;

export type MenuBoardCommentError = Readonly<{
  code:
    | "menu_board_comment_missing"
    | "menu_board_comment_limit"
    | "menu_board_comment_invalid"
    | "menu_board_comment_not_author";
}>;

export type MenuBoardEditError = Readonly<{
  code:
    | "menu_board_missing"
    | "menu_board_unavailable"
    | "menu_board_element_missing"
    | "menu_board_text_changed"
    | "menu_board_edit_invalid"
    | MenuBoardCommentError["code"]
    | "menu_board_version_missing"
    | "menu_board_version_invalid"
    | "organisation_placement_conflict"
    | "access_revoked"
    | "room_full"
    | "stored_access_ended";
  current?: string;
}>;

export type ArchivedMenuBoard = Readonly<{
  boardId: string;
  title: string;
  archivedAt: number;
}>;

export type MenuBoardPublication = Result<
  Readonly<{ release: MenuBoardRelease; replayed: boolean }>,
  | Readonly<{ code: "menu_board_missing" | "menu_board_unavailable" }>
  | Readonly<{ code: "menu_board_changed"; documentRevision: number }>
  | Readonly<{
      code: "menu_board_release_conflict";
      releaseRevision: number | null;
    }>
  | Readonly<{ code: "menu_board_empty" | "menu_board_unplaced" }>
  | Readonly<{ code: "menu_board_media_unavailable" }>
  | Readonly<{
      code: "menu_board_binding_missing";
      elementIds: readonly string[];
    }>
>;

export type MenuBoardArchiveResult = Result<
  Readonly<{
    boardId: string;
    archived: boolean;
    /** The active boards after the change. */
    boards: number;
    archivedBoards: readonly ArchivedMenuBoard[];
  }>,
  Readonly<
    | { code: "menu_board_missing" | "menu_board_limit"; screens?: never }
    | { code: "menu_board_on_screen"; screens: number }
  >
>;

/**
 * The RPC methods of the Organisation Actor that run a board or screen
 * command and that tell the shop's screens to read their feed again. The
 * Café and Commerce call them. `OrganisationDO`, the class of the Worker,
 * implements this interface, and the callers name it, not the class.
 */
export interface OrganisationMenuBoardRpc {
  menuBoardCommand(
    input: Readonly<{
      organisationId: OrganisationId;
      command: MenuBoardCommand;
    }>,
  ): Promise<MenuBoardCommandReply<MenuBoardCommand>>;
  /** The number of screens that the signal reached. */
  signalMenuScreens(
    input: Readonly<{ organisationId: OrganisationId }>,
  ): Promise<number>;
}

/** The Organisation Actor as a board or screen caller sees it. */
export type MenuBoardOrganisationActor = PlacedActorRpc &
  OrganisationMenuBoardRpc;
