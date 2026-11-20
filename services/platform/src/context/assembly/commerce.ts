import type {
  CommerceAuthorityContext,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceSensitivity,
  RequestAuthority,
  PantryCommerceReadAuthority,
  CommerceContextRequest,
} from "@purin-labs/contracts";
import {
  parseCommerceCommandId,
  parseCommerceMerchantId,
  parseCommercePrincipalId,
  parseCommerceTimestamp,
} from "@purin-labs/commerce-client";
import { ToolRequestError } from "../../agent-tools/errors";
import type { Result } from "../../result";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import {
  compileCommerceReadAuthorities,
  selectActiveGrants,
} from "../../authorization/access-grants/compiler";
import type { AccessGrant } from "../../authorization/access-grants/types";
import type { RequestableEntityTypeRead } from "../../authorization/requestable-capabilities";
import { enforceCommerceGraphReadAuthority } from "../../commerce/entity-plane/authority";
import {
  CommerceGraphReader,
  type CommerceGraphReaderError,
} from "../../commerce/entity-plane/graph-reader";
import { sensitivityAtMost } from "../../commerce/sensitivity";

export type CommerceContextAssemblyError =
  | CommerceGraphReaderError
  | Readonly<{
      code:
        | "commerce_context_sensitivity_denied"
        | "commerce_context_authority_denied";
    }>
  /**
   * A grant covers this query's scope, but the request authority's sensitivity
   * ceiling is below what the query needs. Distinct from having no grant at
   * all: the caller may be able to ask again under stronger authority.
   */
  | Readonly<{ code: "commerce_context_ceiling_denied" }>;

export class CommerceReadRequestError extends ToolRequestError {
  constructor(
    readonly failure: CommerceContextAssemblyError,
    /**
     * The record type or types whose read grants would admit this read, when a
     * permission request may ask for them.
     */
    requestableRead:
      | RequestableEntityTypeRead
      | readonly RequestableEntityTypeRead[]
      | null = null,
  ) {
    super(describeCommerceReadFailure(failure), requestableRead);
  }
}

function describeCommerceReadFailure(
  failure: CommerceContextAssemblyError,
): string {
  switch (failure.code) {
    case "commerce_context_authority_denied":
      return "Commerce read denied (commerce_context_authority_denied). No active grant covers this query for the current conversation and merchant. If request_permission is available, call it and name the read that is missing. If it is not available, tell the person which read is missing. Do not send the person to a settings page. Do not retry this denied read.";
    case "commerce_context_sensitivity_denied":
    case "commerce_context_ceiling_denied":
      return `Commerce read denied (${failure.code}). The request's sensitivity ceiling does not permit this query. Ask an authorized operator to review access controls, then start a new turn. Do not retry this denied read.`;
    default:
      return `Commerce read unavailable (${failure.code}). Authoritative evidence was not obtained.`;
  }
}

type PreparedCommerceContextRead = Readonly<{
  readonly query: CommerceGraphQuery;
  readonly authority: PantryCommerceReadAuthority;
  readonly sourceGrantId: string;
}>;

/**
 * Runs one named commerce query under the Case's own read authority.
 *
 * Named reports issue aggregation and entity-page queries rather than a
 * context request, but they must clear the same sensitivity ceiling and grant
 * compilation. This shares that boundary instead of adding a second one.
 */
export async function readNamedCommerceQuery(
  input: Readonly<{
    readonly organisationId: string;
    readonly merchantId: string;
    readonly grants: readonly AccessGrant[];
    readonly requestAuthority: RequestAuthority;
    readonly causationId: string;
    readonly query: CommerceGraphQuery;
    readonly allowedSensitivity: CommerceSensitivity;
    readonly reader: CommerceGraphReader;
    readonly now: string;
  }>,
): Promise<Result<CommerceGraphQueryResult, CommerceContextAssemblyError>> {
  const prepared = prepareNamedCommerceQuery(input);
  if (!prepared.ok) return prepared;
  return input.reader.query({
    query: prepared.value.query,
    authority: prepared.value.authority,
    now: input.now,
  });
}

