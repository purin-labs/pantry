import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import { controlError } from "../http";
import {
  type ChatSignalRoute,
  authorizeChatSignalRequest,
} from "../admission/chat-signals";

export async function handleChatSignalRoute(
  request: Request,
  env: Env,
  route: ChatSignalRoute,
): Promise<Response> {
  const authorized = await authorizeChatSignalRequest(request, env, route);
  if (!authorized.ok) return authorized.response;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: route.organisationId,
      now: Date.now(),
    });
    return await organisation.fetch(request);
  } catch {
    return controlError("chat_signal_unavailable", 503);
  }
}
