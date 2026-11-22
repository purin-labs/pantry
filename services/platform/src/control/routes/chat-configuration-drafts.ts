/**
 * Setup changes and price allowances that the agent staged in a Portal chat
 * (Plan 81 slice 5). The agent writes a draft with `configuration_propose`.
 * The person who asked confirms it on a card, through the same store that a
 * Slack reply uses, so one draft applies one time on either surface.
 */
import { isConversationId } from "@purin-labs/control-api";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { ConversationScope } from "@purin-labs/conversation/chat/store";
import {
  cancelOperatorConfigurationDraft,
  confirmOperatorConfigurationDraft,
  listOperatorDraftsForCase,
  readOperatorDraft,
  type OperatorConfigurationDraft,
} from "@purin-labs/area-organisation/server/data/operator-configuration-draft";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  presentConfigurationCommand,
  previewCode,
} from "../../slack/configuration-presentation";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { controlError, controlJson } from "@purin-labs/control/worker/http";
import { roleMayConfigure } from "@purin-labs/tenancy/data/control-plane";
import { conversationCase } from "./chat-slack-messages";

export type ConfigurationDraftAction = "confirm" | "cancel";

export async function readConversationConfigurationDrafts(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversationId: string,
): Promise<readonly Record<string, unknown>[] | null> {
  if (!isConversationId(conversationId)) return null;
  const caseId = await conversationCase(placement, scope, conversationId);
  if (caseId === null) return null;
  const drafts = await listOperatorDraftsForCase({
    db: placement.database,
    organisationId: scope.organisationId,
    caseId,
    now: Date.now(),
  });
  return Promise.all(
    drafts.map(async (draft) =>
      configurationDraftWire(
        draft,
        scope.userId,
        await offerName(env, scope, draft),
      ),
    ),
  );
}

/**
 * POST `confirm` applies the exact change that the card showed; POST `cancel`
 * closes it. Only the person who asked can do either, as in Slack.
 */
export async function handlePortalChatConfigurationDraft(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  conversationIdRaw: string,
  draftIdRaw: string,
  action: ConfigurationDraftAction,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  if (!isConversationId(conversationIdRaw) || draftIdRaw.length > 200)
    return controlError("configuration_draft_request_invalid", 422);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const placement = authorized.executionScope;
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const caseId = await conversationCase(placement, scope, conversationIdRaw);
  if (caseId === null) return controlError("chat_not_found", 404);
  const stored = await readOperatorDraft(
    placement.database,
    scope.organisationId,
    draftIdRaw,
  );
  // A draft of another Case answers as a missing one.
  if (stored === null || stored.caseId !== caseId)
    return controlError("configuration_draft_not_found", 404);
  // A setup change needs an admin. Staff may restrict or resume a device.
  if (
    stored.command.family !== "device_command" &&
    !roleMayConfigure(authorized.membership.role)
  )
    return controlError("organisation_role_insufficient", 403);
  if (stored.actorUserId !== scope.userId)
    return controlError("configuration_draft_waits_on_requester", 403);
  const now = Date.now();
  if (action === "cancel") {
    const cancelled = await cancelOperatorConfigurationDraft({
      db: placement.database,
      organisationId: scope.organisationId,
      draftId: stored.draftId,
      actorUserId: scope.userId,
      now,
    });
    return cancelled.ok
      ? draftResponse(env, placement, scope, stored.draftId)
      : controlError("configuration_draft_not_pending", 409);
  }
  const confirmed = await confirmOperatorConfigurationDraft({
    db: placement.database,
    env,
    organisationId: scope.organisationId,
    draftId: stored.draftId,
    actorUserId: scope.userId,
    actorRole: authorized.membership.role,
    controlSessionId: authorized.authenticated.session.controlSessionId,
    previewCode: previewCode(stored.commandDigest),
    now,
  });
  return confirmed.ok
    ? draftResponse(env, placement, scope, stored.draftId)
    : controlError(confirmed.error.code, 409);
}

async function draftResponse(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  draftId: string,
): Promise<Response> {
  const draft = await readOperatorDraft(
    placement.database,
    scope.organisationId,
    draftId,
  );
  return draft === null
    ? controlError("configuration_draft_not_found", 404)
    : controlJson({
        ok: true,
        draft: configurationDraftWire(
          draft,
          scope.userId,
          await offerName(env, scope, draft),
        ),
      });
}

/**
 * The product name of an allowance's offer, for the card. An offer id means
 * nothing to the person who confirms. With no local record, the id stays.
 */
async function offerName(
  env: Env,
  scope: ConversationScope,
  draft: OperatorConfigurationDraft,
): Promise<string | null> {
  if (draft.command.family !== "offer_price_allowance") return null;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: scope.organisationId,
    now: Date.now(),
  });
  const read = (
    kind: "offer" | "sellable_variant" | "product",
    canonicalId: string,
  ) =>
    organisation.readCurrentCommerceProjection({
      organisationId: scope.organisationId,
      kind,
      canonicalId,
    });
  const offer = await read("offer", draft.command.allowance.offerId);
  if (!offer.ok || offer.value?.kind !== "offer") return null;
  const variant = await read(
    "sellable_variant",
    offer.value.projection.variantId,
  );
  if (!variant.ok || variant.value?.kind !== "sellable_variant") return null;
  const product = await read("product", variant.value.projection.productId);
  return product.ok && product.value?.kind === "product"
    ? product.value.projection.title
    : null;
}

function configurationDraftWire(
  draft: OperatorConfigurationDraft,
  userId: string,
  name: string | null,
): Record<string, unknown> {
  const presented = presentConfigurationCommand(draft.command);
  return {
    draftId: draft.draftId,
    summary:
      name === null || draft.command.family !== "offer_price_allowance"
        ? presented.summary
        : presented.summary.replace(draft.command.allowance.offerId, name),
    actionLabel: presented.actionLabel,
    consequence: presented.consequence,
    state: draft.state,
    receiptCode: draft.receiptCode,
    requestedByViewer: draft.actorUserId === userId,
    createdAt: draft.createdAt,
  };
}
