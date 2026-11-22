import { Container } from "@cloudflare/containers";

import type { Env } from "@purin-labs/kernel/env";

const MESSAGE_LINK_FETCH_PORT = 8080;

/**
 * One short-lived, credential-free network boundary for public-link reads.
 * The service itself owns address pinning and the TLS Host/SNI contract.
 *
 * @public `services/platform/src/integration-gateway.ts` exports it for the
 * container binding of `wrangler.jsonc`.
 */
export class MessageLinkFetchContainer extends Container<Env> {
  defaultPort = MESSAGE_LINK_FETCH_PORT;
  requiredPorts = [MESSAGE_LINK_FETCH_PORT];
  sleepAfter = "30s";
  enableInternet = true;
  pingEndpoint = "/health";

  override async onActivityExpired(): Promise<void> {
    await this.destroy();
  }
}

declare module "@purin-labs/kernel/env" {
  interface Env {
    MESSAGE_LINK_FETCH: DurableObjectNamespace<MessageLinkFetchContainer>;
  }
}
