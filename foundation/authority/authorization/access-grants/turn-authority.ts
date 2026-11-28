import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  OrganisationAccess,
  OrganisationAdmissionAction,
  OrganisationUserAuthority,
} from "@purin-labs/tenancy/organisation-access/access";
import type {
  AuthorityPartition,
  AuthorityPartitionKey,
  RequestAuthority,
  Sha256Digest,
} from "@purin-labs/contracts";

import { listAccessGrants } from "../../data/access-grants";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  readCurrentOrganisationPolicySnapshot,
  type PinnedSessionPolicy,
} from "../../policy-snapshot";
import {
  parseStoredRequestAuthority,
  validateLiveRequestAuthority,
} from "../../request-authority";
import type { Result } from "@purin-labs/kernel/result";
import {
  encodeCapabilityKey,
  parseCapabilityKey,
  type ProviderCapabilityDefinition,
} from "./capability-key";
import {
  compileSelectedGrantSet,
  selectActiveGrants,
  type EffectiveCapability,
  type EffectiveGrantCompileError,
  type ImmutableCapabilityDefinition,
} from "./compiler";
import type { AccessGrant } from "./types";
import { CAPABILITY_KEYS } from "../capability-catalogue";
import {
  assertNever,
  isRecord,
  positiveIntegerOrNull,
  sha256Hex,
} from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";

export const CONTEXT_CASE_READ_CAPABILITY = CAPABILITY_KEYS.contextCaseRead;
export const CASE_CONTEXT_COLLECTION_METADATA_READ_CAPABILITY =
  CAPABILITY_KEYS.caseContextCollectionMetadataRead;
export const CONTEXT_CASE_READ_SCOPE = encodeCapabilityKey({
  kind: "platform_capability",
  capabilityId: CONTEXT_CASE_READ_CAPABILITY,
  capabilityVersion: 1,
});

export type CompiledTurnAuthority = Readonly<{
  readonly accountAccess: OrganisationAccess;
  readonly userAuthority: OrganisationUserAuthority;
  readonly action: OrganisationAdmissionAction;
  readonly requestAuthority: RequestAuthority;
  readonly authorityPartition: AuthorityPartition;
  readonly effectiveGrantSet: Readonly<{
    readonly organisationId: OrganisationId;
    readonly authority: RequestAuthority;
    readonly selectedGrants: readonly AccessGrant[];
    readonly capabilities: readonly EffectiveCapability[];
  }>;
}>;

export type TurnAuthorityCompileError =
  | { readonly code: "request_authority_invalid"; readonly detail: string }
  | { readonly code: "request_authority_superseded"; readonly detail: string }
  | { readonly code: "request_authority_unavailable"; readonly detail: string }
  | { readonly code: "organisation_policy_superseded"; readonly detail: string }
  | {
      readonly code: "organisation_policy_unavailable";
      readonly detail: string;
    }
  | { readonly code: "access_grants_unavailable"; readonly detail: string }
  | { readonly code: "effective_grants_invalid"; readonly detail: string };

export type AuthorizedCapabilityClaim = Readonly<{
  readonly requested: ImmutableCapabilityDefinition;
  readonly admittedCapabilityKey: string;
}>;

export type AuthorizedCapabilityUse = Readonly<{
  readonly requestAuthority: RequestAuthority;
  readonly claims: readonly AuthorizedCapabilityClaim[];
}>;

export type CapabilityAuthorizationRequest = Readonly<{
  readonly capabilities: readonly ImmutableCapabilityDefinition[];
}>;

export type CapabilityAuthorizationError =
  | { readonly code: "request_authority_invalid"; readonly detail: string }
  | { readonly code: "request_authority_superseded"; readonly detail: string }
  | { readonly code: "request_authority_unavailable"; readonly detail: string }
  | { readonly code: "authority_partition_invalid"; readonly detail: string }
  | { readonly code: "organisation_policy_superseded"; readonly detail: string }
  | {
      readonly code: "organisation_policy_unavailable";
      readonly detail: string;
    }
  | { readonly code: "access_grants_unavailable"; readonly detail: string }
  | { readonly code: "selected_grants_superseded"; readonly detail: string }
  | { readonly code: "effective_grants_invalid"; readonly detail: string }
  | { readonly code: "capability_not_granted"; readonly detail: string };

export type AuthorityPartitionParseError = {
  readonly code: "invalid_authority_partition";
  readonly field: string;
};

