import {
  parseMailSenderLinkRequest,
  type MailSenderLink,
} from "@purin-labs/control-api";
import { sha256Hex } from "@purin-labs/std";
import {
  parseCommerceGraphQuery,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@purin-labs/commerce-client";

import { requireActiveOrganisationActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import { readEmailMailboxAccount } from "../../data/email-mailbox";
import { resolveActiveProviderAccountContext } from "@purin-labs/connections/data/integration-account";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import {
  linkSenderToSupplier,
  readSenderSupplierLink,
  senderLinkAddress,
} from "../../mail-inbox/sender-supplier-link";
import { admitUserMutation } from "@purin-labs/control/worker/admission/control-mutation";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import { commerceGraphReads } from "../../commerce/contract/graph-reads";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import { authorizeMailSource } from "../../mail-inbox/contract/mail-source-authorization";
import {
  mailControlAuthority,
} from "../../mail-inbox/contract/control-authority";
import { recordCommerceMutationReceipt } from "@purin-labs/control/worker/mutation-receipt";

/**
 * The supplier that one sender of a mailbox is linked to, for the Inbox.
 *
 * A member reads the link of an address. An administrator links the address
 * to a supplier of the Organisation, which makes it a verified supplier
 * contact of the mailbox. Mail admitted after that is bound to the supplier;
 * mail admitted before keeps the binding it got at admission.
 */
export async function handleAgentMailboxSenderLinks(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
  read: boolean,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  // The address is the sender's mail address: it travels in the body, never
  // in a URL that a log keeps.
  return read
    ? readSenderLink(request, env, organisationIdRaw, integrationAccountIdRaw)
    : linkSender(request, env, organisationIdRaw, integrationAccountIdRaw);
}

async function readSenderLink(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  // The address travels in a POST body, but the request only reads.
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    true,
    "disclose",
  );
  if (!authorized.ok) return authorized.response;
  const accountId = parseIntegrationAccountId(integrationAccountIdRaw);
  if (!accountId.ok) return controlError("agent_mailbox_missing", 404);
  const body = await readBoundedJsonRecord(request, 1_024);
  const address =
    body !== null &&
    Object.keys(body).length === 1 &&
    typeof body.address === "string"
      ? senderLinkAddress(body.address)
      : null;
  if (address === null) return controlError("mailbox_sender_link_invalid", 422);
  // The sender of a message is mail content: only a person who may read the
  // mailbox learns how its senders are linked.
  const authority = await mailControlAuthority(authorized);
  const source =
    authority === null
      ? null
      : await authorizeMailSource(env, authority, accountId.value);
  if (source === null) return controlError("agent_mailbox_missing", 404);
  const mailbox = await readEmailMailboxAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
  });
  if (!mailbox.ok) return controlError("agent_mailbox_missing", 404);
  const link = await readSenderSupplierLink({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
    address,
  });
  if (!link.ok) return controlError(link.error.code, 503);
  const supplierId = link.value.supplierId;
  if (supplierId === null)
    return controlJson(
      linkBody({ supplier: null, revision: link.value.revision }),
    );
  const supplier = await readSupplier(env, authorized, supplierId);
  return controlJson(
    linkBody({
      supplier: {
        supplierId,
        name: supplier.kind === "found" ? supplier.name : null,
      },
      revision: link.value.revision,
    }),
  );
}

