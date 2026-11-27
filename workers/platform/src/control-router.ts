import {
  handleClaudeConnectionRoute,
  matchClaudeConnectionRoute,
} from "@purin-labs/agent/control/routes/claude";
import {
  handleChatGoalRoute,
  matchChatGoalRoute,
} from "@purin-labs/conversation/control/routes/chat-goal";
import { handleWorkflowCanvasRoute } from "@purin-labs/area-kitchen/server/control/routes/workflow-canvas";
import { matchWorkflowCanvasRoute } from "@purin-labs/area-kitchen/server/control/admission/workflow-canvas";
import {
  handleChatSharingRoute,
  matchChatSharingRoute,
} from "@purin-labs/conversation/control/routes/chat-sharing";
import {
  handleProjectAccessRoute,
  matchProjectAccessRoute,
} from "@purin-labs/conversation/control/routes/project-access";
import {
  handleUserPreferencesRoute,
  matchUserPreferencesRoute,
} from "@purin-labs/area-organisation/server/control/routes/user-preferences";
import {
  handleMailAssistantRoute,
  matchMailAssistantRoute,
} from "@purin-labs/area-inbox/server/control/routes/mail-assistant";
import {
  handleMailOrganizationRoute,
  matchMailOrganizationRoute,
} from "@purin-labs/area-inbox/server/control/routes/mail-organization";
import type { Env } from "@purin-labs/kernel/env";
import {
  handleProjectsRoute,
  matchProjectsRoute,
} from "@purin-labs/conversation/control/routes/projects";
import {
  handleChatDirectoryRoute,
  matchChatDirectoryRoute,
} from "@purin-labs/conversation/control/routes/chat-directory";
import {
  handleMailInboxRoute,
  matchMailInboxRoute,
} from "@purin-labs/area-inbox/server/control/routes/mail-inbox";
import {
  handleInboxConversationsRoute,
  matchInboxConversationsRoute,
} from "@purin-labs/area-inbox/server/control/routes/inbox-conversations";
import {
  handleMailPersonReplyRoute,
  matchMailPersonReplyRoute,
} from "@purin-labs/area-inbox/server/control/routes/mail-person-reply";
import { handleBakeryWorkflowRoute } from "@purin-labs/area-kitchen/server/control/routes/bakery-workflows";
import { matchBakeryWorkflowRoute } from "@purin-labs/area-kitchen/server/control/admission/bakery-workflows";
import {
  handleBakeryRunRoute,
  matchBakeryRunRoute,
} from "@purin-labs/area-kitchen/server/control/routes/bakery-runs";
import {
  handleBakeryRunArtifactRoute,
  matchBakeryRunArtifactRoute,
} from "@purin-labs/area-kitchen/server/control/routes/bakery-run-artifacts";
import {
  handleJevFeaturesRoute,
  matchJevFeaturesRoute,
} from "@purin-labs/area-integrations/server/control/routes/jev-features";
import {
  handleTypeSafeConnectionRoute,
  matchTypeSafeConnectionRoute,
} from "@purin-labs/area-integrations/server/control/routes/typesafe";
import {
  handleCaseContextDiscoveryRoute,
  matchCaseContextDiscoveryRoute,
} from "@purin-labs/conversation/control/routes/case-context-discovery";
import { resolveCaseContextCollectionSelectionVerification } from "@purin-labs/area-inbox/server/case-context-discovery/source";
import { handleCaseScreenObservationsRoute } from "@purin-labs/surface-portal/server/control/routes/case-screen-observations";
import {
  handleMemoryRoute,
  matchMemoryRoute,
} from "@purin-labs/area-brain/server/control/routes/memories";
import {
  handleVaultRoute,
  matchVaultRoute,
} from "@purin-labs/control/worker/routes/vault";
import {
  handleEvalRoute,
  matchEvalRoute,
} from "@purin-labs/area-brain/server/control/routes/evals";
import {
  handleBrainRoute,
  matchBrainRoute,
} from "@purin-labs/area-brain/server/control/routes/brain";
import {
  handleCaseExecutionRoute,
  matchCaseExecutionRoute,
} from "@purin-labs/area-brain/server/control/routes/case-execution";
import { handleProductDescriptionDraftRoute } from "@purin-labs/area-commerce/server/control/routes/product-description-draft";
import { matchProductDescriptionDraftRoute } from "@purin-labs/area-commerce/server/control/admission/product-description-draft";
import { handleMailReplyDraftRoute } from "@purin-labs/area-inbox/server/control/routes/mail-reply-draft";
import { matchMailReplyDraftRoute } from "@purin-labs/area-inbox/server/control/admission/mail-reply-draft";
import { handleProductionPlanRoute } from "@purin-labs/area-kitchen/server/control/routes/production-plan";
import { matchProductionPlanRoute } from "@purin-labs/area-kitchen/server/control/admission/production-plan";
import { handleCostsSheetRoute } from "@purin-labs/area-kitchen/server/control/routes/costs-sheet";
import { matchCostsSheetRoute } from "@purin-labs/area-kitchen/server/control/admission/costs-sheet";
import { handleEmailDraftRoute } from "@purin-labs/area-inbox/server/control/routes/email-draft";
import { matchEmailDraftRoute } from "@purin-labs/area-inbox/server/control/admission/email-draft";
import {
  handleVoiceRoute,
  matchVoiceRoute,
} from "@purin-labs/surface-voice/server/routes";
import { handleMenuDraftRoute } from "@purin-labs/area-cafe/server/control/routes/menu-draft";
import { matchMenuDraftRoute } from "@purin-labs/area-cafe/server/control/admission/menu-draft";
import {
  handleMenuBoardControlRoute,
  handleMenuBoardSocketRoute,
  matchMenuBoardControlRoute,
} from "@purin-labs/area-cafe/server/control/routes/menu-boards";
import { matchMenuBoardSocketRoute } from "@purin-labs/area-cafe/server/control/admission/menu-boards";
import {
  handleDeviceControlRoute,
  matchDeviceControlRoute,
} from "@purin-labs/area-devices/server/control/routes/devices";
import {
  handleBakeControlRoute,
  matchBakeControlRoute,
} from "@purin-labs/area-kitchen/server/control/routes/bakes";
import { handleChatSignalRoute } from "@purin-labs/conversation/control/routes/chat-signals";
import { matchChatSignalRoute } from "@purin-labs/conversation/control/admission/chat-signals";
import {
  controlRouteFamily,
  controlRouteFamilyWith,
  handleControlRouteTable,
  type ControlRouteFamily,
} from "@purin-labs/control/worker/route-table";
import {
  handleAccessControlRoute,
  matchAccessControlRoute,
} from "@purin-labs/control/worker/routes/access-control";
import {
  handleHeldOutputRequestRoute,
  matchHeldOutputRequestRoute,
} from "@purin-labs/conversation/control/routes/held-output-requests";
import {
  handleAgentPermissionRequestRoute,
  matchAgentPermissionRequestRoute,
} from "@purin-labs/conversation/control/routes/agent-permission-requests";
import {
  handleAgentInferenceRoute,
  matchAgentInferenceRoute,
} from "@purin-labs/agent/control/routes/inference-routes";
import {
  handleOrganisationSlackReasoningEffort,
  matchSlackReasoningEffortRoute,
} from "@purin-labs/surface-slack/server/control/routes/slack-reasoning-effort";
import {
  handleInboxAgentControlRoute,
  matchInboxAgentControlRoute,
} from "@purin-labs/area-inbox/server/control/routes/agent-mail";
import {
  handleAgentOperationRoute,
  matchAgentOperationRoute,
} from "@purin-labs/conversation/control/routes/agents/operation-routes";
import {
  handleWhatsAppControlRoute,
  matchWhatsAppControlRoute,
} from "./control/routes/whatsapp";
import {
  handleCommerceControlRoute,
  matchCommerceControlRoute,
} from "./control/routes/commerce";
import {
  handleIntegrationControlRoute,
  matchIntegrationControlRoute,
} from "@purin-labs/area-integrations/server/control/routes/integrations";
import {
  handleCustomConnectorControlRoute,
  matchCustomConnectorControlRoute,
} from "@purin-labs/area-integrations/server/control/routes/custom-connectors";
import {
  handlePortalChatControlRoute,
  matchPortalChatControlRoute,
} from "@purin-labs/surface-portal/server/control/routes/chat/router";
import {
  handleOnboardingControlRoute,
  matchOnboardingControlRoute,
} from "@purin-labs/area-organisation/server/control/routes/onboarding";
import {
  handleOperatorControlRoute,
  matchOperatorControlRoute,
} from "@purin-labs/area-organisation/server/control/routes/operators";
import {
  handleSessionControlRoute,
  matchSessionControlRoute,
} from "@purin-labs/control/worker/routes/sessions";
import { resolveControlSupportRole } from "@purin-labs/area-organisation/server/data/onboarding-support";
import {
  handleWorkspaceControlRoute,
  matchWorkspaceControlRoute,
} from "@purin-labs/area-organisation/server/control/routes/workspace";
import { ACCESS_CONTROL_PARTS } from "./control/access-control-parts";
import {
  decidePendingDecisionWith,
  pendingDecisionSources,
} from "./control/pending-decision-parts";
import {
  handlePendingDecisionsRoute,
  matchPendingDecisionsRoute,
} from "@purin-labs/control/worker/routes/pending-decisions";

