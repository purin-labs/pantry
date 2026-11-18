import { assertNever } from "@seams/std";
import {
  authorizeBakeryWorkflowSocket,
  matchBakeryWorkflowRoute,
} from "../control/admission/bakery-workflows";
import {
  authorizeCostsSheetRequest,
  matchCostsSheetRoute,
} from "../control/admission/costs-sheet";
import {
  authorizeEmailDraftRequest,
  matchEmailDraftRoute,
} from "../control/admission/email-draft";
import { controlError } from "../control/http";
import {
  authorizeMailReplyDraftRequest,
  matchMailReplyDraftRoute,
} from "../control/admission/mail-reply-draft";
import {
  authorizeMenuDraftRequest,
  matchMenuDraftRoute,
} from "../control/admission/menu-draft";
import {
  authorizeProductDescriptionDraftRequest,
  matchProductDescriptionDraftRoute,
} from "../control/admission/product-description-draft";
import {
  authorizeProductionPlanSocket,
  matchProductionPlanRoute,
} from "../control/admission/production-plan";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "../result";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";
import type {
  CollaborationSocketRoom,
  CollaborationSocketRoute,
} from "./collaboration-room";
import type { CostsSheetRooms } from "./costs-sheet-draft";
import type { EmailDraftRooms } from "./email-draft";
import type { MailReplyDraftRooms } from "./mail-reply-draft";
import type { MenuBoardRooms } from "./menu-boards";
import type { MenuDraftRooms } from "./menu-draft";
import type { ProductDescriptionDraftRooms } from "./product-description-draft";
import type { ProductionPlanRooms } from "./production-plan";
import type { WorkflowCanvasRooms } from "./workflow-canvas-rooms";
import type { WorkflowDraftRooms } from "./workflow-draft";

export type OrganisationCollaborationRooms = Readonly<{
  costsSheets: CostsSheetRooms;
  descriptionDrafts: ProductDescriptionDraftRooms;
  emailDrafts: EmailDraftRooms;
  mailReplyDrafts: MailReplyDraftRooms;
  menuBoards: MenuBoardRooms;
  menuDrafts: MenuDraftRooms;
  productionPlans: ProductionPlanRooms;
  workflowCanvases: WorkflowCanvasRooms;
  workflowDrafts: WorkflowDraftRooms;
}>;

export async function resolveOrganisationCollaborationSocket(
  rooms: OrganisationCollaborationRooms,
  organisationId: OrganisationId,
  route: CollaborationSocketRoute,
): Promise<CollaborationSocketRoom | null> {
  switch (route.kind) {
    case "costs_sheet":
      return rooms.costsSheets.socketRoom(organisationId, route.key);
    case "email_draft":
      return rooms.emailDrafts.socketRoom(organisationId, route.key);
    case "mail_reply_draft":
      return rooms.mailReplyDrafts.socketRoom(organisationId, route.key);
    case "menu_draft":
      return rooms.menuDrafts.socketRoom(organisationId, route.key);
    case "menu_board":
      return rooms.menuBoards.socketRoom(organisationId, route.key);
    case "product_description":
      return rooms.descriptionDrafts.socketRoom(organisationId, route.key);
    case "production_plan":
      return rooms.productionPlans.socketRoom(organisationId, route.key);
    case "workflow_canvas":
      return rooms.workflowCanvases.socketRoom(organisationId, route.key);
    case "workflow_draft":
      return rooms.workflowDrafts.socketRoom(organisationId, route.key);
    default:
      return assertNever(route.kind);
  }
}

