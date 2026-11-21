import {
  authorizeProductDescriptionDraftRequest,
  matchProductDescriptionDraftRoute,
} from "../control/admission/product-description-draft";
import type {
  CollaborationRoomRoute,
  CollaborationSocketRooms,
} from "./collaboration-room-dispatch";
import type { ProductDescriptionDraftRooms } from "./product-description-draft";

/**
 * The shared document of commerce in the Organisation actor: the product
 * description draft. The route is the path match, the admission check and
 * the room.
 */
export function commerceCollaborationRooms(
  rooms: Readonly<{ descriptionDrafts: ProductDescriptionDraftRooms }>,
) {
  const productDescription: CollaborationRoomRoute = (pathname) => {
    const route = matchProductDescriptionDraftRoute(pathname);
    if (route === null) return null;
    return {
      checksOrganisationRecord: true,
      async authorize(request, env) {
        const authorized = await authorizeProductDescriptionDraftRequest(
          request,
          env,
          route,
        );
        if (!authorized.ok) return authorized;
        return {
          ok: true,
          organisationId: authorized.organisationId,
          respond(scope) {
            if (route.transport === "shared-thread") {
              return rooms.descriptionDrafts.shareThread(
                request,
                authorized,
                route.productId,
                scope,
              );
            }
            return route.transport === "socket"
              ? rooms.descriptionDrafts.open(authorized, route.productId, scope)
              : rooms.descriptionDrafts.snapshot(scope, route.productId);
          },
        };
      },
    };
  };
  const sockets: Pick<CollaborationSocketRooms, "product_description"> = {
    product_description: (organisationId, key) =>
      rooms.descriptionDrafts.socketRoom(organisationId, key),
  };
  return { routes: { productDescription }, sockets };
}
