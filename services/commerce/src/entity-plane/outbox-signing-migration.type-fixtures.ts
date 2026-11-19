import type { OutboxSigningMigrationBatch } from "./outbox-signing-migration.ts";
import type { Variant } from "@purin-labs/type-utils";

declare const continuation: Variant<
  OutboxSigningMigrationBatch,
  "continuation"
>;

// @ts-expect-error A completed migration cannot retain a continuation cursor.
const completedWithCursor: OutboxSigningMigrationBatch = {
  kind: "complete",
  afterDeliveryId: "delivery",
  deliveries: [],
};
// @ts-expect-error A continuation must identify the last processed delivery.
const missingCursor: OutboxSigningMigrationBatch = {
  kind: "continuation",
  deliveries: [],
};
// @ts-expect-error A broad spread cannot turn a continuation into completion.
const spreadCompletion: OutboxSigningMigrationBatch = {
  ...continuation,
  kind: "complete",
};

void completedWithCursor;
void missingCursor;
void spreadCompletion;