type CurrentPolicy = Readonly<{
  readonly version: number;
  readonly allowedTools: readonly string[];
}>;

type AuthorityPartitionWithoutDigest = Omit<AuthorityPartition, "digest">;

export async function compileTurnAuthority(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly accountAccess: OrganisationAccess;
    readonly userAuthority: OrganisationUserAuthority;
    readonly action: OrganisationAdmissionAction;
    readonly organisationId: OrganisationId;
    readonly requestAuthority: RequestAuthority;
    /**
     * The policy version that the caller pinned. A caller that is still
     * loading the policy gives the pending load, and the reads below share
     * its wait.
     */
    readonly policy:
      | Pick<PinnedSessionPolicy, "version">
      | Promise<Pick<PinnedSessionPolicy, "version">>;
  }>,
): Promise<Result<CompiledTurnAuthority, TurnAuthorityCompileError>> {
  if (input.requestAuthority.organisationId !== input.organisationId) {
    return {
      ok: false,
      error: {
        code: "request_authority_invalid",
        detail: "organisation mismatch",
      },
    };
  }

  const live = await validateLiveRequestAuthority({
    db: input.db,
    accountAccess: input.accountAccess,
    userAuthority: input.userAuthority,
    action: input.action,
    authority: input.requestAuthority,
  });
  if (!live.ok) {
    return live.error.code === "request_authority_inactive"
      ? {
          ok: false,
          error: {
            code: "request_authority_superseded",
            detail: live.error.detail,
          },
        }
      : {
          ok: false,
          error: {
            code: "request_authority_unavailable",
            detail: live.error.detail,
          },
        };
  }

  const [currentPolicy, grants, pinnedPolicy] = await Promise.all([
    readCurrentOrganisationPolicy(input.db, input.organisationId),
    listAccessGrants({
      db: input.db,
      organisationId: input.organisationId,
      lifecycle: "active",
    }),
    input.policy,
  ]);
  if (!currentPolicy.ok) {
    return {
      ok: false,
      error:
        currentPolicy.error.code === "organisation_policy_unavailable"
          ? currentPolicy.error
          : {
              code: "organisation_policy_unavailable",
              detail: currentPolicy.error.detail,
            },
    };
  }
  if (pinnedPolicy.version !== currentPolicy.value.version) {
    return {
      ok: false,
      error: {
        code: "organisation_policy_superseded",
        detail: `policy_${currentPolicy.value.version}`,
      },
    };
  }

  if (!grants.ok) {
    return {
      ok: false,
      error: { code: "access_grants_unavailable", detail: grants.error.code },
    };
  }

  const selected = selectActiveGrants({
    organisationId: input.organisationId,
    authority: input.requestAuthority,
    grants: grants.value,
  });
  if (!selected.ok) return effectiveGrantCompileFailure(selected.error);

  const effective = compileSelectedGrantSet({
    organisationId: input.organisationId,
    authority: input.requestAuthority,
    selectedGrants: selected.value,
    organisationAllowedTools: currentPolicy.value.allowedTools,
  });
  if (!effective.ok) return effectiveGrantCompileFailure(effective.error);

  const selectedGrantSetDigest = await digestSelectedGrantSet(selected.value);
  const authorityPartition = await buildAuthorityPartition({
    authority: input.requestAuthority,
    selectedGrantSetDigest,
    capabilityKeys: effective.value.capabilities.map(
      capabilityKeyForEffectiveCapability,
    ),
    policyVersion: `policy_${currentPolicy.value.version}`,
  });
  return {
    ok: true,
    value: {
      accountAccess: input.accountAccess,
      userAuthority: input.userAuthority,
      action: input.action,
      requestAuthority: input.requestAuthority,
      authorityPartition,
      effectiveGrantSet: effective.value,
    },
  };
}

/**
 * The capability ids that the active grants and the current policy give a
 * request authority now. It reads no live membership: a permission decision
 * uses it to check that an allow took effect, and the turn that continues the
 * request checks the live authority again before it runs.
 */