async function linkSender(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const accountId = parseIntegrationAccountId(integrationAccountIdRaw);
  if (!accountId.ok) return controlError("agent_mailbox_missing", 404);
  const body = await readJsonRecord(request);
  const parsed = body.ok ? parseMailSenderLinkRequest(body.value) : null;
  const address = parsed === null ? null : senderLinkAddress(parsed.address);
  if (!body.ok || parsed === null || address === null)
    return controlError("mailbox_sender_link_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/agent-mailboxes/${accountId.value}/sender-links`,
    operation: "agent_mailbox.sender_link",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const mailbox = await activeGmailMailbox(authorized, accountId.value);
  if (mailbox === null) return controlError("agent_mailbox_missing", 404);
  // The mailbox does not answer itself.
  if (address === mailbox.observedAddress.trim().toLowerCase())
    return controlError("mailbox_sender_link_invalid", 422);
  const supplier = await readSupplier(env, authorized, parsed.supplierId);
  if (supplier.kind === "missing")
    return controlError("mailbox_sender_supplier_missing", 404);
  if (supplier.kind === "unavailable")
    return controlError("mailbox_sender_link_unavailable", 503);
  const now = Date.now();
  const linked = await linkSenderToSupplier({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: accountId.value,
    actorId: identity.userId,
    address,
    supplierId: parsed.supplierId,
    expectedRevision: parsed.expectedRevision,
    // One request is one command, also when it is sent again.
    commandId: `mailbox_sender_link:${await sha256Hex(
      `${identity.userId}\u0000${boundary.idempotencyKey}`,
    )}`,
    now,
  });
  if (!linked.ok)
    return controlError(
      linked.error.code,
      linked.error.code === "mailbox_sender_link_unavailable" ? 503 : 409,
    );
  // Collected evidence that rests on an earlier revision of this
  // verification is not used again.
  try {
    const organisation = await requireActiveOrganisationActorAtPlacement({
      env,
      placement: authorized.executionScope.placement,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    await organisation.invalidateCaseContextCollectionVerification({
      organisationId: authorized.organisationId,
      verificationId: linked.value.verificationId,
      revision: linked.value.revision,
    });
  } catch {
    return controlError("mailbox_sender_link_unavailable", 503);
  }
  const responseBody = linkBody({
    supplier: { supplierId: parsed.supplierId, name: supplier.name ?? null },
    revision: linked.value.revision,
  });
  const recorded = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recorded.ok) return controlError(recorded.error.code, 409);
  return controlJson(responseBody);
}

/** The mailbox when it is an active Gmail mailbox of this Organisation. */
async function activeGmailMailbox(
  authorized: AuthorizedOrganisationRequest,
  integrationAccountId: IntegrationAccountId,
): Promise<Readonly<{ observedAddress: string }> | null> {
  const [mailbox, account] = await Promise.all([
    readEmailMailboxAccount({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId,
    }),
    resolveActiveProviderAccountContext({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      integrationAccountId,
    }),
  ]);
  return mailbox.ok && account.ok && account.value.account.provider === "gmail"
    ? { observedAddress: mailbox.value.observedAddress }
    : null;
}

type SupplierRead =
  | Readonly<{ kind: "found"; name: string }>
  | Readonly<{ kind: "missing" | "unavailable"; name?: never }>;

/**
 * One supplier of the Organisation, read from its commerce data with the
 * person's own read authority, as the Suppliers page reads it.
 */
async function readSupplier(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  supplierId: string,
): Promise<SupplierRead> {
  let query;
  try {
    query = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: SUPPLIER_ENTITY_TYPE_ID,
        entityId: supplierId,
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    });
  } catch {
    return { kind: "missing" };
  }
  const reads = commerceGraphReads.use();
  const graph = await reads.openControlCommerceGraph(env, authorized);
  if (!graph.ok) return { kind: "unavailable" };
  const now = Date.now();
  const authority = reads.commerceGraphControlAuthority({
    organisationId: authorized.organisationId,
    merchantId: graph.value.merchantId,
    principalId: authorized.authenticated.session.userId,
    sensitivityCeiling: reads.controlCommerceSensitivityCeiling(authorized),
    query,
    now,
  });
  if (!authority.ok) return { kind: "unavailable" };
  let result;
  try {
    result = await graph.value.reader.query({
      query,
      authority: authority.value,
      now: new Date(now).toISOString(),
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (!result.ok) return { kind: "unavailable" };
  for (const entity of result.value.entities)
    if (
      entity.reference.origin === "custom" &&
      entity.reference.typeId === SUPPLIER_ENTITY_TYPE_ID &&
      entity.reference.entityId === supplierId
    )
      return { kind: "found", name: entity.displayName };
  return { kind: "missing" };
}

function linkBody(link: MailSenderLink): Readonly<{
  ok: true;
  link: MailSenderLink;
}> {
  return { ok: true, link };
}
