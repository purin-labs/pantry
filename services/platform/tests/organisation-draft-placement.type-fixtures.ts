import type { CollaborationMutationAuthority } from "@purin-labs/collaboration/worker/collaboration-room";
import type { ProductDescriptionDraftRooms } from "../src/actors/product-description-draft";
import type { EmailDraftRooms } from "../src/actors/email-draft";

declare const authority: CollaborationMutationAuthority;
const { scope, ...unscopedAuthority } = authority;
void scope;
// @ts-expect-error A collaboration mutation must retain its admitted placement.
const invalidAuthority: CollaborationMutationAuthority = unscopedAuthority;
void invalidAuthority;
declare const product: ProductDescriptionDraftRooms;
declare const productEdit: Parameters<ProductDescriptionDraftRooms["edit"]>[0];
// @ts-expect-error Product edits cannot select placement after admission.
void product.edit(productEdit);
declare const email: EmailDraftRooms;
declare const emailEdit: Parameters<EmailDraftRooms["edit"]>[0];
// @ts-expect-error Email edits require the same admitted scope.
void email.edit(emailEdit);

const { origin, ...originlessAuthority } = authority;
void origin;
// @ts-expect-error A queued mutation must retain its originating session.
const invalidOriginlessAuthority: CollaborationMutationAuthority =
  originlessAuthority;
void invalidOriginlessAuthority;
const { execution, ...originlessProductEdit } = productEdit;
void execution;
// @ts-expect-error Agent edits require their captured Session execution.
void product.edit(originlessProductEdit, scope);
const { execution: emailExecution, ...originlessEmailEdit } = emailEdit;
void emailExecution;
// @ts-expect-error Email edits require their captured Session execution.
void email.edit(originlessEmailEdit, scope);

declare const controlSessionId: import("@purin-labs/kernel/ids").ControlSessionId;
const invalidHumanOrigin: CollaborationMutationAuthority = {
  ...authority,
  // @ts-expect-error Human origin cannot carry an agent execution identity.
  origin: {
    kind: "control_session",
    controlSessionId,
    execution: productEdit.execution,
  },
};
void invalidHumanOrigin;
