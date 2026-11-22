import { signalChat } from "../../../chat/signals";
import { isConversationId } from "@purin-labs/control-api";
import { parseBakeryBrowserBinding } from "@purin-labs/bakery-model/bakery-context";
import type { Env } from "@purin-labs/kernel/env";
import { parseSessionId } from "@purin-labs/kernel/ids";
import { resolveActiveSessionActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import { parseBakerySurfaceReceipt } from "@purin-labs/bakery-model/bakery-surface";
import {
  listPendingBakerySurfaceEffects,
  readBakerySurfaceDeliveryTarget,
} from "../../../actors/bakery-surface-effect";

export async function handlePortalChatSurfaceEffects(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const params = new URL(request.url).searchParams;
  const browserInstanceId = params.get("browserInstanceId");
  const conversationId = params.get("conversationId");
  const browserBinding = parseBakeryBrowserBinding({
    browserInstanceId,
    conversationId,
  });
  if (
    browserBinding === null ||
    !isConversationId(browserBinding.conversationId)
  )
    return controlError("chat_surface_request_invalid", 422);
  const effects = await listPendingBakerySurfaceEffects({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
    browserBinding,
  });
  return controlJson({ ok: true, effects });
}

export async function handlePortalChatSurfaceReceipt(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  effectId: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    Object.keys(body.value).length !== 1 ||
    !Object.hasOwn(body.value, "receipt")
  )
    return controlError("chat_surface_receipt_invalid", 422);
  const receipt = parseBakerySurfaceReceipt(body.value.receipt);
  if (receipt.kind === "invalid" || receipt.value.effectId !== effectId)
    return controlError("chat_surface_receipt_invalid", 422);
  const target = await readBakerySurfaceDeliveryTarget({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
    effectId,
  });
  if (target === null)
    return controlError("chat_surface_effect_not_found", 404);
  const sessionId = parseSessionId(target.sessionId);
  if (!sessionId.ok) return controlError("chat_surface_effect_invalid", 409);
  const session = await resolveActiveSessionActor({
    env: env,
    namespace: env.SESSION,
    organisationId: authorized.organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!session.ok) return controlError("chat_surface_effect_unavailable", 409);
  const settled = await session.value.settleBakerySurfaceEffect({
    requestingOrganisationId: authorized.organisationId,
    receipt: receipt.value,
  });
  if (!settled.ok)
    return controlError(
      settled.code,
      settled.code.endsWith("missing") ? 404 : 409,
    );
  // The settlement adds a Kitchen event to the user's conversation, which
  // the next chat read places in its timeline.
  signalChat(authorized.executionScope, {
    kind: "user",
    userId: authorized.authenticated.session.userId,
  });
  return controlJson({ ok: true, settlement: settled.kind });
}
