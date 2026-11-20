import { Container } from "@cloudflare/containers";

import { eraseIdleContainerState } from "../actors/unregistered-actor-erasure";
import type { Env } from "../env";

const MESSAGE_LINK_FETCH_PORT = 8080;

/**
 * One short-lived, credential-free network boundary for public-link reads.
 * The service itself owns address pinning and the TLS Host/SNI contract.
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

  /**
   * Empties this Actor. The operator route calls it only for an object that
   * the placement of no organisation addresses; a container that runs is in
   * use.
   */
  eraseUnregisteredState() {
    return eraseIdleContainerState(this.ctx);
  }
}

declare module "../env" {
  interface Env {
    MESSAGE_LINK_FETCH: DurableObjectNamespace<MessageLinkFetchContainer>;
  }
}