/** Keeps graph authority construction private to Pantry's context boundary. */
export async function assembleCommerceContext(
  input: Readonly<{
    readonly organisationId: string;
    readonly merchantId: string;
    readonly grants: readonly AccessGrant[];
    readonly requestAuthority: RequestAuthority;
    readonly causationId: string;
    readonly request: CommerceContextRequest;
    readonly reader: CommerceGraphReader;
    readonly now: string;
  }>,
): Promise<Result<CommerceGraphQueryResult, CommerceContextAssemblyError>> {
  const prepared = prepareCommerceContextRead(input);
  if (!prepared.ok) return prepared;
  return input.reader.query({
    query: prepared.value.query,
    authority: prepared.value.authority,
    now: input.now,
  });
}

export function selectCommerceContextSourceGrant(
  input: Readonly<{
    readonly organisationId: string;
    readonly merchantId: string;
    readonly grants: readonly AccessGrant[];
    readonly requestAuthority: RequestAuthority;
    readonly causationId: string;
    readonly request: CommerceContextRequest;
    readonly now: string;
  }>,
): Result<AccessGrant, CommerceContextAssemblyError> {
  const prepared = prepareCommerceContextRead(input);
  if (!prepared.ok) return prepared;
  for (const grant of input.grants) {
    if (
      grant.grantId === prepared.value.sourceGrantId &&
      grant.lifecycle.kind === "active"
    ) {
      return { ok: true, value: grant };
    }
  }
  return { ok: false, error: { code: "commerce_context_authority_denied" } };
}

export function selectNamedCommerceQuerySourceGrant(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    requestAuthority: RequestAuthority;
    causationId: string;
    query: CommerceGraphQuery;
    allowedSensitivity: CommerceSensitivity;
    now: string;
  }>,
): Result<AccessGrant, CommerceContextAssemblyError> {
  const prepared = prepareNamedCommerceQuery(input);
  if (!prepared.ok) return prepared;
  for (const grant of input.grants) {
    if (grant.grantId === prepared.value.sourceGrantId)
      return { ok: true, value: grant };
  }
  return { ok: false, error: { code: "commerce_context_authority_denied" } };
}

export function prepareNamedCommerceQuery(
  input: Omit<Parameters<typeof readNamedCommerceQuery>[0], "reader">,
): Result<PreparedCommerceContextRead, CommerceContextAssemblyError> {
  const ceiling = sensitivityCeiling(input.requestAuthority);
  if (!sensitivityAtMost(input.allowedSensitivity, ceiling)) {
    return {
      ok: false,
      error: { code: "commerce_context_sensitivity_denied" },
    };
  }
  const authority = commerceContextAuthority({
    grants: input.grants,
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    requestAuthority: input.requestAuthority,
    query: input.query,
    sensitivityCeiling: ceiling,
    now: input.now,
    causationId: input.causationId,
  });
  if (!authority.ok) return authority;
  return {
    ok: true,
    value: {
      query: input.query,
      authority: authority.value.authority,
      sourceGrantId: authority.value.sourceGrantId,
    },
  };
}

function prepareCommerceContextRead(
  input: Readonly<{
    readonly organisationId: string;
    readonly merchantId: string;
    readonly grants: readonly AccessGrant[];
    readonly requestAuthority: RequestAuthority;
    readonly causationId: string;
    readonly request: CommerceContextRequest;
    readonly now: string;
  }>,
): Result<PreparedCommerceContextRead, CommerceContextAssemblyError> {
  const query: CommerceGraphQuery = {
    kind: "underclerk_context",
    ...input.request,
  };
  const ceiling = sensitivityCeiling(input.requestAuthority);
  if (!sensitivityAtMost(input.request.allowedSensitivity, ceiling)) {
    return {
      ok: false,
      error: { code: "commerce_context_sensitivity_denied" },
    };
  }
  const authority = commerceContextAuthority({
    grants: input.grants,
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    requestAuthority: input.requestAuthority,
    query,
    sensitivityCeiling: ceiling,
    now: input.now,
    causationId: input.causationId,
  });
  if (!authority.ok) return authority;
  return {
    ok: true,
    value: {
      query,
      authority: authority.value.authority,
      sourceGrantId: authority.value.sourceGrantId,
    },
  };
}

