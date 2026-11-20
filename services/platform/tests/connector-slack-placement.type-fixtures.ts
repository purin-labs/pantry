import type { ConnectorDeliveryReceipt } from "@purin-labs/contracts";
import {
  checkPreparedConnectorDelivery,
  streamConnectorCaseTurn,
} from "../src/actors/connector-slack-stream";
import type { ConnectorCaseTurnStreamInput } from "../src/actors/case-turn-stream";

declare const streamInput: Parameters<typeof streamConnectorCaseTurn>[0];
declare const deliveryInput: Parameters<
  typeof checkPreparedConnectorDelivery
>[0];
declare const stream: ConnectorCaseTurnStreamInput;
declare const receipt: ConnectorDeliveryReceipt;

// @ts-expect-error Replay preparation requires captured placement authority.
void streamConnectorCaseTurn({
  storage: streamInput.storage,
  env: streamInput.env,
  session: streamInput.session,
  stream,
});

// @ts-expect-error Delivery preparation requires captured placement authority.
void checkPreparedConnectorDelivery({
  sql: deliveryInput.sql,
  identity: deliveryInput.identity,
  delivery: deliveryInput.delivery,
  requestedAt: deliveryInput.requestedAt,
});

const incrementalInput: ConnectorCaseTurnStreamInput = {
  ...stream,
  // @ts-expect-error Native incremental delivery is absent from the current request.
  screeningMode: "stream",
};
void incrementalInput;

type PreparedDelivery = Awaited<
  ReturnType<typeof checkPreparedConnectorDelivery>
>;
declare const ready: Extract<PreparedDelivery, { kind: "ready" }>;

// @ts-expect-error A broad spread cannot combine readiness with a sent receipt.
const readyWithReceipt: PreparedDelivery = { ...ready, receipt };
void readyWithReceipt;
