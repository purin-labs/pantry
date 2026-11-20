import { handleAccountPlatformRequest } from "./account-platform/routes";
import { runScheduledPayoutReconciliation } from "./payouts/recovery";
import type { Track } from "@purin-labs/contracts";
import { handleControlRequest } from "./control-router";
import type { GatewayRoute } from "./gateway-routing/domain";
import { matchGatewayRoute } from "./gateway-routing/match";
import { handleSlackInteractions } from "./slack/interactions";
import { runScheduledOnboardingReconciliation } from "./onboarding-reconciliation-runner";
import {
  handleCommerceLabRoute,
  matchCommerceLabRoute,
} from "./commerce-lab/router";
import { processCueQueueBatch } from "./cues/queue-consumer";
import { runScheduleDispatch } from "./schedules/dispatch";
import type { Env } from "./env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
} from "./http";
import { newRequestId } from "./ids";
import { startIsolateLocationRead } from "./isolate-location";
import { traceWarn } from "./observability";
import { runScheduledCommerceOutboxReconciliation } from "./commerce/outbox-worker";
import { runScheduledPaidReceiptDelivery } from "./commerce/paid-receipt";
import { runFileContextReconciliation } from "./context/files";
import { runAttachmentCollection } from "./messages/attachment-collection";
import { runWeeklyChatGptLoginRefresh } from "./models/codex-connection";
import { runAccountInstanceRelease } from "./account-platform/instance-release";
import { runScheduledActorRegistryReconciliation } from "./actors/actor-registry-sweep";
import { handleCommerceWebhook } from "./commerce/webhooks";
import { handleMenuScreenRequest } from "./control/routes/menu-screens";
import { handleVoiceMacRequest } from "./voice/mac-routes";
import { handleDeviceGatewayRequest } from "./devices/gateway-routes";
import { assertNever } from "@purin-labs/std";
import {
  handleAdministerActorRegistry,
  handleInspectRetainedVaultRootClosure,
} from "./gateway/admin/actor-registry";
import {
  handleAdministerActorRelocation,
  handleAdministerActorRestore,
} from "./gateway/admin/actor-relocation";
import { handleAdministerCodeModePlatformCutover } from "./gateway/admin/code-mode-cutover";
import { handleMachineCensus } from "./gateway/admin/machine-census";
import {
  handleCafeCommerceAcceptance,
  handleCreateOrganisationInstall,
  handleOnboardingActivationAcceptance,
  handleOrganisationPing,
  handleResolveInstall,
} from "./gateway/admin/organisation-install";
import { handleAdministerPersonRoles } from "./gateway/admin/person-roles";
import {
  authorizeQueuedCueDelivery,
  deliverMatchedCueSubscriptions,
  settleQueuedCue,
} from "./gateway/cue-delivery";
import { handleCueStatus } from "./gateway/cue-status";
import {
  handleConfigureDiscordInteraction,
  handleDiscordInteraction,
} from "./gateway/discord";
import { handleDropboxWebhook } from "./gateway/dropbox-webhook";
import { handleEventQueueMessage } from "./gateway/event-queue";
import {
  handleConfigureExternalRecordsCredential,
  handleReadExternalRecords,
} from "./gateway/external-records";
import {
  handleCompleteIdentityLink,
  handleIdentityLinkChallenge,
  handleIdentityUiConfig,
  handleIssueIdentityLink,
} from "./gateway/identity-link";
import { handleListIntegrationAccounts } from "./gateway/integration-accounts";
import { handleEmailGoogleWebhook } from "./gateway/mail-webhooks";
import {
  EVENT_QUEUE_RETRY_DELAY_SECONDS,
  type HealthBody,
} from "./gateway/support";
import {
  handleConfigureShopifyConnector,
  handleConfigureShopifyCredential,
  handleConfigureShopifyCues,
  handleTriggerShopifyTestOrder,
} from "./shopify/admin";
import { handleShopifyWebhook } from "./shopify/webhooks";
import { handleSlackEvents } from "./slack-ingress/events";
import {
  handleSlackInstall,
  handleSlackInstallLiveness,
  handleSlackInstallStart,
} from "./slack-ingress/install";
import {
  handleConfigureStripeConnector,
  handleConfigureStripeFailureCues,
} from "./stripe/admin";
import {
  handleConfigureStripeTestCredential,
  handleTriggerStripeTestFailure,
} from "./stripe/test-admin";
import {
  handleStripeConnectWebhook,
  handleStripeWebhook,
} from "./stripe/webhooks";
import { handleWhatsAppWebhook } from "./whatsapp/webhook-route";