export async function currentGrantedCapabilityIds(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly requestAuthority: RequestAuthority;
  }>,
): Promise<Result<ReadonlySet<string>, TurnAuthorityCompileError>> {
  const [currentPolicy, grants] = await Promise.all([
    readCurrentOrganisationPolicy(input.db, input.organisationId),
    listAccessGrants({
      db: input.db,
      organisationId: input.organisationId,
      lifecycle: "active",
    }),
  ]);
  if (!currentPolicy.ok)
    return {
      ok: false,
      error: {
        code: "organisation_policy_unavailable",
        detail: currentPolicy.error.detail,
      },
    };
  if (!grants.ok)
    return {
      ok: false,
      error: { code: "access_grants_unavailable", detail: grants.error.code },
    };
  const selected = selectActiveGrants({
    organisationId: input.organisationId,
    authority: input.requestAuthority,
    grants: grants.value,
  });
  if (!selected.ok) return effectiveGrantCompileFailure(selected.error);
  const effective = compileSelectedGrantSet({
    organisationId: input.organisationId,
    authority: input.requestAuthority,
    selectedGrants: selected.value,
    organisationAllowedTools: currentPolicy.value.allowedTools,
  });
  if (!effective.ok) return effectiveGrantCompileFailure(effective.error);
  return {
    ok: true,
    value: new Set(effective.value.capabilities.map(effectiveCapabilityId)),
  };
}

function effectiveCapabilityId(capability: EffectiveCapability): string {
  return capability.definition.capabilityId;
}

export type CurrentEffectiveGrantAuthority = Readonly<{
  readonly requestAuthority: RequestAuthority;
  readonly authorityPartition: AuthorityPartition;
  readonly effectiveGrantSet: CompiledTurnAuthority["effectiveGrantSet"];
  readonly allowedTools: readonly string[];
}>;

export async function resolveEffectiveGrantSetForAuthorityPartition(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly accountAccess: OrganisationAccess;
    readonly userAuthority: OrganisationUserAuthority;
    readonly action: OrganisationAdmissionAction;
    readonly organisationId: OrganisationId;
    readonly authority: RequestAuthority;
    readonly authorityPartition: AuthorityPartition;
  }>,
): Promise<
  Result<CurrentEffectiveGrantAuthority, CapabilityAuthorizationError>
> {
  if (input.authority.organisationId !== input.organisationId) {
    return {
      ok: false,
      error: {
        code: "request_authority_invalid",
        detail: "capability authorization input invalid",
      },
    };
  }
  const parsedAuthority = parseStoredRequestAuthority(input.authority);
  if (
    !parsedAuthority.ok ||
    parsedAuthority.value.requestAuthority.organisationId !==
      input.organisationId
  ) {
    return {
      ok: false,
      error: {
        code: "request_authority_invalid",
        detail: "request authority is invalid",
      },
    };
  }
  // The grants and the policy are read beside the live authority check. They
  // are used only after that check passed.
  const records = Promise.all([
    listAccessGrants({
      db: input.db,
      organisationId: input.organisationId,
      lifecycle: "active",
    }),
    readCurrentOrganisationPolicy(input.db, input.organisationId),
  ]);
  void records.catch(ignoreUnusedRecords);
  const live = await validateLiveRequestAuthority({
    db: input.db,
    accountAccess: input.accountAccess,
    userAuthority: input.userAuthority,
    action: input.action,
    authority: input.authority,
  });
  if (!live.ok) {
    return live.error.code === "request_authority_inactive"
      ? {
          ok: false,
          error: {
            code: "request_authority_superseded",
            detail: live.error.detail,
          },
        }
      : {
          ok: false,
          error: {
            code: "request_authority_unavailable",
            detail: live.error.detail,
          },
        };
  }
  const [grants, currentPolicy] = await records;
  if (!grants.ok) {
    return {
      ok: false,
      error: { code: "access_grants_unavailable", detail: grants.error.code },
    };
  }
  const selected = selectActiveGrants({
    organisationId: input.organisationId,
    authority: parsedAuthority.value.requestAuthority,
    grants: grants.value,
  });
  if (!selected.ok) {
    return {
      ok: false,
      error: { code: "effective_grants_invalid", detail: selected.error.code },
    };
  }
  const selectedGrantSetDigest = await digestSelectedGrantSet(selected.value);
  if (!currentPolicy.ok) return currentPolicy;
  const parsedPartition = parseStoredAuthorityPartition(
    input.authorityPartition,
  );
  if (!parsedPartition.ok) {
    return {
      ok: false,
      error: {
        code: "authority_partition_invalid",
        detail: parsedPartition.error.field,
      },
    };
  }
  const partition = parsedPartition.value;
  if (
    !(await isCurrentAuthorityPartition(
      parsedAuthority.value.requestAuthority,
      partition,
    ))
  ) {
    return {
      ok: false,
      error: {
        code: "authority_partition_invalid",
        detail: "partition key or digest mismatch",
      },
    };
  }
  const policyVersion = `policy_${currentPolicy.value.version}`;
  if (
    partition.policyVersion !== policyVersion ||
    hasPartitionCapabilityOutsidePolicy(
      partition.capabilityKeys,
      currentPolicy.value.allowedTools,
    )
  ) {
    return {
      ok: false,
      error: { code: "organisation_policy_superseded", detail: policyVersion },
    };
  }
  if (selectedGrantSetDigest !== partition.selectedGrantSetDigest) {
    return {
      ok: false,
      error: {
        code: "selected_grants_superseded",
        detail: selectedGrantSetDigest,
      },
    };
  }
  const effective = compileSelectedGrantSet({
    organisationId: input.organisationId,
    authority: parsedAuthority.value.requestAuthority,
    selectedGrants: selected.value,
    organisationAllowedTools: currentPolicy.value.allowedTools,
  });
  if (!effective.ok) {
    return {
      ok: false,
      error: { code: "effective_grants_invalid", detail: effective.error.code },
    };
  }
  const liveCapabilityKeys = effective.value.capabilities.map(
    capabilityKeyForEffectiveCapability,
  );
  if (
    JSON.stringify(liveCapabilityKeys) !==
    JSON.stringify(partition.capabilityKeys)
  ) {
    return {
      ok: false,
      error: {
        code: "selected_grants_superseded",
        detail: selectedGrantSetDigest,
      },
    };
  }
  return {
    ok: true,
    value: {
      requestAuthority: parsedAuthority.value.requestAuthority,
      authorityPartition: partition,
      effectiveGrantSet: effective.value,
      allowedTools: currentPolicy.value.allowedTools,
    },
  };
}

