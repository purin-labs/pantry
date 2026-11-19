// A capture with no order (Refactor 15, refactor 10, spec section 12). The
// provider took the buyer's money and Commerce could not place the order:
// the checkout had ended, or the capture or the placement was refused.
// Commerce does not refund it by itself (decision 4). The capture is a staff
// item until staff record what they did, through UNPLACED_CAPTURE_MACHINE.
import {
  commerceTransition,
  type CommerceInvalidTransition,
} from "@purin-labs/commerce-contracts";
import {
  parseResolveCommerceUnplacedCaptureV1,
  parseCommerceUnplacedCaptureV1,
  type CommerceUnplacedCaptureV1,
  type CommerceUnplacedCapturesV1,
} from "@purin-labs/commerce-contracts/records/api-unplaced-captures";

import type { CommerceDatabase } from "../database.ts";

const LIST_LIMIT = 200;

type OpenedUnplacedCapture = Omit<
  CommerceUnplacedCaptureV1,
  "revision" | "lifecycle"
>;

/**
 * Records a capture with no order, once for each payment attempt. A second
 * call for the same attempt keeps the first record.
 */
export function openUnplacedCapture(
  database: CommerceDatabase,
  merchantId: string,
  opened: OpenedUnplacedCapture,
): CommerceUnplacedCaptureV1 {
  const capture = parseCommerceUnplacedCaptureV1({
    ...opened,
    revision: 1,
    lifecycle: { state: "capture_unplaced" },
  });
  if (!capture.ok) throw new Error("An unplaced capture is not valid");
  database
    .prepare(
      `INSERT OR IGNORE INTO checkout_capture_unplaced (
         merchant_id, payment_attempt_id, checkout_id, revision,
         lifecycle_state, opened_at, capture_json
       ) VALUES (?, ?, ?, 1, 'capture_unplaced', ?, ?)`,
    )
    .run(
      merchantId,
      opened.paymentAttemptId,
      opened.checkoutId,
      opened.openedAt,
      JSON.stringify(capture.value),
    );
  const stored = readUnplacedCapture(
    database,
    merchantId,
    opened.paymentAttemptId,
  );
  if (stored === undefined) throw new Error("An unplaced capture was lost");
  return stored;
}

export function readUnplacedCapture(
  database: CommerceDatabase,
  merchantId: string,
  paymentAttemptId: string,
): CommerceUnplacedCaptureV1 | undefined {
  const row = database
    .prepare(
      `SELECT capture_json AS captureJson FROM checkout_capture_unplaced
       WHERE merchant_id = ? AND payment_attempt_id = ?`,
    )
    .get<Readonly<{ captureJson: string }>>(merchantId, paymentAttemptId);
  return row === undefined ? undefined : storedCapture(row.captureJson);
}

/** The open captures first, then the resolved ones; the newest first. */
export function listUnplacedCaptures(
  database: CommerceDatabase,
  merchantId: string,
): CommerceUnplacedCapturesV1 {
  const rows = database
    .prepare(
      `SELECT capture_json AS captureJson FROM checkout_capture_unplaced
       WHERE merchant_id = ?
       ORDER BY lifecycle_state = 'resolved', opened_at DESC, payment_attempt_id
       LIMIT ?`,
    )
    .all<Readonly<{ captureJson: string }>>(merchantId, LIST_LIMIT);
  return {
    schemaVersion: "underclerk.unplaced-captures.v1",
    merchantId,
    captures: rows.map((row) => storedCapture(row.captureJson)),
  };
}

export type UnplacedCaptureResolution =
  | Readonly<{ kind: "resolved"; capture: CommerceUnplacedCaptureV1 }>
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale"; capture: CommerceUnplacedCaptureV1 }>
  | Readonly<{
      kind: "refused";
      refusal: CommerceInvalidTransition<"unplaced_capture">;
    }>;

/**
 * Staff record what they did: a refund on the provider, or an order made by
 * hand. The write holds the state and the revision that it read, so two
 * staff who resolve the same capture at once cannot both succeed.
 */
export function resolveUnplacedCapture(
  database: CommerceDatabase,
  merchantId: string,
  paymentAttemptId: string,
  body: unknown,
  resolvedAt: string,
): UnplacedCaptureResolution {
  const command = parseResolveCommerceUnplacedCaptureV1(body);
  if (!command.ok)
    return { kind: "invalid", message: "The resolution is not valid" };
  const capture = readUnplacedCapture(database, merchantId, paymentAttemptId);
  if (capture === undefined) return { kind: "not_found" };
  if (capture.revision !== command.value.expectedRevision)
    return { kind: "stale", capture };
  const move = commerceTransition(
    "unplaced_capture",
    capture.lifecycle,
    "resolve",
  );
  if (!move.allowed) return { kind: "refused", refusal: move.refusal };
  const resolved = parseCommerceUnplacedCaptureV1({
    ...capture,
    revision: capture.revision + 1,
    lifecycle: {
      state: move.to,
      resolution: command.value.resolution,
      note: command.value.note ?? null,
      resolvedAt,
    },
  });
  if (!resolved.ok) throw new Error("A resolved capture is not valid");
  const written = database
    .prepare(
      `UPDATE checkout_capture_unplaced
       SET lifecycle_state = ?, revision = ?, capture_json = ?
       WHERE merchant_id = ? AND payment_attempt_id = ?
         AND lifecycle_state = ? AND revision = ?`,
    )
    .run(
      move.to,
      resolved.value.revision,
      JSON.stringify(resolved.value),
      merchantId,
      paymentAttemptId,
      move.from.state,
      capture.revision,
    );
  if (written.changes === 0) {
    const current = readUnplacedCapture(database, merchantId, paymentAttemptId);
    return current === undefined
      ? { kind: "not_found" }
      : { kind: "stale", capture: current };
  }
  return { kind: "resolved", capture: resolved.value };
}

function storedCapture(json: string): CommerceUnplacedCaptureV1 {
  const parsed = parseCommerceUnplacedCaptureV1(JSON.parse(json));
  if (!parsed.ok) throw new Error("A stored unplaced capture is not valid");
  return parsed.value;
}
