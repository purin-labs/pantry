import { assertNever } from "@purin-labs/std";
import {
  authorizeBakeryWorkflowSocket,
  matchBakeryWorkflowRoute,
} from "../control/admission/bakery-workflows";
import {
  authorizeCostsSheetRequest,
  matchCostsSheetRoute,
} from "../control/admission/costs-sheet";
import {
  authorizeProductionPlanSocket,
  matchProductionPlanRoute,
} from "../control/admission/production-plan";
import type {
  CollaborationRoomRoute,
  CollaborationSocketRooms,
} from "./collaboration-room-dispatch";
import type { CostsSheetRooms } from "./costs-sheet-draft";
import type { ProductionPlanRooms } from "./production-plan";
import type { WorkflowCanvasRooms } from "./workflow-canvas-rooms";
import type { WorkflowDraftRooms } from "./workflow-draft";

/**
 * The shared documents of Kitchen in the Organisation actor: the costs sheet,
 * the recipe workflow draft, the production plan and the workflow canvas.
 * Each route is the path match, the admission check and the room.
 */
export function kitchenCollaborationRooms(
  rooms: Readonly<{
    costsSheets: CostsSheetRooms;
    productionPlans: ProductionPlanRooms;
    workflowCanvases: WorkflowCanvasRooms;
    workflowDrafts: WorkflowDraftRooms;
  }>,
) {
  const costsSheet: CollaborationRoomRoute = (pathname) => {
    const route = matchCostsSheetRoute(pathname);
    if (route === null) return null;
    return {
      checksOrganisationRecord: true,
      async authorize(request, env) {
        const authorized = await authorizeCostsSheetRequest(
          request,
          env,
          route,
        );
        if (!authorized.ok) return authorized;
        return {
          ok: true,
          organisationId: authorized.organisationId,
          respond(scope) {
            switch (route.transport) {
              case "snapshot":
                return rooms.costsSheets.snapshot();
              case "socket":
                return rooms.costsSheets.open(authorized, scope);
              case "reset":
                return rooms.costsSheets.reset(authorized, scope);
              default:
                return assertNever(route.transport);
            }
          },
        };
      },
    };
  };
  const workflowDraft: CollaborationRoomRoute = (pathname) => {
    const route = matchBakeryWorkflowRoute(pathname);
    if (route === null) return null;
    return {
      // This room opens with the placement check only.
      checksOrganisationRecord: false,
      async authorize(request, env) {
        const authorized = await authorizeBakeryWorkflowSocket(
          request,
          env,
          route,
        );
        if (!authorized.ok) return authorized;
        return {
          ok: true,
          organisationId: authorized.organisationId,
          respond: (scope) =>
            rooms.workflowDrafts.open(authorized, route.workflowId, scope),
        };
      },
    };
  };
  const productionPlan: CollaborationRoomRoute = (pathname) => {
    const route = matchProductionPlanRoute(pathname);
    if (route === null) return null;
    return {
      checksOrganisationRecord: true,
      async authorize(request, env) {
        const authorized = await authorizeProductionPlanSocket(
          request,
          env,
          route,
        );
        if (!authorized.ok) return authorized;
        return {
          ok: true,
          organisationId: authorized.organisationId,
          respond: (scope) =>
            route.transport === "share"
              ? rooms.productionPlans.share(
                  request,
                  authorized,
                  route.locationId,
                  scope,
                )
              : rooms.productionPlans.open(authorized, route.locationId, scope),
        };
      },
    };
  };
  const sockets: Pick<
    CollaborationSocketRooms,
    "costs_sheet" | "production_plan" | "workflow_canvas" | "workflow_draft"
  > = {
    costs_sheet: (organisationId, key) =>
      rooms.costsSheets.socketRoom(organisationId, key),
    production_plan: (organisationId, key) =>
      rooms.productionPlans.socketRoom(organisationId, key),
    workflow_canvas: (organisationId, key) =>
      rooms.workflowCanvases.socketRoom(organisationId, key),
    workflow_draft: (organisationId, key) =>
      rooms.workflowDrafts.socketRoom(organisationId, key),
  };
  return { routes: { costsSheet, workflowDraft, productionPlan }, sockets };
}