/** A refused live authority never consults the grants read beside it. */
function ignoreUnusedRecords(): void {}

export async function authorizeCapabilityUse(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly accountAccess: OrganisationAccess;
    readonly userAuthority: OrganisationUserAuthority;
    readonly action: OrganisationAdmissionAction;
    readonly organisationId: OrganisationId;
    readonly authority: RequestAuthority;
    readonly authorityPartition: AuthorityPartition;
    readonly request: CapabilityAuthorizationRequest;
  }>,
): Promise<Result<AuthorizedCapabilityUse, CapabilityAuthorizationError>> {
  if (
    input.authority.organisationId !== input.organisationId ||
    input.request.capabilities.length === 0
  ) {
    return {
      ok: false,
      error: {
        code: "request_authority_invalid",
        detail: "capability authorization input invalid",
      },
    };
  }

  const current = await resolveEffectiveGrantSetForAuthorityPartition({
    db: input.db,
    accountAccess: input.accountAccess,
    userAuthority: input.userAuthority,
    action: input.action,
    organisationId: input.organisationId,
    authority: input.authority,
    authorityPartition: input.authorityPartition,
  });
  return current.ok
    ? authorizeCapabilityUseWithAuthority(current.value, input.request)
    : current;
}

/**
 * Decide a capability request against an authority that the caller resolved
 * earlier in the same Actor call. It reads nothing, so the answer is as
 * current as that resolution.
 */
export function authorizeCapabilityUseWithAuthority(
  current: CurrentEffectiveGrantAuthority,
  request: CapabilityAuthorizationRequest,
): Result<AuthorizedCapabilityUse, CapabilityAuthorizationError> {
  if (request.capabilities.length === 0) {
    return {
      ok: false,
      error: {
        code: "request_authority_invalid",
        detail: "capability authorization input invalid",
      },
    };
  }
  const partition = current.authorityPartition;

  const claims: AuthorizedCapabilityClaim[] = [];
  for (const capability of request.capabilities) {
    if (!current.allowedTools.includes(capability.capabilityId)) {
      return {
        ok: false,
        error: {
          code: "organisation_policy_superseded",
          detail: capability.capabilityId,
        },
      };
    }
    const exactKey = encodeCapabilityKey(capability);
    const wildcard = providerResourceWildcard(capability);
    const wildcardKey =
      wildcard === null ? null : encodeCapabilityKey(wildcard);
    const admittedCapabilityKey = findAdmittedCapabilityKey(
      partition.capabilityKeys,
      exactKey,
      wildcardKey,
    );
    if (admittedCapabilityKey === null) {
      return {
        ok: false,
        error: { code: "capability_not_granted", detail: exactKey },
      };
    }
    claims.push({ requested: capability, admittedCapabilityKey });
  }
  return {
    ok: true,
    value: {
      requestAuthority: current.requestAuthority,
      claims,
    },
  };
}

