import { Container } from "@cloudflare/containers";

import { eraseIdleContainerState } from "../actors/unregistered-actor-erasure";
import type { Env } from "../env";

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
  eraseUnregisteredState() {
    return eraseIdleContainerState(this.ctx);
  }
}

declare module "../env" {
  interface Env {
    CUSTOM_CONNECTOR_FETCH: DurableObjectNamespace<CustomConnectorFetchContainer>;
  }
}
