import {
  listSupplierPayoutExceptions,
  readSupplierPayoutAuditEvents,
} from "../../data/supplier-payout-event-inbox";
import { listSupplierPayoutAttempts } from "../../data/supplier-payout-attempt";
import type { Env } from "@purin-labs/kernel/env";
import { admitUserMutation } from "@purin-labs/control/worker/admission/control-mutation";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "@purin-labs/control/worker/http";
import {
  type UnversionedControlMutationBoundary,
  type ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";
import {
  listSupplierPayoutsForSupplier,
  listSupplierPayoutsInWindow,
  listUnresolvedSupplierPayouts,
  readSupplierPayout,
  type SupplierPayoutRow,
} from "../../data/supplier-payout-store";
import {
  readSupplierDestinationRevision,
  writeSupplierDestinationRevision,
} from "../../data/supplier-payable-store";
import { proposeSupplierPayout } from "../../payouts/supplier-payout-service";
import { applySupplierPayableCommandWithLexicon } from "../../commerce/commerce-wasm";
import { recordCommerceMutationReceipt } from "@purin-labs/control/worker/mutation-receipt";
import { listAccessGrants } from "@purin-labs/authority/data/access-grants";
import { selectActiveGrants } from "@purin-labs/authority/authorization/access-grants/compiler";
import { evaluateFlowLabelSink } from "@purin-labs/authority/policy/index";
import { supplierPayoutLabel } from "../../payouts/supplier-payout-access";
import {
  mailControlAuthority,
} from "../../mail-inbox/contract/control-authority";
import type { Variant } from "@purin-labs/type-utils";

/**
 * The operator surface for money leaving the merchant.
 *
 * Reads and proposals are here; sending is not. A payout is submitted by the
 * runtime once a certified provider exists, and exposing a "send now" button
 * before then would offer an operator an action Pantry cannot honour.
 *
 * Destination activation is the sharpest edge on this surface. Whoever wrote a
 * supplier's bank details must not be the one who puts them into force, and
 * that is enforced by the schema, by the payout service at approval, and again
 * here — a separation that holds at only one of its gates is not one.
 */
export type SupplierPayoutControlRoute =
  | Readonly<{
      kind: "supplierPayoutAudit";
      organisationIdRaw: string;
      payoutIdRaw: string;
    }>
  | Readonly<{ kind: "supplierPayouts"; organisationIdRaw: string }>
  | Readonly<{
      kind: "supplierPayout";
      organisationIdRaw: string;
      payoutIdRaw: string;
    }>
  | Readonly<{ kind: "supplierDestinations"; organisationIdRaw: string }>
  | Readonly<{
      kind: "supplierDestinationActivation";
      organisationIdRaw: string;
      revisionIdRaw: string;
    }>;

/** A local month is at most 31 days and one hour. */
const MAX_TIMELINE_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

type StartedMutation = Readonly<{
  authorized: AuthorizedOrganisationRequest;
  identity: Readonly<{
    issuer: string;
    subject: string;
    userId: string;
  }>;
  scope: ControlMutationReceiptScope;
  boundary: UnversionedControlMutationBoundary;
  body: JsonRecord;
  now: number;
}>;

export function matchSupplierPayoutControlRoute(
  pathname: string,
): SupplierPayoutControlRoute | null {
  const audit = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/supplier-payouts\/([^/]+)\/audit$/u,
  );
  if (audit !== null)
    return {
      kind: "supplierPayoutAudit",
      organisationIdRaw: decode(audit[0]),
      payoutIdRaw: decode(audit[1]),
    };
  const activation = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/supplier-destinations\/([^/]+)\/activation$/u,
  );
  if (activation !== null) {
    return {
      kind: "supplierDestinationActivation",
      organisationIdRaw: decode(activation[0]),
      revisionIdRaw: decode(activation[1]),
    };
  }
  const destinations = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/supplier-destinations$/u,
  );
  if (destinations !== null) {
    return {
      kind: "supplierDestinations",
      organisationIdRaw: decode(destinations[0]),
    };
  }
  const payout = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/supplier-payouts\/([^/]+)$/u,
  );
  if (payout !== null) {
    return {
      kind: "supplierPayout",
      organisationIdRaw: decode(payout[0]),
      payoutIdRaw: decode(payout[1]),
    };
  }
  const payouts = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/supplier-payouts$/u,
  );
  return payouts === null
    ? null
    : { kind: "supplierPayouts", organisationIdRaw: decode(payouts[0]) };
}