export async function digestSelectedGrantSet(
  grants: readonly AccessGrant[],
): Promise<Sha256Digest> {
  return digestCanonical(grants.map(canonicalActiveGrant));
}

function findAdmittedCapabilityKey(
  capabilityKeys: readonly string[],
  exactKey: string,
  wildcardKey: string | null,
): string | null {
  if (capabilityKeys.includes(exactKey)) return exactKey;
  return wildcardKey !== null && capabilityKeys.includes(wildcardKey)
    ? wildcardKey
    : null;
}

function providerResourceWildcard(
  capability: ImmutableCapabilityDefinition,
): ProviderCapabilityDefinition | null {
  return capability.kind === "provider_resource"
    ? {
        kind: "provider_resource",
        capabilityId: capability.capabilityId,
        capabilityVersion: capability.capabilityVersion,
        integrationAccountId: capability.integrationAccountId,
        resourceScope: "*",
      }
    : null;
}

function canonicalActiveGrant(grant: AccessGrant): unknown {
  if (grant.lifecycle.kind !== "active") {
    throw new Error(
      `inactive grant included in selected grant digest: ${grant.grantId}`,
    );
  }
  return {
    grantId: grant.grantId,
    organisationId: grant.organisationId,
    subject: grant.subject,
    target: grant.target,
    lifecycle: {
      kind: grant.lifecycle.kind,
      revision: grant.lifecycle.revision,
      activatedAt: grant.lifecycle.activatedAt,
    },
  };
}

function capabilityKeyForEffectiveCapability(
  capability: EffectiveCapability,
): string {
  return encodeCapabilityKey(capability.definition);
}

function hasPartitionCapabilityOutsidePolicy(
  capabilityKeys: readonly string[],
  allowedTools: readonly string[],
): boolean {
  for (const capabilityKey of capabilityKeys) {
    const parsed = parseCapabilityKey(capabilityKey);
    if (!parsed.ok || !allowedTools.includes(parsed.value.capabilityId))
      return true;
  }
  return false;
}

async function buildAuthorityPartition(
  input: Readonly<{
    readonly authority: RequestAuthority;
    readonly selectedGrantSetDigest: Sha256Digest;
    readonly capabilityKeys: readonly string[];
    readonly policyVersion: string;
  }>,
): Promise<AuthorityPartition> {
  const withoutDigest: AuthorityPartitionWithoutDigest = {
    key: authorityPartitionKey(input.authority),
    selectedGrantSetDigest: input.selectedGrantSetDigest,
    capabilityKeys: [...input.capabilityKeys],
    policyVersion: input.policyVersion,
  };
  return {
    digest: await digestCanonical(withoutDigest),
    ...withoutDigest,
  };
}

export async function isCurrentAuthorityPartition(
  authority: RequestAuthority,
  partition: AuthorityPartition,
): Promise<boolean> {
  const expectedKey = authorityPartitionKey(authority);
  if (
    expectedKey.kind === "agent_mailbox" &&
    partition.key.kind === "agent_mailbox"
  )
    expectedKey.replyScope = partition.key.replyScope;
  if (JSON.stringify(expectedKey) !== JSON.stringify(partition.key))
    return false;
  const withoutDigest: AuthorityPartitionWithoutDigest = {
    key: partition.key,
    selectedGrantSetDigest: partition.selectedGrantSetDigest,
    capabilityKeys: [...partition.capabilityKeys],
    policyVersion: partition.policyVersion,
  };
  return (await digestCanonical(withoutDigest)) === partition.digest;
}

