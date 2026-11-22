import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { SessionExecutionAdmission } from "../session-execution-admission";
import { readCaseSessionAssignment } from "../actor-journal/transactions";
import { preflightHarnessTurnLease } from "../agent-session-harness-authority";
import { claimRunCapability } from "../agent-session-budget";
import type { HarnessCapabilityClaimInput } from "../../agent-tools/catalog/types";
import {
  authorizeCapabilityUse,
  type CapabilityAuthorizationError,
} from "@purin-labs/authority/authorization/access-grants/turn-authority";
import {
  parseCapabilityKey,
  type CapabilityDefinition,
} from "@purin-labs/authority/authorization/access-grants/capability-key";
import { parseStoredRequestAuthority } from "@purin-labs/authority/request-authority/index";
import type { Variant } from "@purin-labs/type-utils";
import type { CanonicalRunBudgetIdentity } from "./types";

export async function claimCanonicalRunCapability(
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  identity: CanonicalRunBudgetIdentity,
  lease: HarnessTurnLease,
  input: HarnessCapabilityClaimInput,
): Promise<
  Result<
    null,
    {
      readonly code: "embedded_harness_capability_claim_rejected";
      readonly detail: string;
    }
  >
> {
  if (!(await execution.isTurnActive(lease)))
    return rejectedCapabilityClaim("session_execution_authority_inactive");
  const authorized = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!authorized.ok) return rejectedCapabilityClaim(authorized.error.code);
  const assignment = readCaseSessionAssignment(storage.sql);
  if (assignment === null)
    return rejectedCapabilityClaim("case_assignment_missing");
  const authority = await validateCapabilityClaimAuthority({
    executionScope: execution.scope,
    identity,
    lease,
    assignment,
    capability: input.capability,
  });
  if (!authority.ok) return authority;
  if (!(await execution.isTurnActive(lease)))
    return rejectedCapabilityClaim("session_execution_authority_inactive");
  const stillAuthorized = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!stillAuthorized.ok)
    return rejectedCapabilityClaim(stillAuthorized.error.code);
  const claimed = storage.transactionSync(
    claimRunCapability.bind(null, storage.sql, {
      ...identity,
      operationId: `budget_claim_${identity.runId}_${input.callId}`,
      claimId: `${input.boundary}:${input.capability}:${input.callId}`,
      now: Date.now(),
    }),
  );
  return claimed.ok
    ? { ok: true, value: null }
    : rejectedCapabilityClaim(claimed.error.code);
}

/**
 * Whether a result that these capabilities produced may be read now. The
 * checks are those of a capability claim, without the budget claim: reading a
 * recorded result again spends nothing, and it still needs current authority.
 */
export async function authorizeCanonicalRunSources(
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  identity: CanonicalRunBudgetIdentity,
  lease: HarnessTurnLease,
  capabilities: readonly HarnessCapabilityClaimInput["capability"][],
): Promise<Result<null, { readonly detail: string }>> {
  if (!(await execution.isTurnActive(lease)))
    return rejectedSourceAccess("session_execution_authority_inactive");
  const assignment = readCaseSessionAssignment(storage.sql);
  if (assignment === null)
    return rejectedSourceAccess("case_assignment_missing");
  for (const capability of capabilities) {
    const authority = await validateCapabilityClaimAuthority({
      executionScope: execution.scope,
      identity,
      lease,
      assignment,
      capability,
    });
    if (!authority.ok) return rejectedSourceAccess(authority.error.detail);
  }
  const stillAuthorized = preflightHarnessTurnLease(storage, lease, Date.now());
  return stillAuthorized.ok
    ? { ok: true, value: null }
    : rejectedSourceAccess(stillAuthorized.error.code);
}

function rejectedSourceAccess(
  detail: string,
): Result<never, { readonly detail: string }> {
  return { ok: false, error: { detail } };
}

async function validateCapabilityClaimAuthority(input: {
  readonly executionScope: OrganisationExecutionScope;
  readonly identity: CanonicalRunBudgetIdentity;
  readonly lease: HarnessTurnLease;
  readonly assignment: CaseAssignment;
  readonly capability: HarnessCapabilityClaimInput["capability"];
}): Promise<
  Result<
    null,
    {
      readonly code: "embedded_harness_capability_claim_rejected";
      readonly detail: string;
    }
  >
