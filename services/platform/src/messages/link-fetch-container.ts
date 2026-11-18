import { Container } from "@cloudflare/containers";

import type { Env } from "../env";
import type { Result } from "../result";

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
  async eraseUnregisteredState(): Promise<
    Result<null, { readonly code: "actor_in_use" }>
  > {
    if (this.ctx.container?.running === true)
      return { ok: false, error: { code: "actor_in_use" } };
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { ok: true, value: null };
  }
}
