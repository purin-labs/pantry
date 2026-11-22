import {
  resolveCanvasCollaborationAgent,
  resolveCollaborationAgent,
} from "../../actors/collaboration-agent";
import { sessionTurnExecution } from "@purin-labs/conversation/chat/turn-access";
import {
  type MenuDraftEdit,
  type MenuDraftRead,
} from "../../actors/menu-draft";
import { MenuDraftRequestError } from "../../cafe/contract/request-errors";
import {
  type MenuBoardEdit,
  type MenuBoardEditResult,
} from "../../actors/menu-boards";
import { MenuBoardRequestError } from "../../cafe/contract/request-errors";
import { readCafeImages } from "../../cafe/contract/media";
import { readPublishedCafeMenu } from "../../control/routes/menu-screens";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import { requireActiveOrganisationActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "@purin-labs/agent/actors/session-execution-admission";
import { preflightHarnessTurnLease } from "@purin-labs/agent/actors/agent-session-harness-authority";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import type { MenuBoardArchiveRequest, MenuBoardCreateRequest } from "./drafts";
import { readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding } from "@purin-labs/agent/actors/agent-session-information-flow";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { assertNever } from "@purin-labs/std";
import {
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_SCREEN_SIZES,
  menuBoardCanvasRects,
} from "@purin-labs/menu-board-crdt/board";
import {
  collaborationEditDeadline,
  collaborationMember,
  type ToolEffect,
} from "@purin-labs/tool-handlers/agent-tools/session-support";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";

export async function readMenuDraftForEmbeddedHarness(
  context: SessionToolContext,
): Promise<MenuDraftRead> {
  const { env, storage, execution, lease } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.readMenuDraft({ organisationId });
  if (!result.ok) {
    throw new Error(`Menu draft unavailable: ${result.error.code}`);
  }
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  return result.value;
}

/**
 * An agent's change of the shared menu. It passes the check of a person who
 * can edit, and the exit check for content that goes into a shared draft. It
 * has no commerce effect: publication is a separate approved action.
 */
export async function editMenuDraftForEmbeddedHarness(
  context: SessionToolContext,
  edit: MenuDraftEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<ToolEffect<MenuDraftRead>> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  return {
    kind: "shared_draft",
    member,
    unavailable: "Menu draft information-flow authority unavailable",
    draft: {
      shared: "every_member",
      edit: {
        draft: "Menu draft",
        capabilityId: CAPABILITY_KEYS.commerceMenuDraftEdit,
        integrationAccountId: "platform",
        resourceScope: "menu-draft:cafe-menu",
      },
    },
    run: async () => {
      const active = preflightHarnessTurnLease(storage, lease, Date.now());
      if (!active.ok) {
        throw new Error(
          `Menu draft edit authority expired: ${active.error.code}`,
        );
      }
      const organisation = await requireActiveOrganisationActorAtPlacement({
        env,
        organisationId,
        placement: execution.scope.placement,
        now: Date.now(),
      });
      await requireSessionExecution(execution, lease);
      const result = await organisation.editMenuDraft({
        agent: await resolveCollaborationAgent(execution.scope, assignment),
        execution: sessionTurnExecution(lease),
        organisationId,
        edit,
        operationId: JSON.stringify([
          lease.session.sessionId,
          lease.turn.turnId,
          operationId,
        ]),
        userId: member.userId,
        deadlineAt,
      });
      if (!result.ok) {
        if (result.error.code === "record_conflict") {
          throw new MenuDraftRequestError(
            "That section or item is not in the menu now. Read the menu again before you choose a new edit.",
          );
        }
        throw new Error(`Menu draft edit failed: ${result.error.code}`);
      }
      await requireSessionExecution(execution, lease);
      return result.value;
    },
  };
}

/**
 * Plan 40B phase 4: the shop's menu boards for an agent, with the menu items
 * that they name and each item's live price, deal and availability. A board
 * holds no price; the prices here are the ones that the screens show now.
 */
export async function readMenuBoardsForEmbeddedHarness(
  context: SessionToolContext,
  request: Readonly<{ boardId: string | null }>,
): Promise<unknown> {
  const { env, storage, execution, lease } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const [result, published, images] = await Promise.all([
    organisation.readMenuBoards({ organisationId, boardId: request.boardId }),
    readPublishedCafeMenu(env, organisationId),
    readCafeImages(env, organisationId),
  ]);
  const facts = published?.facts ?? null;
  if (!result.ok) {
    if (result.error.code === "menu_board_missing") {
      throw new MenuBoardRequestError(
        "That board does not exist. Call menu_board_read with boardId null to list the boards.",
      );
    }
    throw new Error(`Menu boards unavailable: ${result.error.code}`);
  }
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const live = new Map(
    (facts?.entries ?? []).map((entry) => [entry.menuEntryId, entry]),
  );
  return {
    boards: result.value.boards.map((board) => ({
      boardId: board.boardId,
      documentRevision: board.documentRevision,
      title: board.board.title,
      layout: board.board.layout,
      style: board.board.style,
      elements: board.board.elements,
      unplaced: board.board.unplaced,
      // Plan 40B phase 5, slice 8: where each element of a free canvas
      // shows, with the elements of each stack placed.
      canvasRects: MENU_BOARD_LAYOUTS[board.board.layout].canvas
        ? Object.fromEntries(
            menuBoardCanvasRects(
              [...board.board.elements, ...board.board.unplaced],
              MENU_BOARD_SCREEN_SIZES[
                MENU_BOARD_LAYOUTS[board.board.layout].shape
              ],
              MENU_BOARD_SCREEN_SIZES[
                MENU_BOARD_LAYOUTS[board.board.layout].shape
              ],
            ),
          )
        : null,
      comments: board.comments,
      versions: board.versions.slice(0, 20),
      release: board.release,
      screens: board.screens,
    })),
    // Plan 40B, board removal: boards that menu_board_archive can restore.
    archivedBoards: result.value.archivedBoards,
    sections: result.value.menu.sections.map((section) => ({
      sectionId: section.id,
      title: section.title,
    })),
    items: [
      ...result.value.menu.items.map((item) => {
        const entry = live.get(item.id);
        return {
          itemId: item.id,
          name: item.displayName,
          sectionId: item.placement.sectionId,
          onPublishedMenu: entry !== undefined,
          price: entry?.price ?? null,
          wasPrice: entry?.compareAtPrice ?? null,
          availability: entry?.availability ?? null,
        };
      }),
      // Plan 40B phase 5: the published menu can hold items that the menu
      // draft does not, for example a menu that a shop set up through the
      // Commerce API. Their itemId is the menu entry, so that a price
      // proposal works with no board and no draft.
      ...(published?.names ?? [])
        .filter(
          (name) =>
            !result.value.menu.items.some(
              (item) => item.id === name.menuEntryId,
            ),
        )
        .map((name) => {
          const entry = live.get(name.menuEntryId);
          return {
            itemId: name.menuEntryId,
            name: name.name,
            sectionId: null,
            publishedSection: name.sectionName,
            onPublishedMenu: true,
            price: entry?.price ?? null,
            wasPrice: entry?.compareAtPrice ?? null,
            availability: entry?.availability ?? null,
          };
        }),
    ],
    // Plan 40B, the image element: the shop's images that add_image can
    // place on a free canvas, by mediaId.
    images: images ?? [],
    pricesVerified: facts !== null,
    observedAt: facts?.observedAt ?? Date.now(),
  };
}

/**
 * An agent's change of one board's draft (Plan 40B phase 4). It passes the
 * check of a person who can edit, and the exit check for content that goes
 * into a shared draft. It has no commerce effect: a person publishes the
 * board, and a price is an approved action.
 */
export async function editMenuBoardForEmbeddedHarness(
  context: SessionToolContext,
  request: Readonly<{ boardId: string; edit: MenuBoardEdit }>,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<ToolEffect<MenuBoardEditResult>> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  // An image comes from the shop's library: the person sees the same list
  // in the board editor's Images panel.
  if (request.edit.kind === "add_image") {
    const mediaId = request.edit.mediaId;
    const images = await readCafeImages(env, organisationId);
    if (images === null)
      throw new Error("The shop's images could not be read. Try again later.");
    if (!images.some((image) => image.mediaId === mediaId))
      throw new MenuBoardRequestError(
        "That image is not in the shop's library. Call menu_board_read and use a mediaId from its images.",
      );
  }
  return {
    kind: "shared_draft",
    member,
    unavailable: "Menu board information-flow authority unavailable",
    draft: {
      shared: "every_member",
      edit: {
        draft: "Menu board",
        capabilityId: CAPABILITY_KEYS.commerceMenuDraftEdit,
        integrationAccountId: "platform",
        resourceScope: `menu-board:${request.boardId}`,
      },
    },
    run: async () => {
      const active = preflightHarnessTurnLease(storage, lease, Date.now());
      if (!active.ok) {
        throw new Error(
          `Menu board edit authority expired: ${active.error.code}`,
        );
      }
      const organisation = await requireActiveOrganisationActorAtPlacement({
        env,
        organisationId,
        placement: execution.scope.placement,
        now: Date.now(),
      });
      await requireSessionExecution(execution, lease);
      const result = await organisation.editMenuBoard({
        agent: await resolveCanvasCollaborationAgent(
          execution.scope,
          assignment,
        ),
        execution: sessionTurnExecution(lease),
        organisationId,
        boardId: request.boardId,
        edit: request.edit,
        operationId: JSON.stringify([
          lease.session.sessionId,
          lease.turn.turnId,
          operationId,
        ]),
        userId: member.userId,
        deadlineAt,
      });
      if (!result.ok) {
        switch (result.error.code) {
          case "menu_board_missing":
            throw new MenuBoardRequestError(
              "That board does not exist. Call menu_board_read with boardId null to list the boards.",
            );
          case "menu_board_element_missing":
            throw new MenuBoardRequestError(
              "That element is not on the board now. Read the board again before you choose a new edit.",
            );
          case "menu_board_text_changed":
            throw new MenuBoardRequestError(
              `Someone changed that text since your read. It is now ${JSON.stringify(result.error.current ?? "")}. Read the board again and check with the person before you change it.`,
            );
          case "menu_board_edit_invalid":
            throw new MenuBoardRequestError(
              "The board cannot take that edit: check the element kind, the prop, the frame of the layout, the item and the text length (280 characters).",
            );
          case "menu_board_comment_missing":
            throw new MenuBoardRequestError(
              "That comment is not on the board now. Call menu_board_read for the board's comment threads.",
            );
          case "menu_board_comment_limit":
            throw new MenuBoardRequestError(
              "This board has 300 comments. Ask a person to delete old ones before you add another.",
            );
          case "menu_board_comment_invalid":
            throw new MenuBoardRequestError(
              "A comment needs 1 to 1000 characters of text.",
            );
          case "menu_board_version_missing":
            throw new MenuBoardRequestError(
              "That version is not in the board's history. Call menu_board_read for the board's versions.",
            );
          case "menu_board_version_invalid":
            throw new MenuBoardRequestError(
              "A version name needs 1 to 80 characters.",
            );
          default:
            throw new Error(`Menu board edit failed: ${result.error.code}`);
        }
      }
      await requireSessionExecution(execution, lease);
      return result.value;
    },
  };
}

/**
 * An agent's new board (Plan 40B, the start screen): a layout's template, a
 * blank free canvas or a designed menu. It passes the same checks as an
 * agent's board edit: the person can edit menu boards, and the chat's
 * content may enter a shared draft. It has no commerce effect: a person
 * publishes the board.
 */
export async function createMenuBoardForEmbeddedHarness(
  context: SessionToolContext,
  request: MenuBoardCreateRequest,
  _operationId: string,
  _boundary: CatalogExecutionContext,
): Promise<ToolEffect<unknown>> {
  const { env, storage, execution, lease } = context;
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  return {
    kind: "shared_draft",
    member,
    unavailable: "Menu board information-flow authority unavailable",
    draft: {
      shared: "every_member",
      edit: {
        draft: "Menu board",
        capabilityId: CAPABILITY_KEYS.commerceMenuDraftEdit,
        integrationAccountId: "platform",
        resourceScope: "menu-board:new",
      },
    },
    run: async () => {
      const active = preflightHarnessTurnLease(storage, lease, Date.now());
      if (!active.ok) {
        throw new Error(
          `Menu board edit authority expired: ${active.error.code}`,
        );
      }
      const organisation = await requireActiveOrganisationActorAtPlacement({
        env,
        organisationId,
        placement: execution.scope.placement,
        now: Date.now(),
      });
      await requireSessionExecution(execution, lease);
      const created = await organisation.menuBoardCommand({
        organisationId,
        command: {
          kind: "create_board",
          title: request.title,
          layout: request.layout,
          start: request.start,
          userId: member.userId,
        },
      });
      if (!created.ok) {
        if (created.error.code === "menu_board_limit")
          throw new MenuBoardRequestError(
            "This shop has 12 boards. Ask a person to remove one before you make another.",
          );
        throw new Error(`Menu board create failed: ${created.error.code}`);
      }
      await requireSessionExecution(execution, lease);
      return { board: created.value };
    },
  };
}

/**
 * An agent archives a board that no screen shows, or restores an archived
 * board (Plan 40B, board removal), as an owner or admin does from the
 * board menu. The person who asked must be an owner or admin. An archive
 * deletes nothing, so a restore undoes it.
 */
export async function archiveMenuBoardForEmbeddedHarness(
  context: SessionToolContext,
  request: MenuBoardArchiveRequest,
  _operationId: string,
  _boundary: CatalogExecutionContext,
): Promise<unknown> {
  const { env, storage, execution, lease } = context;
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  if (member.role !== "owner" && member.role !== "admin")
    throw new MenuBoardRequestError(
      "Only an owner or admin can archive or restore a board. Tell the person to ask one.",
    );
  const active = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!active.ok) {
    throw new Error(
      `Menu board archive authority expired: ${active.error.code}`,
    );
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const changed = await organisation.menuBoardCommand({
    organisationId,
    command: {
      kind: "set_board_archived",
      boardId: request.boardId,
      archived: request.archived,
      userId: member.userId,
    },
  });
  if (!changed.ok) {
    switch (changed.error.code) {
      case "menu_board_missing":
        throw new MenuBoardRequestError(
          "That board does not exist. Call menu_board_read with boardId null: it lists the boards and the archived boards.",
        );
      case "menu_board_on_screen":
        throw new MenuBoardRequestError(
          "A screen shows this board. Ask the person to show another board on that screen, or to end its pairing, before you archive it.",
        );
      case "menu_board_limit":
        throw new MenuBoardRequestError(
          "This shop has 12 boards. Ask a person to archive one before you restore another.",
        );
      default:
        throw new Error(`Menu board archive failed: ${changed.error.code}`);
    }
  }
  await requireSessionExecution(execution, lease);
  return changed.value;
}

export async function requireLiveMenuDraftAuthority(
  execution: SessionExecutionAdmission,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
): Promise<void> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  switch (lease.requestAuthority.kind) {
    case "control":
    case "direct_conversation":
    case "shared_conversation":
      break;
    case "workflow":
    case "agent_mailbox":
    case "whatsapp_support":
      throw new Error("Menu draft read requires a current organisation member");
    default:
      return assertNever(lease.requestAuthority);
  }
  const current = await readPersistedSessionTurnFlowBinding(storage.sql, {
    organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
  });
  if (
    !current.ok ||
    current.value === null ||
    current.value.authorityPartitionDigest !== lease.authorityPartitionDigest
  ) {
    throw new Error("Menu draft information-flow authority unavailable");
  }
  await requireSessionExecution(execution, lease);
}