> {
  const partition = input.assignment.authorityPartition;
  const assignmentAuthority = input.assignment.authority;
  if (
    input.identity.organisationId !== input.lease.session.organisationId ||
    input.identity.sessionId !== input.lease.session.sessionId ||
    input.assignment.sessionId !== input.lease.session.sessionId ||
    input.lease.authorityPartitionDigest !== partition.digest ||
    input.lease.authorityPartitionDigest !==
      assignmentAuthority.authorityPartitionDigest
  )
    return rejectedCapabilityClaim("capability_authority_binding_invalid");

  const parsedOrganisationId = parseOrganisationId(
    input.lease.session.organisationId,
  );
  const parsedAuthority = parseStoredRequestAuthority(
    input.lease.requestAuthority,
  );
  if (
    !parsedOrganisationId.ok ||
    !parsedAuthority.ok ||
    parsedAuthority.value.requestAuthority.organisationId !==
      parsedOrganisationId.value
  ) {
    return rejectedCapabilityClaim("request_authority_invalid");
  }
  if (
    input.capability === "custom_connector.read" ||
    input.capability === "custom_connector.write"
  ) {
    const customConnectorCapabilities = partition.capabilityKeys
      .map(parseCustomConnectorCapabilityScope.bind(null, input.capability))
      .filter(isCustomConnectorCapabilityScope);
    for (const requiredCapability of customConnectorCapabilities) {
      const validated = await authorizeCapabilityUse({
        db: input.executionScope.database,
        accountAccess: input.executionScope.accountAccess,
        userAuthority: acceptedExecutionAuthority(
          input.lease.session.sessionId,
          input.lease.turn.turnId,
        ),
        action: "execute",
        organisationId: parsedOrganisationId.value,
        authority: parsedAuthority.value.requestAuthority,
        authorityPartition: partition,
        request: { capabilities: [requiredCapability] },
      });
      if (validated.ok) return { ok: true, value: null };
    }
    return rejectedCapabilityClaim("capability_outside_partition");
  }
  const scope = `platform:${input.capability}:1`;
  if (partition.capabilityKeys.includes(scope)) {
    const requiredCapability = platformCapabilityDefinition(input.capability);
    const validated = await authorizeCapabilityUse({
      db: input.executionScope.database,
      accountAccess: input.executionScope.accountAccess,
      userAuthority: acceptedExecutionAuthority(
        input.lease.session.sessionId,
        input.lease.turn.turnId,
      ),
      action: "execute",
      organisationId: parsedOrganisationId.value,
      authority: parsedAuthority.value.requestAuthority,
      authorityPartition: partition,
      request: { capabilities: [requiredCapability] },
    });
    return validated.ok
      ? { ok: true, value: null }
      : rejectedCapabilityClaim(
          requiredCapabilityAuthorityDetail(validated.error),
        );
  }
  if (input.capability === "file.read") {
    const fileCapabilities = partition.capabilityKeys
      .map(parseFileCapabilityScope)
      .filter(isFileCapabilityScope);
    for (const requiredCapability of fileCapabilities) {
      const validated = await authorizeCapabilityUse({
        db: input.executionScope.database,
        accountAccess: input.executionScope.accountAccess,
        userAuthority: acceptedExecutionAuthority(
          input.lease.session.sessionId,
          input.lease.turn.turnId,
        ),
        action: "execute",
        organisationId: parsedOrganisationId.value,
        authority: parsedAuthority.value.requestAuthority,
        authorityPartition: partition,
        request: { capabilities: [requiredCapability] },
      });
      if (validated.ok) return { ok: true, value: null };
    }
    return rejectedCapabilityClaim("capability_outside_partition");
  }
  const providerScopes = partition.capabilityKeys
    .map(parseProviderCapabilityScope.bind(null, input.capability))
    .filter(isProviderCapabilityScope);
  for (const providerScope of providerScopes) {
    const requiredCapability = providerCapabilityDefinition(
      input.capability,
      providerScope.integrationAccountId,
      providerScope.resourceScope,
    );
    const validated = await authorizeCapabilityUse({
      db: input.executionScope.database,
      accountAccess: input.executionScope.accountAccess,
      userAuthority: acceptedExecutionAuthority(
        input.lease.session.sessionId,
        input.lease.turn.turnId,
      ),
      action: "execute",
      organisationId: parsedOrganisationId.value,
      authority: parsedAuthority.value.requestAuthority,
      authorityPartition: partition,
      request: { capabilities: [requiredCapability] },
    });
    if (validated.ok) return { ok: true, value: null };
  }
  return rejectedCapabilityClaim("capability_outside_partition");
}