export function authorityPartitionKey(
  authority: RequestAuthority,
): AuthorityPartitionKey {
  switch (authority.kind) {
    case "direct_conversation":
      return {
        kind: "direct_conversation",
        organisationId: authority.organisationId,
        requesterPersonId: authority.requesterPersonId,
        membershipRevision: authority.membershipRevision,
        role: authority.role,
        integrationAccountId: authority.integrationAccountId,
        conversationId: authority.conversationId,
      };
    case "shared_conversation":
      return {
        kind: "shared_conversation",
        organisationId: authority.organisationId,
        membershipRevision: authority.membershipRevision,
        role: authority.role,
        integrationAccountId: authority.integrationAccountId,
        conversationId: authority.conversationId,
      };
    case "workflow":
      return {
        kind: "workflow",
        organisationId: authority.organisationId,
        workflowId: authority.workflowId,
        workflowRevision: authority.workflowRevision,
      };
    case "agent_mailbox":
      return {
        kind: "agent_mailbox",
        organisationId: authority.organisationId,
        integrationAccountId: authority.integrationAccountId,
        mailboxBindingId: authority.mailboxBindingId,
        bindingRevision: authority.bindingRevision,
        mailboxPolicyVersion: authority.mailboxPolicyVersion,
        replyScope: { kind: "source_only" },
      };
    case "whatsapp_support":
      return {
        kind: "whatsapp_support",
        organisationId: authority.organisationId,
        integrationAccountId: authority.integrationAccountId,
        supportBindingId: authority.supportBindingId,
        bindingRevision: authority.bindingRevision,
        ingressPolicyVersion: authority.ingressPolicyVersion,
      };
    case "control":
      return {
        kind: "control",
        organisationId: authority.organisationId,
        requesterPersonId: authority.requesterPersonId,
        userId: authority.userId,
        membershipRevision: authority.membershipRevision,
        role: authority.role,
      };
    default:
      return assertNever(authority, "unhandled request authority");
  }
}

export function authorityPartitionKeyMatchesRequest(
  key: AuthorityPartitionKey,
  authority: RequestAuthority,
): boolean {
  const expected = authorityPartitionKey(authority);
  if (key.kind === "agent_mailbox" && expected.kind === "agent_mailbox") {
    return (
      key.organisationId === expected.organisationId &&
      key.integrationAccountId === expected.integrationAccountId &&
      key.mailboxBindingId === expected.mailboxBindingId &&
      key.bindingRevision === expected.bindingRevision &&
      key.mailboxPolicyVersion === expected.mailboxPolicyVersion
    );
  }
  return JSON.stringify(key) === JSON.stringify(expected);
}

/**
 * Whether a Case entry that names the partition `entryPartitionDigest`
 * replays into `partition`: the entry's partition is `partition` itself, or
 * `partition` at the membership revision of the authority that wrote it.
 *
 * A change of the Organisation's configuration raises the revision of each
 * Slack authority, so an open thread moves to a new partition and a new
 * Session. The requester, the grants, the capabilities and the policy version
 * stay, so the entries of the earlier partition replay, each with its flow
 * label. A change of any of these is a new partition that the earlier entries
 * do not reach: a narrowed grant must not see what the wider grant read. A
 * mailbox, a WhatsApp line, a workflow and a Portal chat replay into their
 * own partition only.
 */
export async function isPartitionAtOtherRevision(
  entryPartitionDigest: Sha256Digest,
  writtenUnder: RequestAuthority,
  partition: AuthorityPartition,
): Promise<boolean> {
  if (entryPartitionDigest === partition.digest) return true;
  if (
    writtenUnder.kind !== "direct_conversation" &&
    writtenUnder.kind !== "shared_conversation"
  )
    return false;
  return (
    (await partitionDigestAtRevision(
      partition,
      writtenUnder.kind,
      writtenUnder.membershipRevision,
    )) === entryPartitionDigest
  );
}

/**
 * The digest of `partition` at another membership revision, or null when
 * the partition is not a Slack partition of the kind `writerKind`.
 */
export async function partitionDigestAtRevision(
  partition: AuthorityPartition,
  writerKind: RequestAuthority["kind"],
  membershipRevision: number,
): Promise<Sha256Digest | null> {
  const key = partition.key;
  if (
    (key.kind !== "direct_conversation" &&
      key.kind !== "shared_conversation") ||
    key.kind !== writerKind
  )
    return null;
  if (membershipRevision === key.membershipRevision) return partition.digest;
  const atRevision: AuthorityPartitionWithoutDigest = {
    key: { ...key, membershipRevision },
    selectedGrantSetDigest: partition.selectedGrantSetDigest,
    capabilityKeys: [...partition.capabilityKeys],
    policyVersion: partition.policyVersion,
  };
  return digestCanonical(atRevision);
}

