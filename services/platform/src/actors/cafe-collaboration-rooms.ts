import { assertNever } from "@purin-labs/std";
import {
  authorizeMenuDraftRequest,
  matchMenuDraftRoute,
} from "../control/admission/menu-draft";
import type {
  CollaborationRoomRoute,
  CollaborationSocketRooms,
} from "./collaboration-room-dispatch";
import type { MenuBoardRooms } from "./menu-boards";
import type { MenuDraftRooms } from "./menu-draft";

/**
 * The shared documents of Café in the Organisation actor: the menu draft and
 * the menu boards. The route is the path match, the admission check and the
 * room. The menu boards have their own fetch path in the Worker class.
 */
export function cafeCollaborationRooms(
  rooms: Readonly<{ menuBoards: MenuBoardRooms; menuDrafts: MenuDraftRooms }>,
) {
  const menuDraft: CollaborationRoomRoute = (pathname) => {
    const route = matchMenuDraftRoute(pathname);
    if (route === null) return null;
    return {
      checksOrganisationRecord: true,
      async authorize(request, env) {
        const authorized = await authorizeMenuDraftRequest(request, env, route);
        if (!authorized.ok) return authorized;
        return {
          ok: true,
          organisationId: authorized.organisationId,
          respond(scope) {
            switch (route.transport) {
              case "snapshot":
                return rooms.menuDrafts.snapshot();
              case "socket":
                return rooms.menuDrafts.open(authorized, scope);
              case "review":
                return rooms.menuDrafts.review(authorized);
              default:
                return assertNever(route.transport);
            }
          },
        };
      },
    };
  };
  const sockets: Pick<CollaborationSocketRooms, "menu_board" | "menu_draft"> = {
    menu_board: (organisationId, key) =>
      rooms.menuBoards.socketRoom(organisationId, key),
    menu_draft: (organisationId, key) =>
      rooms.menuDrafts.socketRoom(organisationId, key),
  };
  return { routes: { menuDraft }, sockets };
}
