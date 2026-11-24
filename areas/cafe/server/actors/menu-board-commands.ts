import type {
  MenuBoardCommentThread,
  MenuBoardVersionSummary,
} from "@purin-labs/control-api";
import type { MenuDraftSnapshot } from "@purin-labs/menu-draft-crdt";

import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";
import type { MenuBoardRooms } from "./menu-boards";
import type { MenuDraftRooms } from "./menu-draft";
import type { MenuScreens } from "./menu-screens";
import type {
  MenuBoardCommand,
  MenuBoardCommandResult,
  MenuBoardCommandResults,
  MenuBoardCommentsResult,
  MenuBoardEditError,
  MenuBoardVersionsResult,
} from "../contract/menu-board-commands";

export type {
  MenuBoardCommand,
  MenuBoardCommandReply,
} from "../contract/menu-board-commands";

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