export function handleSupplierPayoutControlRoute(
  request: Request,
  env: Env,
  route: SupplierPayoutControlRoute,
  url: URL,
): Promise<Response> {
  switch (route.kind) {
    case "supplierPayoutAudit":
      return handleSupplierPayoutAudit(request, env, route, url);
    case "supplierPayouts":
      return handleSupplierPayouts(request, env, route.organisationIdRaw, url);
    case "supplierPayout":
      return handleSupplierPayoutRead(request, env, route);
    case "supplierDestinations":
      return handleDestinationProposal(request, env, route.organisationIdRaw);
    case "supplierDestinationActivation":
      return handleDestinationActivation(request, env, route);
  }
}

async function handleSupplierPayouts(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  url: URL,
): Promise<Response> {
  if (request.method === "POST")
    return handlePayoutProposal(request, env, organisationIdRaw);
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  if (!(await payoutReadAllowed(authorized)))
    return controlError("supplier_payout_read_unavailable", 403);
  if (url.searchParams.get("view") === "exceptions") {
    const cursor = url.searchParams.get("after") ?? "0";
    if (!/^\d+$/u.test(cursor) || !Number.isSafeInteger(Number(cursor)))
      return controlError("audit_cursor_invalid", 422);
    return controlJson({
      ok: true,
      ...(await listSupplierPayoutExceptions(
        authorized.executionScope.database,
        authorized.organisationId,
        Number(cursor),
      )),
    });
  }
  if (url.searchParams.get("view") === "timeline") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      from >= to ||
      to - from > MAX_TIMELINE_WINDOW_MS
    )
      return controlError("supplier_payout_window_invalid", 422);
    const dated = await listSupplierPayoutsInWindow(
      authorized.executionScope.database,
      authorized.organisationId,
      { from, to },
    );
    return controlJson({
      ok: true,
      truncated: dated.truncated,
      supplierPayouts: dated.payouts.map((payout) => ({
        ...summarize(payout),
        createdAt: payout.createdAt,
        updatedAt: payout.updatedAt,
      })),
    });
  }
  const supplierId = url.searchParams.get("supplierId");
  // With no supplier named, the default view is the work queue: everything
  // whose outcome Pantry does not yet know.
  const payouts =
    supplierId === null
      ? await listUnresolvedSupplierPayouts(
          authorized.executionScope.database,
          authorized.organisationId,
        )
      : await listSupplierPayoutsForSupplier(
          authorized.executionScope.database,
          authorized.organisationId,
          supplierId,
        );
  return controlJson({ ok: true, supplierPayouts: payouts.map(summarize) });
}

async function handleSupplierPayoutRead(
  request: Request,
  env: Env,
  route: Variant<SupplierPayoutControlRoute, "supplierPayout">,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  if (!(await payoutReadAllowed(authorized)))
    return controlError("supplier_payout_read_unavailable", 403);
  const payout = await readSupplierPayout(
    authorized.executionScope.database,
    authorized.organisationId,
    route.payoutIdRaw,
  );
  return payout === undefined
    ? controlError("supplier_payout_not_found", 404)
    : controlJson({ ok: true, supplierPayout: summarize(payout) });
}