function commerceContextAuthority(
  input: Readonly<{
    readonly grants: readonly AccessGrant[];
    readonly organisationId: string;
    readonly merchantId: string;
    readonly requestAuthority: RequestAuthority;
    readonly query: CommerceGraphQuery;
    readonly sensitivityCeiling: CommerceSensitivity;
    readonly now: string;
    readonly causationId: string;
  }>,
): Result<
  Readonly<{
    readonly authority: PantryCommerceReadAuthority;
    readonly sourceGrantId: string;
  }>,
  CommerceContextAssemblyError
> {
  const organisation = parseOrganisationId(input.organisationId);
  if (!organisation.ok)
    return { ok: false, error: { code: "commerce_context_authority_denied" } };
  const context = parseCommerceContext({
    organisationId: organisation.value,
    merchantId: input.merchantId,
    principalId: principalId(input.requestAuthority),
    sensitivityCeiling: input.sensitivityCeiling,
    expiresAt: new Date(Date.parse(input.now) + 60_000).toISOString(),
    causationId: input.causationId,
  });
  if (!context.ok)
    return { ok: false, error: { code: "commerce_context_authority_denied" } };
  const selected = selectActiveGrants({
    organisationId: organisation.value,
    authority: input.requestAuthority,
    grants: input.grants,
  });
  if (!selected.ok)
    return { ok: false, error: { code: "commerce_context_authority_denied" } };
  const compiled = compileCommerceReadAuthorities({
    organisationId: organisation.value,
    authority: input.requestAuthority,
    // Shared replies require a source grant for the conversation's audience.
    selectedGrants:
      input.requestAuthority.kind === "shared_conversation"
        ? selected.value.filter(hasConversationSubject)
        : selected.value,
    capabilityId: "commerce.entity.read",
    capabilityVersion: 1,
    context: context.value,
  });
  if (!compiled.ok)
    return { ok: false, error: { code: "commerce_context_authority_denied" } };
  // A ceiling refusal means a grant matched but the authority is too weak; it
  // must not be reported as a missing grant.
  let ceilingDenied = false;
  for (const candidate of compiled.value) {
    const enforced = enforceCommerceGraphReadAuthority({
      organisationId: input.organisationId,
      query: input.query,
      authority: candidate.authority,
      now: input.now,
    });
    if (enforced.ok) {
      return {
        ok: true,
        value: {
          authority: enforced.value,
          sourceGrantId: candidate.grantId,
        },
      };
    }
    if (enforced.error.code === "sensitivity_denied") ceilingDenied = true;
  }
  if (ceilingDenied)
    return { ok: false, error: { code: "commerce_context_ceiling_denied" } };
  return { ok: false, error: { code: "commerce_context_authority_denied" } };
}

function parseCommerceContext(
  input: Readonly<{
    readonly organisationId: OrganisationId;
    readonly merchantId: string;
    readonly principalId: string;
    readonly sensitivityCeiling: CommerceSensitivity;
    readonly expiresAt: string;
    readonly causationId: string;
  }>,
): Result<CommerceAuthorityContext, CommerceContextAssemblyError> {
  try {
    return {
      ok: true,
      value: {
        organisationId: input.organisationId,
        merchantId: parseCommerceMerchantId(input.merchantId),
        principalId: parseCommercePrincipalId(input.principalId),
        sensitivityCeiling: input.sensitivityCeiling,
        expiresAt: parseCommerceTimestamp(input.expiresAt),
        causation: {
          kind: "command",
          commandId: parseCommerceCommandId(input.causationId),
        },
      },
    };
  } catch {
    return { ok: false, error: { code: "commerce_context_authority_denied" } };
  }
}

function principalId(authority: RequestAuthority): string {
  switch (authority.kind) {
    case "direct_conversation":
    case "shared_conversation":
    case "control":
      return authority.requesterPersonId;
    case "workflow":
      return authority.workflowId;
    case "agent_mailbox":
      return authority.mailboxBindingId;
    case "whatsapp_support":
      return authority.supportBindingId;
  }
}

function sensitivityCeiling(authority: RequestAuthority): CommerceSensitivity {
  switch (authority.kind) {
    case "direct_conversation":
    case "shared_conversation":
    case "control":
      return authority.role === "viewer" ? "internal" : "restricted";
    case "workflow":
    case "agent_mailbox":
    case "whatsapp_support":
      return "internal";
  }
}

function hasConversationSubject(grant: AccessGrant): boolean {
  return grant.subject.kind === "conversation";
}
