import type {
  MailReplyEdit,
  MailRelationshipLookup,
  MailReplyCorrection,
  MailReplySourceRecord,
} from "./mail-reply";

const edit: MailReplyEdit = {
  version: 1,
  snapshotDigest: "0".repeat(64),
  challenge: "reviewed-snapshot",
  body: "Please confirm the revised delivery date.",
};

const redirected = { ...edit, to: "another@example.test" };
// @ts-expect-error Body editing cannot redirect an existing reply.
export const redirectedEdit: MailReplyEdit = redirected;

// @ts-expect-error Editing requires the exact preview version and digest.
export const unversionedEdit: MailReplyEdit = {
  body: edit.body,
  challenge: edit.challenge,
};

// @ts-expect-error Supplier discovery cannot carry a selected purchase request.
export const invalidDiscovery: MailRelationshipLookup = {
  kind: "suppliers",
  supplierEntryId: "directory_supplier",
  purchaseRequestId: "PR-A",
};

// @ts-expect-error A correction requires the reviewed canonical relationship digest.
export const unboundCorrection: MailReplyCorrection = {
  version: edit.version,
  snapshotDigest: edit.snapshotDigest,
  challenge: edit.challenge,
  body: edit.body,
  supplierEntryId: "directory_supplier",
  purchaseRequestId: "PR-A",
};

// @ts-expect-error An order source names its order, not a Memory revision.
export const mixedSourceRecord: MailReplySourceRecord = {
  kind: "order",
  orderId: "order_1042",
  revision: 2,
};
