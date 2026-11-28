import { Container } from "@cloudflare/containers";

import type { Env } from "@purin-labs/kernel/env";

const MESSAGE_LINK_FETCH_PORT = 8080;

/**
 * One short-lived, credential-free network boundary for public-link reads.
 * The service itself owns address pinning and the TLS Host/SNI contract.
 *
 * @public `workers/platform/src/integration-gateway.ts` exports it for the
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

/** The part of the Worker environment that a read of a public link needs. */
export type MessageLinkFetchEnv = {
  readonly MESSAGE_LINK_FETCH: DurableObjectNamespace<MessageLinkFetchContainer>;
};

declare module "@purin-labs/kernel/env" {
  interface Env extends MessageLinkFetchEnv {}
}
