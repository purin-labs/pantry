import type {
  MenuBoardCommentThread,
  MenuBoardVersionSummary,
  MenuBoardRelease,
  MenuBoardSummary,
  MenuScreenSummary,
} from "@seams/control-api";
import type { MenuBoardLayout, MenuBoardStart } from "@seams/menu-board-crdt";
import type { MenuDraftSnapshot } from "@seams/menu-draft-crdt";

import type { ControlSessionId, UserId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import type { ArchivedMenuBoard } from "./menu-board-archive";
import type {
  MenuBoardArchiveResult,
  MenuBoardEditError,
  MenuBoardPublication,
  MenuBoardRooms,
} from "./menu-boards";
import type { MenuDraftRooms } from "./menu-draft";
import type { MenuScreens } from "./menu-screens";

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

type MenuBoardVersionsResult = Result<
  Readonly<{ versions: readonly MenuBoardVersionSummary[] }>,
  MenuBoardEditError
>;

type MenuBoardCommentsResult = Result<
  Readonly<{ threads: readonly MenuBoardCommentThread[] }>,
  MenuBoardEditError
>;

type MenuScreenFeedRead = Readonly<{
  screen: Readonly<{ screenId: string; name: string }>;
  release: MenuBoardRelease | null;
}>;

/** The result of each command kind. */
type MenuBoardCommandResults = Readonly<{
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

type Parts = Readonly<{
  boards: MenuBoardRooms;
  screens: MenuScreens;
  drafts: MenuDraftRooms;
  /** The shop's media address, read only when a board with an image publishes. */
  mediaBase: () => Promise<string | null>;
}>;

export function runMenuBoardCommand<C extends MenuBoardCommand>(
  parts: Parts,
  command: C,
  now: number,
  scope: OrganisationExecutionScope,
): Promise<MenuBoardCommandResult<C>> {
  return runCommand(parts, command, now, scope) as Promise<
    MenuBoardCommandResult<C>
  >;
}

async function runCommand(
  parts: Parts,
  command: MenuBoardCommand,
  now: number,
  scope: OrganisationExecutionScope,
): Promise<MenuBoardCommandResults[MenuBoardCommand["kind"]]> {
  switch (command.kind) {
    case "list_boards":
      return {
        ok: true,
        value: {
          boards: parts.boards.list(parts.screens.countByBoard()),
          archivedBoards: parts.boards.archivedBoards(),
        },
      };
    case "set_board_archived":
      return parts.boards.setArchived({
        organisationId: scope.organisationId,
        boardId: command.boardId,
        archived: command.archived,
        screens: parts.screens.countByBoard().get(command.boardId) ?? 0,
        userId: command.userId,
        now,
      });
    case "media_on_boards":
      return {
        ok: true,
        value: { boards: parts.boards.boardsShowingMedia(command.mediaId) },
      };
    case "create_board":
      return parts.boards.create({
        title: command.title,
        layout: command.layout,
        ...(command.start === undefined ? {} : { start: command.start }),
        menu: menuSnapshot(parts.drafts),
        userId: command.userId,
        now,
      });
    case "publish_board": {
      const published = await parts.boards.publish({
        boardId: command.boardId,
        documentRevision: command.documentRevision,
        expectedReleaseRevision: command.expectedReleaseRevision,
        menu: menuSnapshot(parts.drafts),
        mediaBase: parts.mediaBase,
        userId: command.userId,
        now,
      });
      if (published.ok && !published.value.replayed)
        parts.screens.signal({ kind: "board", boardId: command.boardId });
      return published;
    }
    case "list_screens":
      return { ok: true, value: { screens: parts.screens.list() } };
    case "published_media":
      return {
        ok: true,
        value: { named: parts.boards.namesPublishedMedia(command.mediaId) },
      };
    case "pair_screen": {
      if (!parts.boards.exists(command.boardId))
        return { ok: false, error: { code: "menu_board_missing" } };
      const paired = await parts.screens.pair({
        screenId: command.screenId,
        secret: command.secret,
        name: command.name,
        boardId: command.boardId,
        userId: command.userId,
        now,
      });
      return paired === "paired"
        ? { ok: true, value: { screenId: command.screenId } }
        : { ok: false, error: { code: "menu_screen_limit" } };
    }
    case "assign_screen":
      if (!parts.boards.exists(command.boardId))
        return { ok: false, error: { code: "menu_board_missing" } };
      return parts.screens.assign(command.screenId, command.boardId)
        ? { ok: true, value: { screenId: command.screenId } }
        : { ok: false, error: { code: "menu_screen_missing" } };
    case "remove_screen":
      return parts.screens.remove(command.screenId, now)
        ? { ok: true, value: { screenId: command.screenId } }
        : { ok: false, error: { code: "menu_screen_missing" } };
    case "screen_feed": {
      const screen = await parts.screens.verify(
        command.screenId,
        command.secret,
      );
      if (screen === null)
        return { ok: false, error: { code: "menu_screen_refused" } };
      parts.screens.seen(screen.screenId, now);
      return {
        ok: true,
        value: {
          screen: { screenId: screen.screenId, name: screen.name },
          release: parts.boards.latestRelease(screen.boardId),
        },
      };
    }
    case "list_comments":
      return threads(parts.boards.comments(command.boardId, command.userId));
    case "add_comment":
      return threads(
        await parts.boards.addComment({
          boardId: command.boardId,
          elementId: command.elementId,
          threadId: command.threadId,
          body: command.body,
          operationId: command.operationId,
          userId: command.userId,
          now,
        }),
      );
    case "resolve_comment":
      return threads(
        await parts.boards.resolveComment({
          boardId: command.boardId,
          threadId: command.threadId,
          resolved: command.resolved,
          userId: command.userId,
          now,
        }),
      );
    case "delete_comment":
      return threads(
        parts.boards.deleteComment({
          boardId: command.boardId,
          commentId: command.commentId,
          userId: command.userId,
        }),
      );
    case "list_versions":
      return versions(parts.boards.versions(command.boardId));
    case "save_version":
    case "restore_version":
      return versions(
        await parts.boards.personHistoryEdit(scope.organisationId, scope, {
          boardId: command.boardId,
          edit:
            command.kind === "save_version"
              ? { kind: "save_version", label: command.value }
              : { kind: "restore_version", versionId: command.value },
          operationId: command.operationId,
          userId: command.userId,
          controlSessionId: command.controlSessionId,
        }),
      );
    default:
      return command satisfies never;
  }
}

function versions(
  result: Result<readonly MenuBoardVersionSummary[], MenuBoardEditError>,
): MenuBoardVersionsResult {
  return result.ok ? { ok: true, value: { versions: result.value } } : result;
}

function threads(
  result: Result<readonly MenuBoardCommentThread[], MenuBoardEditError>,
): MenuBoardCommentsResult {
  return result.ok ? { ok: true, value: { threads: result.value } } : result;
}

/** The shop's menu draft, or an empty menu before anyone opened it. */
function menuSnapshot(drafts: MenuDraftRooms): MenuDraftSnapshot {
  const read = drafts.read();
  return read.ok
    ? read.value.draft
    : { title: "Café menu", sections: [], items: [] };
}
