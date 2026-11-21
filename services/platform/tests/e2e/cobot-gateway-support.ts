import { env } from "cloudflare:workers";
import type {
  CobotReport,
  GatewayMessage,
  PlatformGatewayMessage,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import type { SimulatedGateway } from "./device-fleet-support";

/**
 * Plan 24 S3: the real shop gateway behind a journey's socket. The node side
 * (`tests/shop-gateway-adapters.ts`) runs the controller simulator and
 * `shop-gateway relay`; this side carries each message between the relay
 * and a `SimulatedGateway` socket. The relay decides every answer.
 */

export async function cobotSession(
  path: string,
  home: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await env.SHOP_GATEWAY_ADAPTERS.fetch(
    `http://adapters/cobot/${path}`,
    { method: "POST", body: JSON.stringify({ home, ...body }) },
  );
  const answer: unknown = await response.json();
  if (!response.ok || !isRecord(answer))
    throw new Error(`cobot/${path}: ${JSON.stringify(answer)}`);
  return answer;
}

/** The answer of the controller's control port. */
export async function controllerControl(
  home: string,
  line: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { answer } = await cobotSession("control", home, { line });
  if (!isRecord(answer)) throw new Error(JSON.stringify(answer));
  return answer;
}

/**
 * Pumps messages between one socket and the relay: each Platform message
 * goes to the relay's input, and each relay message goes to the socket.
 * `fromRelay` keeps every relay message in order.
 */
export class CobotGatewayPump {
  readonly fromRelay: GatewayMessage[] = [];
  #forward: Promise<unknown> = Promise.resolve();
  #stopped = false;
  readonly #loop: Promise<void>;

  constructor(
    readonly gateway: SimulatedGateway,
    readonly home: string,
  ) {
    gateway.socket.addEventListener("message", (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as PlatformGatewayMessage;
      this.toRelay(message);
    });
    this.#loop = this.#pump();
  }

  /** One message to the relay, after the messages before it. */
  toRelay(message: unknown): Promise<unknown> {
    this.#forward = this.#forward.then(() =>
      cobotSession("send", this.home, { message }),
    );
    return this.#forward;
  }

  async #pump(): Promise<void> {
    while (!this.#stopped) {
      const { messages } = await cobotSession("drain", this.home, {
        waitMs: 100,
      });
      for (const message of messages as GatewayMessage[]) {
        this.fromRelay.push(message);
        if (this.gateway.socket.readyState === WebSocket.OPEN)
          this.gateway.send(message);
      }
    }
  }

  /** The relay's reports of one dispatch, in order. */
  reports(requestId: string): CobotReport[] {
    return this.fromRelay.filter(
      (message): message is CobotReport =>
        message.type === "cobot_report" && message.requestId === requestId,
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#forward;
    await this.#loop;
  }
}