export function parseStoredAuthorityPartition(
  raw: unknown,
): Result<AuthorityPartition, AuthorityPartitionParseError> {
  if (!isRecord(raw)) return invalidPartition("partition");
  const digest = readDigest(raw.digest);
  const key = parseAuthorityPartitionKey(raw.key);
  const selectedGrantSetDigest = readDigest(raw.selectedGrantSetDigest);
  const capabilityKeys = parseCapabilityKeys(raw.capabilityKeys);
  const policyVersion = readNonEmptyString(raw.policyVersion);
  if (digest === null) return invalidPartition("digest");
  if (key === null) return invalidPartition("key");
  if (selectedGrantSetDigest === null)
    return invalidPartition("selectedGrantSetDigest");
  if (capabilityKeys === null) return invalidPartition("capabilityKeys");
  if (policyVersion === null) return invalidPartition("policyVersion");
  return {
    ok: true,
    value: {
      digest,
      key,
      selectedGrantSetDigest,
      capabilityKeys,
      policyVersion,
    },
  };
}

function parseAuthorityPartitionKey(
  raw: unknown,
): AuthorityPartitionKey | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  const organisationId = readNonEmptyString(raw.organisationId);
  if (organisationId === null) return null;
  switch (raw.kind) {
    case "direct_conversation": {
      const requesterPersonId = readNonEmptyString(raw.requesterPersonId);
      const membershipRevision = positiveIntegerOrNull(raw.membershipRevision);
      const role = readNonEmptyString(raw.role);
      const integrationAccountId = readNonEmptyString(raw.integrationAccountId);
      const conversationId = readNonEmptyString(raw.conversationId);
      return requesterPersonId !== null &&
        membershipRevision !== null &&
        role !== null &&
        integrationAccountId !== null &&
        conversationId !== null
        ? {
            kind: raw.kind,
            organisationId,
            requesterPersonId,
            membershipRevision,
            role,
            integrationAccountId,
            conversationId,
          }
        : null;
    }
    case "shared_conversation": {
      const membershipRevision = positiveIntegerOrNull(raw.membershipRevision);
      const role = readNonEmptyString(raw.role);
      const integrationAccountId = readNonEmptyString(raw.integrationAccountId);
      const conversationId = readNonEmptyString(raw.conversationId);
      return membershipRevision !== null &&
        role !== null &&
        integrationAccountId !== null &&
        conversationId !== null
        ? {
            kind: raw.kind,
            organisationId,
            membershipRevision,
            role,
            integrationAccountId,
            conversationId,
          }
        : null;
    }
    case "workflow": {
      const workflowId = readNonEmptyString(raw.workflowId);
      const workflowRevision = positiveIntegerOrNull(raw.workflowRevision);
      return workflowId !== null && workflowRevision !== null
        ? { kind: raw.kind, organisationId, workflowId, workflowRevision }
        : null;
    }
    case "agent_mailbox": {
      const integrationAccountId = readNonEmptyString(raw.integrationAccountId);
      const mailboxBindingId = readNonEmptyString(raw.mailboxBindingId);
      const bindingRevision = positiveIntegerOrNull(raw.bindingRevision);
      const mailboxPolicyVersion = positiveIntegerOrNull(
        raw.mailboxPolicyVersion,
      );
      const replyScope = parseMailboxReplyScope(raw.replyScope);
      return integrationAccountId !== null &&
        mailboxBindingId !== null &&
        bindingRevision !== null &&
        mailboxPolicyVersion !== null &&
        replyScope !== null
        ? {
            kind: raw.kind,
            organisationId,
            integrationAccountId,
            mailboxBindingId,
            bindingRevision,
            mailboxPolicyVersion,
            replyScope,
          }
        : null;
    }
    case "whatsapp_support": {
      const integrationAccountId = readNonEmptyString(raw.integrationAccountId);
      const supportBindingId = readNonEmptyString(raw.supportBindingId);
      const bindingRevision = positiveIntegerOrNull(raw.bindingRevision);
      const ingressPolicyVersion = positiveIntegerOrNull(
        raw.ingressPolicyVersion,
      );
      return integrationAccountId !== null &&
        supportBindingId !== null &&
        bindingRevision !== null &&
        ingressPolicyVersion !== null
        ? {
            kind: raw.kind,
            organisationId,
            integrationAccountId,
            supportBindingId,
            bindingRevision,
            ingressPolicyVersion,
          }
        : null;
    }
    case "control": {
      const requesterPersonId = readNonEmptyString(raw.requesterPersonId);
      const userId = readNonEmptyString(raw.userId);
      const membershipRevision = positiveIntegerOrNull(raw.membershipRevision);
      const role = readNonEmptyString(raw.role);
      return requesterPersonId !== null &&
        userId !== null &&
        membershipRevision !== null &&
        role !== null
        ? {
            kind: raw.kind,
            organisationId,
            requesterPersonId,
            userId,
            membershipRevision,
            role,
          }
        : null;
    }
    default:
      return null;
  }
}