export { CodeModePlatformGovernorActor } from "./actors/code-mode-platform-governor";

export { ConversationResidencyActor } from "./actors/conversation-residency";

export { DeviceFleetActor } from "./actors/device-fleet";
export { BakeRunActor } from "./actors/bake-run";

export { SessionDO } from "./actors/agent-session";

export { OrganisationDO } from "./actors/organisation";

export { CaseDO } from "./actors/case";

export { ConnectorDO } from "./actors/connector";

export { WorkspaceExecutorContainer } from "./workspace-executor-container";

export { MessageLinkFetchContainer } from "./messages/link-fetch-container";

export { CustomConnectorFetchContainer } from "./custom-connectors/fetch-container";

const SUPPORTED_TRACKS = [
  "managed-agents",
  "byo",
] as const satisfies readonly Track[];

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    startIsolateLocationRead(env, ctx);
    return handleRequest(request, env, ctx).catch(handleRequestFailure);
  },
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return handleQueue(batch, env);
  },
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    if (controller.cron === "* * * * *") {
      ctx.waitUntil(
        runScheduledPaidReceiptDelivery(env, controller.scheduledTime),
      );
      return;
    }
    // Commerce posts each event as it happens; this read is the backstop
    // for a lost post. Every five minutes keeps the sync time inside
    // COMMERCE_PROJECTION_STALE_AFTER_MS, and each read wakes the merchant's
    // Durable Object.
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(
        runScheduledCommerceOutboxReconciliation(
          env,
          controller.scheduledTime,
        ),
      );
      return;
    }
    ctx.waitUntil(
      runScheduledOnboardingReconciliation(env, controller.scheduledTime),
    );
    ctx.waitUntil(
      runScheduleDispatch({
        env,
        queue: env.EVENT_Q,
        now: controller.scheduledTime,
      }),
    );
    ctx.waitUntil(runFileContextReconciliation(env, controller.scheduledTime));
    ctx.waitUntil(runAttachmentCollection(env, controller.scheduledTime));
    ctx.waitUntil(
      runScheduledPayoutReconciliation(env, controller.scheduledTime),
    );
    ctx.waitUntil(runWeeklyChatGptLoginRefresh(env, controller.scheduledTime));
    ctx.waitUntil(runAccountInstanceRelease(env, controller.scheduledTime));
    ctx.waitUntil(
      runScheduledActorRegistryReconciliation(env, controller.scheduledTime),
    );
  },
} satisfies ExportedHandler<Env, unknown>;