export async function dispatchOrganisationCollaborationFetch(input: Readonly<{
  request: Request;
  pathname: string;
  env: Env;
  sql: SqlStorage;
  scope: OrganisationExecutionScope;
  rooms: OrganisationCollaborationRooms;
  validateOrganisation: (
    organisationId: OrganisationId,
  ) => Result<unknown, Readonly<{ code: string }>>;
}>): Promise<Response> {
  const { request, pathname, env, sql, scope, rooms, validateOrganisation } =
    input;

  const costsSheetRoute = matchCostsSheetRoute(pathname);
  if (costsSheetRoute !== null) {
    const authorized = await authorizeCostsSheetRequest(
      request,
      env,
      costsSheetRoute,
    );
    if (!authorized.ok) return authorized.response;
    if (
      authorized.organisationId !== scope.organisationId ||
      !(await isOrganisationExecutionActive(sql, scope))
    ) {
      return controlError("organisation_placement_conflict", 409);
    }
    const organisation = validateOrganisation(authorized.organisationId);
    if (!organisation.ok) return controlError(organisation.error.code, 404);
    switch (costsSheetRoute.transport) {
      case "snapshot":
        return rooms.costsSheets.snapshot();
      case "socket":
        return rooms.costsSheets.open(authorized, scope);
      case "reset":
        return rooms.costsSheets.reset(authorized, scope);
      default:
        return assertNever(costsSheetRoute.transport);
    }
  }

  const productRoute = matchProductDescriptionDraftRoute(pathname);
  if (productRoute !== null) {
    const authorized = await authorizeProductDescriptionDraftRequest(
      request,
      env,
      productRoute,
    );
    if (!authorized.ok) return authorized.response;
    if (
      authorized.organisationId !== scope.organisationId ||
      !(await isOrganisationExecutionActive(sql, scope))
    ) {
      return controlError("organisation_placement_conflict", 409);
    }
    const organisation = validateOrganisation(authorized.organisationId);
    if (!organisation.ok) return controlError(organisation.error.code, 404);
    if (productRoute.transport === "shared-thread") {
      return rooms.descriptionDrafts.shareThread(
        request,
        authorized,
        productRoute.productId,
        scope,
      );
    }
    return productRoute.transport === "socket"
      ? rooms.descriptionDrafts.open(authorized, productRoute.productId, scope)
      : rooms.descriptionDrafts.snapshot(scope, productRoute.productId);
  }

  const workflowRoute = matchBakeryWorkflowRoute(pathname);
  if (workflowRoute !== null) {
    const authorized = await authorizeBakeryWorkflowSocket(
      request,
      env,
      workflowRoute,
    );
    if (!authorized.ok) return authorized.response;
    if (
      authorized.organisationId !== scope.organisationId ||
      !(await isOrganisationExecutionActive(sql, scope))
    ) {
      return controlError("organisation_placement_conflict", 409);
    }
    return rooms.workflowDrafts.open(
      authorized,
      workflowRoute.workflowId,
      scope,
    );
  }

  const planRoute = matchProductionPlanRoute(pathname);
  if (planRoute !== null) {
    const authorized = await authorizeProductionPlanSocket(
      request,
      env,
      planRoute,
    );
    if (!authorized.ok) return authorized.response;
    if (
      authorized.organisationId !== scope.organisationId ||
      !(await isOrganisationExecutionActive(sql, scope))
    ) {
      return controlError("organisation_placement_conflict", 409);
    }
    const organisation = validateOrganisation(authorized.organisationId);
    if (!organisation.ok) return controlError(organisation.error.code, 404);
    return planRoute.transport === "share"
      ? rooms.productionPlans.share(
          request,
          authorized,
          planRoute.locationId,
          scope,
        )
      : rooms.productionPlans.open(authorized, planRoute.locationId, scope);
  }

  const mailReplyRoute = matchMailReplyDraftRoute(pathname);
  if (mailReplyRoute !== null) {
    const authorized = await authorizeMailReplyDraftRequest(
      request,
      env,
      mailReplyRoute,
    );
    if (!authorized.ok) return authorized.response;
    if (
      authorized.organisationId !== scope.organisationId ||
      !(await isOrganisationExecutionActive(sql, scope))
    ) {
      return controlError("organisation_placement_conflict", 409);
    }
    const organisation = validateOrganisation(authorized.organisationId);
    if (!organisation.ok) return controlError(organisation.error.code, 404);
    return rooms.mailReplyDrafts.open(
      authorized,
      mailReplyRoute.proposalId,
      scope,
    );
  }

  const emailRoute = matchEmailDraftRoute(pathname);
  if (emailRoute !== null) {
    const authorized = await authorizeEmailDraftRequest(
      request,
      env,
      emailRoute,
    );
    if (!authorized.ok) return authorized.response;
    if (
      authorized.organisationId !== scope.organisationId ||
      !(await isOrganisationExecutionActive(sql, scope))
    ) {
      return controlError("organisation_placement_conflict", 409);
    }
    const organisation = validateOrganisation(authorized.organisationId);
    if (!organisation.ok) return controlError(organisation.error.code, 404);
    switch (emailRoute.transport) {
      case "snapshot":
        return rooms.emailDrafts.snapshot();
      case "socket":
        return rooms.emailDrafts.open(authorized, scope);
      case "review":
        return rooms.emailDrafts.review(authorized);
      case "shared-thread":
        return rooms.emailDrafts.shareThread(request, authorized, scope);
      default:
        return assertNever(emailRoute.transport);
    }
  }

  const menuRoute = matchMenuDraftRoute(pathname);
  if (menuRoute === null) return controlError("not_found", 404);
  const authorized = await authorizeMenuDraftRequest(request, env, menuRoute);
  if (!authorized.ok) return authorized.response;
  if (
    authorized.organisationId !== scope.organisationId ||
    !(await isOrganisationExecutionActive(sql, scope))
  ) {
    return controlError("organisation_placement_conflict", 409);
  }
  const organisation = validateOrganisation(authorized.organisationId);
  if (!organisation.ok) return controlError(organisation.error.code, 404);
  switch (menuRoute.transport) {
    case "snapshot":
      return rooms.menuDrafts.snapshot();
    case "socket":
      return rooms.menuDrafts.open(authorized, scope);
    case "review":
      return rooms.menuDrafts.review(authorized);
    default:
      return assertNever(menuRoute.transport);
  }
}