function parseCapabilityKeys(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value))
      return null;
    const parsed = parseCapabilityKey(value);
    if (!parsed.ok || encodeCapabilityKey(parsed.value) !== value) return null;
    seen.add(value);
    values.push(value);
  }
  if (
    values.some(
      (value, index) =>
        index > 0 && values[index - 1]!.localeCompare(value) >= 0,
    )
  ) {
    return null;
  }
  return values;
}

function readDigest(raw: unknown): Sha256Digest | null {
  return typeof raw === "string" && /^[0-9a-f]{64}$/u.test(raw) ? raw : null;
}

function readNonEmptyString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

function invalidPartition(
  field: string,
): Result<never, AuthorityPartitionParseError> {
  return { ok: false, error: { code: "invalid_authority_partition", field } };
}

function effectiveGrantCompileFailure(
  error: EffectiveGrantCompileError,
): Result<never, TurnAuthorityCompileError> {
  return {
    ok: false,
    error: { code: "effective_grants_invalid", detail: error.code },
  };
}

async function readCurrentOrganisationPolicy(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<CurrentPolicy, CapabilityAuthorizationError>> {
  const snapshot = await readCurrentOrganisationPolicySnapshot(
    db,
    organisationId,
  );
  if (!snapshot.ok) {
    return {
      ok: false,
      error: {
        code: "organisation_policy_unavailable",
        detail: snapshot.error.detail,
      },
    };
  }
  return {
    ok: true,
    value: {
      version: snapshot.value.version,
      allowedTools: snapshot.value.authz.allowedTools,
    },
  };
}

async function digestCanonical(value: unknown): Promise<Sha256Digest> {
  return sha256Hex(JSON.stringify(value));
}

function parseMailboxReplyScope(
  raw: unknown,
): import("@purin-labs/contracts").MailboxReplyScope | null {
  if (raw === undefined) return { kind: "source_only" };
  if (!isRecord(raw)) return null;
  if (raw.kind === "source_only" && Object.keys(raw).length === 1)
    return { kind: "source_only" };
  if (
    raw.kind !== "case_context_collection_evidence" ||
    Object.keys(raw).length !== 3
  )
    return null;
  const recipientDigest = readDigest(raw.recipientDigest);
  const dependencyDigest = readDigest(raw.dependencyDigest);
  return recipientDigest === null || dependencyDigest === null
    ? null
    : {
        kind: "case_context_collection_evidence",
        recipientDigest,
        dependencyDigest,
      };
}

export async function bindMailboxCaseContextCollectionAuthority(
  authority: CompiledTurnAuthority,
  scope: Variant<
    import("@purin-labs/contracts").MailboxReplyScope,
    "case_context_collection_evidence"
  >,
): Promise<Result<CompiledTurnAuthority, TurnAuthorityCompileError>> {
  if (authority.authorityPartition.key.kind !== "agent_mailbox")
    return {
      ok: false,
      error: {
        code: "request_authority_invalid",
        detail: "CaseContextCollection reply requires mailbox authority",
      },
    };
  const previous = authority.authorityPartition;
  const previousKey = authority.authorityPartition.key;
  const key: AuthorityPartitionKey = {
    kind: "agent_mailbox",
    organisationId: previousKey.organisationId,
    integrationAccountId: previousKey.integrationAccountId,
    mailboxBindingId: previousKey.mailboxBindingId,
    bindingRevision: previousKey.bindingRevision,
    mailboxPolicyVersion: previousKey.mailboxPolicyVersion,
    replyScope: scope,
  };
  const partition = {
    key,
    selectedGrantSetDigest: previous.selectedGrantSetDigest,
    capabilityKeys: previous.capabilityKeys,
    policyVersion: previous.policyVersion,
  };
  return {
    ok: true,
    value: {
      accountAccess: authority.accountAccess,
      userAuthority: authority.userAuthority,
      action: authority.action,
      requestAuthority: authority.requestAuthority,
      authorityPartition: {
        digest: await digestCanonical(partition),
        ...partition,
      },
      effectiveGrantSet: authority.effectiveGrantSet,
    },
  };
}