function handleRequestFailure(error: unknown): Response {
  console.error("integration_gateway_request_failed", error);
  return errorResponse("internal_error", "Request failed.", 500);
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const accountPlatform = await handleAccountPlatformRequest(request, env);
  if (accountPlatform !== null) return accountPlatform;
  const url = new URL(request.url);
  const commerceLabRoute = matchCommerceLabRoute(url);

  if (commerceLabRoute !== null) {
    return handleCommerceLabRoute(request, env, commerceLabRoute);
  }

  const route: GatewayRoute = matchGatewayRoute(url.pathname);

  try {
    switch (route.kind) {
      case "health":
        return handleHealth(request);
      case "control":
        return handleControlRequest(request, env, ctx);
      case "menuScreen":
        return handleMenuScreenRequest(request, env);
      case "voiceMac":
        return handleVoiceMacRequest(request, env);
      case "deviceGateway":
        return handleDeviceGatewayRequest(request, env);
      case "slackEvents":
        return handleSlackEvents(request, env, ctx);
      case "slackInteractions":
        return handleSlackInteractions(request, env, ctx);
      case "slackInstallStart":
        return handleSlackInstallStart(request, env);
      case "slackInstall":
        return handleSlackInstall(request, env);
      case "slackInstallLiveness":
        return handleSlackInstallLiveness(request, env, url);
      case "createOrganisationInstall":
        return handleCreateOrganisationInstall(request, env);
      case "issueIdentityLink":
        return handleIssueIdentityLink(request, env);
      case "administerPersonRoles":
        return handleAdministerPersonRoles(request, env);
      case "administerCodeModePlatformCutover":
        return handleAdministerCodeModePlatformCutover(request, env);
      case "administerActorRegistry":
        return handleAdministerActorRegistry(request, env);
      case "machineCensus":
        return handleMachineCensus(request, env);
      case "inspectRetainedVaultRootClosure":
        return handleInspectRetainedVaultRootClosure(request, env);
      case "administerActorRelocation":
        return handleAdministerActorRelocation(request, env);
      case "administerActorRestore":
        return handleAdministerActorRestore(request, env);
      case "configureStripeTestCredential":
        return handleConfigureStripeTestCredential(request, env);
      case "triggerStripeTestFailure":
        return handleTriggerStripeTestFailure(request, env);
      case "cueStatus":
        return handleCueStatus(request, env);
      case "configureShopifyCredential":
        return handleConfigureShopifyCredential(request, env);
      case "configureExternalRecordsCredential":
        return handleConfigureExternalRecordsCredential(request, env);
      case "readExternalRecords":
        return handleReadExternalRecords(request, env);
      case "configureShopifyConnector":
        return handleConfigureShopifyConnector(request, env);
      case "configureShopifyCues":
        return handleConfigureShopifyCues(request, env);
      case "triggerShopifyTestOrder":
        return handleTriggerShopifyTestOrder(request, env);
      case "configureStripeConnector":
        return handleConfigureStripeConnector(request, env);
      case "configureStripeFailureCues":
        return handleConfigureStripeFailureCues(request, env);
      case "listIntegrationAccounts":
        return handleListIntegrationAccounts(request, env);
      case "configureDiscordInteraction":
        return handleConfigureDiscordInteraction(request, env);
      case "stripeConnectWebhook":
        return handleStripeConnectWebhook(request, env);
      case "underclerkWebhook":
        return handleCommerceWebhook(request, env, route.organisationIdRaw);
      case "stripeWebhook":
        return handleStripeWebhook(request, env, route.organisationIdRaw);
      case "shopifyWebhook":
        return handleShopifyWebhook(request, env, route.organisationIdRaw);
      case "dropboxWebhook":
        return handleDropboxWebhook(request, env);
      case "discordInteraction":
        return handleDiscordInteraction(request, env, route.organisationIdRaw);
      case "emailGoogleWebhook":
        return handleEmailGoogleWebhook(request, env);
      case "whatsappWebhook":
        return handleWhatsAppWebhook(request, env);
      case "identityUiConfig":
        return handleIdentityUiConfig(request, env);
      case "identityLinkChallenge":
        return handleIdentityLinkChallenge(request, env, route.tokenRaw);
      case "completeIdentityLink":
        return handleCompleteIdentityLink(request, env, route.tokenRaw);
      case "resolveInstall":
        return handleResolveInstall(
          request,
          env,
          route.surfaceKindRaw,
          route.workspaceIdRaw,
        );
      case "organisationPing":
        return handleOrganisationPing(request, env, route.organisationIdRaw);
      case "onboardingActivationAcceptance":
        return handleOnboardingActivationAcceptance(
          request,
          env,
          route.organisationIdRaw,
        );
      case "cafeCommerceAcceptance":
        return handleCafeCommerceAcceptance(
          request,
          env,
          route.organisationIdRaw,
        );
      case "notFound":
        return notFound();
      default:
        return assertNever(route);
    }
  } catch (error) {
    console.error("integration_gateway_request_failed", error);
    return errorResponse("internal_error", "Request failed.", 500);
  }
}

function handleHealth(request: Request): Response {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const body: HealthBody = {
    ok: true,
    service: "integration-gateway",
    tracks: SUPPORTED_TRACKS,
  };

  return jsonResponse(body);
}

async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  switch (batch.queue) {
    case "satyr-events":
      for (const message of batch.messages) {
        await handleEventQueueMessage(message, env);
      }
      return;
    case "satyr-cues":
      await processCueQueueBatch({
        messages: batch.messages,
        kv: env.POLICY_KV,
        deliveryContext: env,
        authorizeMutation: authorizeQueuedCueDelivery,
        deliverMatched: deliverMatchedCueSubscriptions,
        settle: settleQueuedCue,
        retryDelaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS,
        now: Date.now,
      });
      return;
    default:
      traceWarn("event_queue.unsupported_queue", {
        requestId: newRequestId(),
        queue: batch.queue,
      });
      batch.retryAll({ delaySeconds: EVENT_QUEUE_RETRY_DELAY_SECONDS });
      return;
  }
}