async function handleSupplierPayoutAudit(
  request: Request,
  env: Env,
  route: Variant<SupplierPayoutControlRoute, "supplierPayoutAudit">,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const cursor = url.searchParams.get("after") ?? "0";
  if (!/^\d+$/u.test(cursor) || !Number.isSafeInteger(Number(cursor)))
    return controlError("audit_cursor_invalid", 422);
  if (!(await payoutReadAllowed(authorized)))
    return controlError("supplier_payout_read_unavailable", 403);
  const payout = await readSupplierPayout(
    authorized.executionScope.database,
    authorized.organisationId,
    route.payoutIdRaw,
  );
  if (payout === undefined)
    return controlError("supplier_payout_not_found", 404);
  const destination = await readSupplierDestinationRevision(
    authorized.executionScope.database,
    authorized.organisationId,
    payout.destinationRevisionId,
  );
  const attempts = await listSupplierPayoutAttempts(
    authorized.executionScope.database,
    authorized.organisationId,
    payout.payoutId,
  );
  const evidence = await readSupplierPayoutAuditEvents(
    authorized.executionScope.database,
    authorized.organisationId,
    payout.payoutId,
    Number(cursor),
  );
  const response = controlJson({
    ok: true,
    supplierPayout: summarize(payout),
    approvalDigest: payout.approvalDigest,
    maskedDestination: destination?.maskedSummary ?? null,
    attempts,
    ...evidence,
  });
  response.headers.set(
    "content-disposition",
    'attachment; filename="supplier-payout-audit.json"',
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

/**
 * Whether this person may see supplier payout figures.
 *
 * A Portal read reaches only the person who asks, so a payout read grant to
 * that person or to their role admits it, and the organisation must have
 * enabled payout reads. The route's role says who may open the page; the
 * grant says who may see the figures on it.
 */
async function payoutReadAllowed(
  authorized: AuthorizedOrganisationRequest,
): Promise<boolean> {
  const db = authorized.executionScope.database;
  const organisationId = authorized.organisationId;
  const [authority, grants] = await Promise.all([
    mailControlAuthority(authorized),
    listAccessGrants({ db, organisationId, lifecycle: "active" }),
  ]);
  if (authority === null || !grants.ok) return false;
  const selected = selectActiveGrants({
    organisationId,
    authority,
    grants: grants.value,
  });
  if (!selected.ok) return false;
  const label = await supplierPayoutLabel({
    db,
    organisationId,
    grants: selected.value,
  });
  return (
    label !== null &&
    evaluateFlowLabelSink({
      flowLabel: label,
      organisationAuthz: null,
      sink: { kind: "conversation_delivery", destinationAuthority: authority },
    }).kind === "allow"
  );
}

/**
 * Propose a payout.
 *
 * Nothing is sent and nothing is approved: the result is a payout awaiting an
 * approver, with the payable's money already held so two proposals cannot both
 * spend the same remaining balance.
 */
async function handlePayoutProposal(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const started = await beginMutation(
    request,
    env,
    organisationIdRaw,
    "supplier_payout.propose",
    "operator",
  );
  if (started instanceof Response) return started;
  const proposal = parseProposal(started.body);
  if (proposal === null)
    return controlError("supplier_payout_request_invalid", 422);

  const proposed = await proposeSupplierPayout({
    db: started.authorized.executionScope.database,
    organisationId: started.authorized.organisationId,
    payableId: proposal.payableId,
    destinationId: proposal.destinationId,
    // Both identities derive from the operator's key, so a retried proposal is
    // the same payout rather than a second one against the same payable.
    payoutId: `supplier_payout_${started.boundary.idempotencyKey}`,
    proposalId: `proposal_${started.boundary.idempotencyKey}`,
    idempotencyKey: started.boundary.idempotencyKey,
    recipientAmountMinor: proposal.recipientAmountMinor,
    feeCeilingMinor: proposal.feeCeilingMinor,
    rail: proposal.rail,
    integrationAccountId: proposal.integrationAccountId,
    expiresAt: new Date(started.now + PROPOSAL_TTL_MS).toISOString(),
    now: started.now,
    applyPayableCommand: applySupplierPayableCommandWithLexicon,
  });
  if (!proposed.ok) {
    const status = proposed.error === "payout_exists" ? 409 : 422;
    return controlJson(
      {
        ok: false,
        error: proposed.error,
        supplierPayout:
          proposed.existing === undefined ? null : summarize(proposed.existing),
      },
      status,
    );
  }
  const responseBody = { ok: true, supplierPayout: summarize(proposed.payout) };
  const recordedMutationReceipt = await completeMutation(
    request,
    started,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

/** An approval that is not acted on promptly is re-quoted, not resurrected. */
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Record proposed bank details.
 *
 * The details themselves never reach this response or any log — only the masked
 * summary does. What is stored here is a revision that an approval can point at
 * and be certain will not change under it.
 */
async function handleDestinationProposal(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    organisationIdRaw,
    "supplier_destination.propose",
    "operator",
  );
  if (started instanceof Response) return started;
  const destination = parseDestination(started.body);
  if (destination === null)
    return controlError("supplier_destination_request_invalid", 422);

  const written = await writeSupplierDestinationRevision({
    db: started.authorized.executionScope.database,
    organisationId: started.authorized.organisationId,
    destination: {
      revisionId: `destination_revision_${started.boundary.idempotencyKey}`,
      destinationId: destination.destinationId,
      supplierId: destination.supplierId,
      rail: destination.rail,
      maskedSummary: destination.maskedSummary,
      configurationRef: destination.configurationRef,
      // Proposed, never active. Activation is a separate act by a separate
      // person, and that is the whole point of recording who proposed it.
      state: "draft",
      proposedBy: started.identity.userId,
      activatedBy: null,
      revision: 1,
      destinationJson: JSON.stringify({
        destinationId: destination.destinationId,
        rail: destination.rail,
        maskedSummary: destination.maskedSummary,
      }),
    },
    now: started.now,
  });
  if (!written) return controlError("supplier_destination_conflict", 409);
  const responseBody = {
    ok: true,
    supplierDestination: {
      revisionId: `destination_revision_${started.boundary.idempotencyKey}`,
      state: "draft",
      maskedSummary: destination.maskedSummary,
    },
  };
  const recordedMutationReceipt = await completeMutation(
    request,
    started,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

/**
 * Put proposed bank details into force.
 *
 * Admin, and never the proposer. The schema refuses the same identity in both
 * columns; this refuses it before the write, so an operator is told why rather
 * than seeing a constraint error.
 */
async function handleDestinationActivation(
  request: Request,
  env: Env,
  route: Variant<SupplierPayoutControlRoute, "supplierDestinationActivation">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    "supplier_destination.activate",
    "admin",
  );
  if (started instanceof Response) return started;

  const existing = await readSupplierDestinationRevision(
    started.authorized.executionScope.database,
    started.authorized.organisationId,
    route.revisionIdRaw,
  );
  if (existing === undefined)
    return controlError("supplier_destination_not_found", 404);
  if (existing.state !== "draft" && existing.state !== "verified") {
    return controlError("supplier_destination_not_activatable", 409);
  }
  if (existing.proposedBy === started.identity.userId) {
    return controlJson({ ok: false, error: "activator_is_proposer" }, 409);
  }

  const activated = await writeSupplierDestinationRevision({
    db: started.authorized.executionScope.database,
    organisationId: started.authorized.organisationId,
    destination: {
      ...existing,
      state: "active",
      activatedBy: started.identity.userId,
    },
    now: started.now,
  });
  if (!activated) return controlError("supplier_destination_conflict", 409);
  const responseBody = {
    ok: true,
    supplierDestination: {
      revisionId: existing.revisionId,
      state: "active",
      maskedSummary: existing.maskedSummary,
    },
  };
  const recordedMutationReceipt = await completeMutation(
    request,
    started,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

/**
 * What an operator may see about a payout.
 *
 * The masked summary and the destination revision are here; nothing that could
 * reconstruct a bank account is. A payout surface exists to answer "did this
 * supplier get paid", not to be a second copy of their details.
 */
function summarize(payout: SupplierPayoutRow): Record<string, unknown> {
  return {
    payoutId: payout.payoutId,
    payableId: payout.payableId,
    supplierId: payout.supplierId,
    rail: payout.rail,
    destinationRevisionId: payout.destinationRevisionId,
    currency: payout.currency,
    recipientAmountMinor: payout.recipientAmountMinor,
    feeCeilingMinor: payout.feeCeilingMinor,
    state: payout.stateKind,
    approved: payout.approvalDigest !== null,
    revision: payout.revision,
  };
}

function parseProposal(body: JsonRecord): Readonly<{
  payableId: string;
  destinationId: string;
  recipientAmountMinor: number;
  feeCeilingMinor: number;
  rail: SupplierPayoutRow["rail"];
  integrationAccountId: string;
}> | null {
  const {
    payableId,
    destinationId,
    recipientAmountMinor,
    feeCeilingMinor,
    rail,
    integrationAccountId,
  } = body;
  if (typeof payableId !== "string" || payableId.length === 0) return null;
  if (typeof destinationId !== "string" || destinationId.length === 0)
    return null;
  if (
    typeof integrationAccountId !== "string" ||
    integrationAccountId.length === 0
  )
    return null;
  if (rail !== "gmo_aozora_private" && rail !== "wise_enterprise_payouts")
    return null;
  if (
    !Number.isSafeInteger(recipientAmountMinor) ||
    Number(recipientAmountMinor) <= 0
  )
    return null;
  if (!Number.isSafeInteger(feeCeilingMinor) || Number(feeCeilingMinor) < 0)
    return null;
  return {
    payableId,
    destinationId,
    recipientAmountMinor: Number(recipientAmountMinor),
    feeCeilingMinor: Number(feeCeilingMinor),
    rail,
    integrationAccountId,
  };
}

function parseDestination(body: JsonRecord): Readonly<{
  destinationId: string;
  supplierId: string;
  rail: string;
  maskedSummary: string;
  configurationRef: string;
}> | null {
  const { destinationId, supplierId, rail, maskedSummary, configurationRef } =
    body;
  if (typeof destinationId !== "string" || destinationId.length === 0)
    return null;
  if (typeof supplierId !== "string" || supplierId.length === 0) return null;
  if (rail !== "gmo_aozora_domestic" && rail !== "wise_recipient") return null;
  if (typeof configurationRef !== "string" || configurationRef.length === 0)
    return null;
  if (typeof maskedSummary !== "string" || maskedSummary.length === 0)
    return null;
  // A summary containing a long run of digits is not masked, whatever it is
  // called. Storing one would put an account number on every screen that shows
  // a payout.
  if (/\d{7,}/u.test(maskedSummary)) return null;
  return { destinationId, supplierId, rail, maskedSummary, configurationRef };
}

async function beginMutation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  operation: string,
  role: "operator" | "admin",
): Promise<StartedMutation | Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    role,
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("supplier_payout_request_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/supplier-payouts`,
    operation,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  return {
    authorized,
    identity,
    scope,
    boundary,
    body: body.value,
    now: Date.now(),
  };
}

function completeMutation(
  request: Request,
  started: StartedMutation,
  responseBody: unknown,
): ReturnType<typeof recordCommerceMutationReceipt> {
  return recordCommerceMutationReceipt({
    authorized: started.authorized,
    identity: started.identity,
    scope: started.scope,
    boundary: started.boundary,
    request,
    responseBody,
    now: started.now,
  });
}

function match(pathname: string, pattern: RegExp): readonly string[] | null {
  const captures = pattern.exec(pathname);
  return captures === null ? null : captures.slice(1);
}

function decode(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Supplier payout route capture is missing");
  return decodeURIComponent(value);
}