/**
 * The families of the control routes, in the order in which the router
 * tries their paths. Each family pairs the matcher of its owner with the
 * handler of its owner, and the Worker gives each handler its parts.
 */
const CONTROL_ROUTE_FAMILIES: readonly ControlRouteFamily[] = [
  controlRouteFamily(matchUserPreferencesRoute, handleUserPreferencesRoute),
  controlRouteFamily(matchProjectAccessRoute, handleProjectAccessRoute),
  controlRouteFamily(matchChatGoalRoute, handleChatGoalRoute),
  controlRouteFamily(matchChatSharingRoute, handleChatSharingRoute),
  controlRouteFamily(matchProjectsRoute, handleProjectsRoute),
  controlRouteFamily(matchChatDirectoryRoute, handleChatDirectoryRoute),
  controlRouteFamily(matchBakeryWorkflowRoute, handleBakeryWorkflowRoute),
  controlRouteFamily(matchBakeryRunRoute, handleBakeryRunRoute),
  controlRouteFamily(matchBakeryRunArtifactRoute, handleBakeryRunArtifactRoute),
  controlRouteFamily(matchClaudeConnectionRoute, handleClaudeConnectionRoute),
  controlRouteFamily(
    matchTypeSafeConnectionRoute,
    handleTypeSafeConnectionRoute,
  ),
  controlRouteFamily(matchJevFeaturesRoute, handleJevFeaturesRoute),
  controlRouteFamily(matchCaseContextDiscoveryRoute, (request, env, route) =>
    handleCaseContextDiscoveryRoute(request, env, route, {
      verifySelection: resolveCaseContextCollectionSelectionVerification,
      screenObservations: handleCaseScreenObservationsRoute,
    }),
  ),
  controlRouteFamily(matchMemoryRoute, handleMemoryRoute),
  controlRouteFamily(matchVaultRoute, handleVaultRoute),
  controlRouteFamily(matchEvalRoute, handleEvalRoute),
  controlRouteFamily(matchBrainRoute, handleBrainRoute),
  controlRouteFamily(matchCaseExecutionRoute, handleCaseExecutionRoute),
  controlRouteFamily(matchVoiceRoute, handleVoiceRoute),
  controlRouteFamily(matchMenuDraftRoute, handleMenuDraftRoute),
  controlRouteFamily(matchMenuBoardSocketRoute, handleMenuBoardSocketRoute),
  controlRouteFamily(matchMenuBoardControlRoute, handleMenuBoardControlRoute),
  controlRouteFamily(matchDeviceControlRoute, handleDeviceControlRoute),
  controlRouteFamily(matchBakeControlRoute, handleBakeControlRoute),
  controlRouteFamily(matchChatSignalRoute, handleChatSignalRoute),
  controlRouteFamily(matchWorkflowCanvasRoute, handleWorkflowCanvasRoute),
  controlRouteFamily(matchEmailDraftRoute, handleEmailDraftRoute),
  controlRouteFamily(
    matchProductDescriptionDraftRoute,
    handleProductDescriptionDraftRoute,
  ),
  controlRouteFamily(matchMailReplyDraftRoute, handleMailReplyDraftRoute),
  controlRouteFamily(matchProductionPlanRoute, handleProductionPlanRoute),
  controlRouteFamily(matchCostsSheetRoute, handleCostsSheetRoute),
  controlRouteFamilyWith(matchSessionControlRoute, (call, route) =>
    handleSessionControlRoute(call.request, call.env, route, call.url, {
      resolveSupportRole: resolveControlSupportRole,
    }),
  ),
  controlRouteFamilyWith(matchOperatorControlRoute, (call, route) =>
    handleOperatorControlRoute(call.request, call.env, route, call.url),
  ),
  controlRouteFamily(matchHeldOutputRequestRoute, (request, env, route) =>
    handleHeldOutputRequestRoute(
      request,
      env,
      route,
      decidePendingDecisionWith(env),
    ),
  ),
  controlRouteFamily(matchAgentPermissionRequestRoute, (request, env, route) =>
    handleAgentPermissionRequestRoute(
      request,
      env,
      route,
      decidePendingDecisionWith(env),
    ),
  ),
  controlRouteFamily(matchPendingDecisionsRoute, (request, env, route) =>
    handlePendingDecisionsRoute(
      request,
      env,
      route,
      pendingDecisionSources(env),
    ),
  ),
  controlRouteFamilyWith(matchAccessControlRoute, (call, route) =>
    handleAccessControlRoute(
      call.request,
      call.env,
      route,
      call.url,
      ACCESS_CONTROL_PARTS,
    ),
  ),
  controlRouteFamily(matchMailAssistantRoute, handleMailAssistantRoute),
  controlRouteFamily(matchMailOrganizationRoute, handleMailOrganizationRoute),
  controlRouteFamily(matchMailInboxRoute, handleMailInboxRoute),
  controlRouteFamily(
    matchInboxConversationsRoute,
    handleInboxConversationsRoute,
  ),
  controlRouteFamily(matchMailPersonReplyRoute, handleMailPersonReplyRoute),
  // The agent routes: the paths of these five families do not overlap.
  controlRouteFamily(matchAgentInferenceRoute, handleAgentInferenceRoute),
  controlRouteFamily(matchSlackReasoningEffortRoute, (request, env, route) =>
    handleOrganisationSlackReasoningEffort(
      request,
      env,
      route.organisationIdRaw,
    ),
  ),
  controlRouteFamily(matchInboxAgentControlRoute, (request, env, route) =>
    handleInboxAgentControlRoute(
      request,
      env,
      route,
      decidePendingDecisionWith(env),
    ),
  ),
  controlRouteFamily(matchWhatsAppControlRoute, handleWhatsAppControlRoute),
  controlRouteFamily(matchAgentOperationRoute, handleAgentOperationRoute),
  controlRouteFamilyWith(matchIntegrationControlRoute, (call, route) =>
    handleIntegrationControlRoute(call.request, call.env, route, call.url),
  ),
  controlRouteFamilyWith(matchPortalChatControlRoute, (call, route) =>
    handlePortalChatControlRoute(call.request, call.env, route, call.execution),
  ),
  controlRouteFamily(matchCustomConnectorControlRoute, (request, env, route) =>
    handleCustomConnectorControlRoute(
      request,
      env,
      route,
      decidePendingDecisionWith(env),
    ),
  ),
  controlRouteFamily(matchCommerceControlRoute, (request, env, route) =>
    handleCommerceControlRoute(
      request,
      env,
      route,
      decidePendingDecisionWith(env),
    ),
  ),
  controlRouteFamily(matchWorkspaceControlRoute, handleWorkspaceControlRoute),
  controlRouteFamily(matchOnboardingControlRoute, handleOnboardingControlRoute),
];

export function handleControlRequest(
  request: Request,
  env: Env,
  execution: ExecutionContext | null = null,
): Promise<Response> {
  return handleControlRouteTable(
    CONTROL_ROUTE_FAMILIES,
    request,
    env,
    execution,
  );
}