type ProviderCapabilityScope = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly resourceScope: string;
};

function parseProviderCapabilityScope(
  capability: HarnessCapabilityClaimInput["capability"],
  scope: string,
): ProviderCapabilityScope | null {
  const prefix = `provider:${capability}:1:`;
  if (!scope.startsWith(prefix)) return null;
  const separator = scope.indexOf(":", prefix.length);
  if (separator < 0) return null;
  const integrationAccountId = parseIntegrationAccountId(
    scope.slice(prefix.length, separator),
  );
  const resourceScope = scope.slice(separator + 1);
  if (!integrationAccountId.ok || resourceScope.length === 0) return null;
  return { integrationAccountId: integrationAccountId.value, resourceScope };
}

function parseFileCapabilityScope(
  scope: string,
): Variant<CapabilityDefinition, "file_resource"> | null {
  const parsed = parseCapabilityKey(scope);
  return parsed.ok &&
    parsed.value.kind === "file_resource" &&
    parsed.value.capabilityId === "file.read"
    ? parsed.value
    : null;
}

function parseCustomConnectorCapabilityScope(
  capabilityId: "custom_connector.read" | "custom_connector.write",
  scope: string,
): Variant<CapabilityDefinition, "custom_connector_operation"> | null {
  const parsed = parseCapabilityKey(scope);
  return parsed.ok &&
    parsed.value.kind === "custom_connector_operation" &&
    parsed.value.capabilityId === capabilityId
    ? parsed.value
    : null;
}

function isFileCapabilityScope(
  scope: ReturnType<typeof parseFileCapabilityScope>,
): scope is NonNullable<ReturnType<typeof parseFileCapabilityScope>> {
  return scope !== null;
}

function isCustomConnectorCapabilityScope(
  scope: ReturnType<typeof parseCustomConnectorCapabilityScope>,
): scope is NonNullable<
  ReturnType<typeof parseCustomConnectorCapabilityScope>
> {
  return scope !== null;
}

function isProviderCapabilityScope(
  scope: ProviderCapabilityScope | null,
): scope is ProviderCapabilityScope {
  return scope !== null;
}

function platformCapabilityDefinition(
  capabilityId: HarnessCapabilityClaimInput["capability"],
): {
  readonly kind: "platform_capability";
  readonly capabilityId: string;
  readonly capabilityVersion: 1;
} {
  return {
    kind: "platform_capability",
    capabilityId,
    capabilityVersion: 1,
  };
}

function providerCapabilityDefinition(
  capabilityId: string,
  integrationAccountId: IntegrationAccountId,
  resourceScope: string,
): {
  readonly kind: "provider_resource";
  readonly capabilityId: string;
  readonly capabilityVersion: 1;
  readonly integrationAccountId: string;
  readonly resourceScope: string;
} {
  return {
    kind: "provider_resource",
    capabilityId,
    capabilityVersion: 1,
    integrationAccountId,
    resourceScope,
  };
}

function requiredCapabilityAuthorityDetail(
  error: CapabilityAuthorizationError,
): string {
  return error.code;
}

function rejectedCapabilityClaim(detail: string): Result<
  never,
  {
    readonly code: "embedded_harness_capability_claim_rejected";
    readonly detail: string;
  }
> {
  return {
    ok: false,
    error: { code: "embedded_harness_capability_claim_rejected", detail },
  };
}
