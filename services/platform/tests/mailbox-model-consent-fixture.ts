import { mailboxModelConsentRequest } from "@purin-labs/control-api";
import type { UserId } from "@purin-labs/control-api/ids";

import { newControlMutationIdentity } from "../src/data/control-mutation";
import type { Env } from "../src/env";
import {
  consentToGmailModel,
  readGmailModelState,
} from "../src/mail-inbox/gmail-model-consent";
import type { OrganisationExecutionScope } from "../src/organisation-execution-scope";

/**
 * An owner's acceptance of the data terms of the workspace's model for new
 * mail, as the checkbox beside Turn on gives it. The product's own consent
 * writes the record, so a fixture can accept only a model that Purin
 * reviewed (`gmail-model-reviews.ts`). The checkbox and its control route
 * have their own journey: tests/e2e/mailbox-setup.test.ts.
 */
export async function acceptMailboxModelTerms(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    userId: UserId;
  }>,
): Promise<void> {
  const now = Date.now();
  const model = await readGmailModelState({ ...input, now });
  if (model.kind !== "consent_needed" && model.kind !== "approved")
    throw new Error(`No reviewed model to accept: ${JSON.stringify(model)}`);
  const accepted = await consentToGmailModel({
    env: input.env,
    scope: input.scope,
    request: mailboxModelConsentRequest(model.review),
    consentedBy: input.userId,
    mutation: {
      boundary: {
        kind: "unversioned",
        idempotencyKey: crypto.randomUUID(),
        requestHash: "fixture",
      },
      scope: {
        userId: input.userId,
        organisationScope: input.scope.organisationId,
        route: "fixture:model-consent",
        operation: "agent_mailbox.model_consent",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "fixture",
        causationId: `fixture_${crypto.randomUUID()}`,
        now,
      }),
    },
    now,
  });
  if (!accepted.ok) throw new Error(accepted.error.code);
}
