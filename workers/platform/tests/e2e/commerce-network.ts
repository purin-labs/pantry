import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "@purin-labs/kernel/env";
import platform from "../../src/integration-gateway";

/**
 * The internet as Commerce's fixture Worker reaches it in the E2E runtime
 * (Plan 77 step 8). A webhook post to the platform's public origin
 * (`https://localhost` here) reaches the platform Worker, as a post to
 * pantry does in production; every other request goes on through the
 * test network.
 */
export class CommerceNetwork extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== this.env.PANTRY_PUBLIC_ORIGIN) return fetch(request);
    const eventId = request.headers.get("x-commerce-event-id");
    if (eventId !== null) commerceWebhookPosts.push(eventId);
    return platform.fetch(request, this.env, this.ctx);
  }
}

/** The event id of each webhook post that reached the platform, in order. */
export const commerceWebhookPosts: string[] = [];
