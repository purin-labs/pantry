import { Container } from "@cloudflare/containers";

import type { Env } from "../env";
import type { Result } from "../result";

const CUSTOM_CONNECTOR_FETCH_PORT = 8080;

/** Credentialed egress for reviewed custom connector operations. */
export class CustomConnectorFetchContainer extends Container<Env> {
  defaultPort = CUSTOM_CONNECTOR_FETCH_PORT;
  requiredPorts = [CUSTOM_CONNECTOR_FETCH_PORT];
  sleepAfter = "30s";
  enableInternet = true;
  pingEndpoint = "/health";

  /**
   * Empties this Actor. The operator route calls it only for the object of
   * an organisation that no registry names; a container that runs is in use.
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
