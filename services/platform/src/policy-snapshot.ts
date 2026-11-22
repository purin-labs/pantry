import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  isOrganisationPolicyPlacementActive,
  resolveActiveOrganisationPlacementRecord,
  type OrganisationPolicyPlacement,
} from "@purin-labs/tenancy/data/organisation-placement";

export {
  isOrganisationPolicyPlacementActive,
  type OrganisationPolicyPlacement,
};
import type {
  AuthzRules,
  Budget,
  EgressPolicy,
  InjectionMode,
  ModelRoute,
} from "@purin-labs/contracts";

import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { credentialPolicyRuleId } from "./policy-rule-id";
import type { Result } from "@purin-labs/kernel/result";
import { readOrganisationCapabilityPolicies } from "./data/capability-policy";
import { readWorkspaceAiBudget } from "@purin-labs/tenancy/data/workspace-ai-budget";
import {
  errorMessage,
  hasExactKeys,
  isRecord,
  positiveIntegerOrNull,
  sha256Hex,
} from "@purin-labs/std";

export type OrganisationPolicySnapshot = {
  version: number;
  egress: EgressPolicy;
  authz: AuthzRules;
  conversationRisk: ConversationRiskPolicy;
  createdAt: number;
};

export type PinnedSessionPolicy = {
  version: number;
  egress: EgressPolicy;
  authz: AuthzRules;
  conversationRisk: ConversationRiskPolicy;
  modelRoute: ModelRoute;
};

type ConversationRiskPolicy = {
  outputScreeningMode: ConversationRiskOutputScreeningMode;
};

type ConversationRiskOutputScreeningMode = "hold" | "stream";

export type OrganisationPolicyLoad = {
  snapshot: OrganisationPolicySnapshot;
  source: "kv" | "d1" | "compiled" | "default_deny";
};

export type OrganisationPolicyError =
  | { code: "credential_ref_invalid"; detail: string }
  | { code: "capability_policy_invalid"; detail: string }
  | { code: "workspace_ai_budget_unavailable"; detail: string }
  | { code: "policy_activation_failed"; detail: string }
  | { code: "policy_settlement_failed"; detail: string }
  | { code: "policy_store_failed"; detail: string };

export type CurrentOrganisationPolicyError =
  | { readonly code: "policy_snapshot_missing"; readonly detail: string }
  | { readonly code: "policy_snapshot_invalid"; readonly detail: string }
  | { readonly code: "policy_snapshot_unavailable"; readonly detail: string };

type PolicyBindings = {
  db: OrganisationDatabase;
  kv: KVNamespace;
};

type OrganisationPolicyActivator = {
  activatePolicy(input: {
    requestId: ReturnType<typeof newRequestId>;
    organisationId: OrganisationId;
    snapshot: OrganisationPolicySnapshot;
    activatedAt: number;
    placement: OrganisationPolicyPlacement;
  }): Promise<
    | {
        ok: true;
        value: {
          head: {
            activeVersion: number;
            restrictionVersion: number;
            digest: string;
          };
          consumers: number;
          delivered: number;
          pending: number;
        };
      }
    | { ok: false; error: { code: string } }
  >;
};

export type OrganisationPolicyPublication = OrganisationPolicyLoad & {
  activation: {
    head: { activeVersion: number; restrictionVersion: number; digest: string };
    consumers: number;
    delivered: number;
    pending: number;
  };
};

type PolicySnapshotRow = {
  version: number;
  body: string;
};

type CredentialRefRow = {
  provider: string;
  name: string;
  integrationAccountId: string;
  providerConnectionId: string;
  environment: string;
  credentialGeneration: number;
  vaultHandle: string;
  hostPattern: string;
  injectAs: string;
};

export async function readCurrentOrganisationPolicySnapshot(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<OrganisationPolicySnapshot, CurrentOrganisationPolicyError>> {
  try {
    const row = await db
      .prepare(
        `SELECT version, body
         FROM policy_snapshot
        WHERE organisation_id = ?
        ORDER BY version DESC
        LIMIT 1`,
      )
      .bind(organisationId)
      .first<PolicySnapshotRow>();
    if (row === null) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_missing",
          detail: "current policy snapshot missing",
        },
      };
    }
    const parsed = parsePolicySnapshot(row.body);
    if (!parsed.ok || parsed.value.version !== row.version) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: "current policy snapshot invalid",
        },
      };
    }
    return parsed;
  } catch {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_unavailable",
        detail: "current policy snapshot unavailable",
      },
    };
  }
}

type PolicySnapshotSource = {
  snapshot: OrganisationPolicySnapshot;
  source: "kv" | "d1";
};

const POLICY_KV_PREFIX = "policy";
const NO_MODEL_EGRESS_URL = "https://unavailable.invalid";

export async function loadOrganisationPolicy(input: {
  bindings: PolicyBindings;
  organisationId: OrganisationId;
  now: number;
}): Promise<Result<OrganisationPolicyLoad, OrganisationPolicyError>> {
  // The three reads are independent, so they share one wait. The budget
  // reader reports a failure as a result, and it counts only when the
  // authoritative policy exists.
  const [stored, distributed, budget] = await Promise.all([
    readAuthoritativePolicy(input.bindings, input.organisationId),
    readDistributedPolicy(input.bindings, input.organisationId),
    readWorkspaceAiBudget(input.bindings.db, input.organisationId),
  ]);

  if (stored !== null) {
    if (!budget.ok || budget.value.activation !== "active")
      return {
        ok: false,
        error: {
          code: "workspace_ai_budget_unavailable",
          detail: "Workspace AI budget activation is incomplete",
        },
      };
    if (
      distributed !== null &&
      policySnapshotsMatch(stored.snapshot, distributed.snapshot)
    ) {
      return { ok: true, value: distributed };
    }
    return {
      ok: false,
      error: {
        code: "policy_settlement_failed",
        detail: "D1 and KV policy heads differ",
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "policy_store_failed",
      detail: "authoritative policy snapshot missing",
    },
  };
}

export async function loadOrganisationPolicyOrDefaultDeny(input: {
  bindings: PolicyBindings;
  organisationId: OrganisationId;
  now: number;
}): Promise<OrganisationPolicyLoad> {
  try {
    const loaded = await loadOrganisationPolicy(input);

    if (loaded.ok) {
      return loaded.value;
    }

    traceWarn("policy.load_failed_default_deny", {
      requestId: newRequestId(),
      organisation_id: input.organisationId,
      code: loaded.error.code,
      detail: loaded.error.detail,
    });
  } catch (error) {
    traceWarn("policy.load_exception_default_deny", {
      requestId: newRequestId(),
      organisation_id: input.organisationId,
      detail: errorMessage(error),
    });
  }

  return {
    snapshot: defaultDenyPolicy({ now: input.now }),
    source: "default_deny",
  };
}

async function compileAndStoreAuthoritativeOrganisationPolicy(input: {
  bindings: PolicyBindings;
  organisationId: OrganisationId;
  now: number;
  placement: OrganisationPolicyPlacement;
}): Promise<Result<OrganisationPolicyLoad, OrganisationPolicyError>> {
  const compiled = await compileOrganisationPolicy(
    input.bindings,
    input.organisationId,
    input.now,
  );

  if (!compiled.ok) {
    return compiled;
  }

  try {
    const stored = await input.bindings.db
      .prepare(
        `INSERT INTO policy_snapshot (organisation_id, version, body, created_at, created_by)
         SELECT ?, ?, ?, ?, 'system:capability-policy-compiler'
         WHERE EXISTS (
           SELECT 1 FROM organisation_placement WHERE organisation_id = ?
             AND placement_epoch = ? AND placement_cell_id = ?
             AND fence_token = ? AND status = 'active'
         )`,
      )
      .bind(
        input.organisationId,
        compiled.value.version,
        JSON.stringify(compiled.value),
        compiled.value.createdAt,
        input.organisationId,
        input.placement.placement.placementEpoch,
        input.placement.placement.placementCellId,
        input.placement.fenceToken,
      )
      .run();
    if (stored.meta.changes !== 1) return policyPlacementConflict();
  } catch (error) {
    return {
      ok: false,
      error: { code: "policy_store_failed", detail: errorMessage(error) },
    };
  }

  return { ok: true, value: { snapshot: compiled.value, source: "compiled" } };
}

export async function compilePublishAndActivateOrganisationPolicy(input: {
  bindings: PolicyBindings;
  organisationId: OrganisationId;
  organisation: OrganisationPolicyActivator;
  now: number;
}): Promise<Result<OrganisationPolicyPublication, OrganisationPolicyError>> {
  const placement = await resolveActiveOrganisationPlacementRecord(
    input.bindings.db.withSession("first-primary"),
    input.organisationId,
  );
  if (!placement.ok) return policyPlacementConflict();
  const published = await compileAndStoreAuthoritativeOrganisationPolicy({
    bindings: input.bindings,
    organisationId: input.organisationId,
    now: input.now,
    placement: placement.value,
  });
  if (!published.ok) return published;
  return activateAndDistributeOrganisationPolicy({
    ...input,
    publication: published.value,
    placement: placement.value,
  });
}

async function activateAndDistributeOrganisationPolicy(input: {
  bindings: PolicyBindings;
  organisationId: OrganisationId;
  organisation: OrganisationPolicyActivator;
  now: number;
  publication: OrganisationPolicyLoad;
  placement: OrganisationPolicyPlacement;
}): Promise<Result<OrganisationPolicyPublication, OrganisationPolicyError>> {
  const activation = await input.organisation.activatePolicy({
    requestId: newRequestId(),
    organisationId: input.organisationId,
    snapshot: input.publication.snapshot,
    activatedAt: input.now,
    placement: input.placement,
  });
  if (!activation.ok) {
    return {
      ok: false,
      error: {
        code: "policy_activation_failed",
        detail: activation.error.code,
      },
    };
  }
  const expectedDigest = await sha256Hex(
    JSON.stringify(input.publication.snapshot),
  );
  if (
    activation.value.head.activeVersion !==
      input.publication.snapshot.version ||
    activation.value.head.digest !== expectedDigest
  ) {
    return {
      ok: false,
      error: {
        code: "policy_settlement_failed",
        detail: "D1, KV, and Organisation Actor policy heads differ",
      },
    };
  }
  const current = await readAuthoritativePolicy(
    input.bindings,
    input.organisationId,
  );
  if (
    current === null ||
    !policySnapshotsMatch(input.publication.snapshot, current.snapshot)
  ) {
    return {
      ok: false,
      error: {
        code: "policy_settlement_failed",
        detail: "D1, KV, and Organisation Actor policy heads differ",
      },
    };
  }
  if (
    !(await isOrganisationPolicyPlacementActive(
      input.bindings.db,
      input.organisationId,
      input.placement,
    ))
  ) {
    return policyPlacementConflict();
  }
  try {
    await distributePolicy(
      input.bindings,
      input.organisationId,
      input.publication.snapshot,
    );
  } catch (error) {
    return {
      ok: false,
      error: { code: "policy_store_failed", detail: errorMessage(error) },
    };
  }
  const authoritative = await readAuthoritativePolicy(
    input.bindings,
    input.organisationId,
  );
  const distributed = await readDistributedPolicy(
    input.bindings,
    input.organisationId,
  );
  if (
    authoritative === null ||
    distributed === null ||
    !policySnapshotsMatch(input.publication.snapshot, authoritative.snapshot) ||
    !policySnapshotsMatch(input.publication.snapshot, distributed.snapshot)
  ) {
    return {
      ok: false,
      error: {
        code: "policy_settlement_failed",
        detail: "D1, KV, and Organisation Actor policy heads differ",
      },
    };
  }
  if (
    !(await isOrganisationPolicyPlacementActive(
      input.bindings.db,
      input.organisationId,
      input.placement,
    ))
  ) {
    return policyPlacementConflict();
  }
  return {
    ok: true,
    value: {
      ...input.publication,
      activation: activation.value,
    },
  };
}

export async function reconcileOrganisationPolicyPublication(input: {
  bindings: PolicyBindings;
  organisationId: OrganisationId;
  organisation: OrganisationPolicyActivator;
  now: number;
}): Promise<Result<OrganisationPolicyLoad, OrganisationPolicyError>> {
  const placement = await resolveActiveOrganisationPlacementRecord(
    input.bindings.db.withSession("first-primary"),
    input.organisationId,
  );
  if (!placement.ok) return policyPlacementConflict();
  const loaded = await loadOrganisationPolicy(input);

  if (loaded.ok) {
    return (await isOrganisationPolicyPlacementActive(
      input.bindings.db,
      input.organisationId,
      placement.value,
    ))
      ? loaded
      : policyPlacementConflict();
  }

  const authoritative = await readAuthoritativePolicy(
    input.bindings,
    input.organisationId,
  );

  if (authoritative === null) {
    return loaded;
  }

  const settled = await activateAndDistributeOrganisationPolicy({
    ...input,
    publication: authoritative,
    placement: placement.value,
  });

  if (!settled.ok) {
    return settled;
  }

  return {
    ok: true,
    value: {
      snapshot: settled.value.snapshot,
      source: "d1",
    },
  };
}

export function defaultDenyPolicy(input: {
  now: number;
}): OrganisationPolicySnapshot {
  return {
    version: 0,
    egress: {
      allowedHosts: [],
      injections: [],
      modelRoute: {
        baseUrl: NO_MODEL_EGRESS_URL,
      },
    },
    authz: {
      allowedTools: [],
      deniedTools: [],
      approvalRequired: [],
      maxBudget: null,
    },
    conversationRisk: { outputScreeningMode: "hold" },
    createdAt: input.now,
  };
}

export async function writeStripeReadCredentialRef(input: {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  vaultHandle: string;
  now: number;
}): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO credential_ref (
         organisation_id,
         provider,
         name,
         vault_handle,
         host_pattern,
         inject_as,
         created_at,
         revoked_at
       )
       VALUES (?, 'stripe', 'read', ?, 'api.stripe.com', ?, ?, NULL)
       ON CONFLICT (organisation_id, provider, name) DO UPDATE SET
         vault_handle = excluded.vault_handle,
         host_pattern = excluded.host_pattern,
         inject_as = excluded.inject_as,
         revoked_at = NULL`,
    )
    .bind(
      input.organisationId,
      input.vaultHandle,
      JSON.stringify({
        kind: "header",
        header: "authorization",
        scheme: "Bearer",
      }),
      input.now,
    )
    .run();
}

async function readDistributedPolicy(
  bindings: PolicyBindings,
  organisationId: OrganisationId,
): Promise<OrganisationPolicyLoad | null> {
  const raw = await bindings.kv.get(latestPolicyKey(organisationId));

  if (raw === null) {
    return null;
  }

  const parsed = parsePolicySnapshot(raw);

  if (!parsed.ok) {
    traceWarn("policy.kv_snapshot_invalid", {
      requestId: newRequestId(),
      organisation_id: organisationId,
      detail: parsed.error.detail,
    });
    return null;
  }

  return { snapshot: parsed.value, source: "kv" };
}

async function readAuthoritativePolicy(
  bindings: PolicyBindings,
  organisationId: OrganisationId,
): Promise<PolicySnapshotSource | null> {
  const row = await bindings.db
    .prepare(
      `SELECT version, body
       FROM policy_snapshot
       WHERE organisation_id = ?
       ORDER BY version DESC
       LIMIT 1`,
    )
    .bind(organisationId)
    .first<PolicySnapshotRow>();

  if (row === null) {
    return null;
  }

  const parsed = parsePolicySnapshot(row.body);

  if (!parsed.ok) {
    traceWarn("policy.d1_snapshot_invalid", {
      requestId: newRequestId(),
      organisation_id: organisationId,
      version: row.version,
      detail: parsed.error.detail,
    });
    return null;
  }

  return { snapshot: parsed.value, source: "d1" };
}

async function compileOrganisationPolicy(
  bindings: PolicyBindings,
  organisationId: OrganisationId,
  now: number,
): Promise<Result<OrganisationPolicySnapshot, OrganisationPolicyError>> {
  const budget = await readWorkspaceAiBudget(bindings.db, organisationId);
  if (!budget.ok)
    return {
      ok: false,
      error: {
        code: budget.error,
        detail: "Workspace AI budget is unavailable",
      },
    };
  const rows = await bindings.db
    .prepare(
      `SELECT
         credential.provider AS provider,
         credential.name AS name,
         account.integration_account_id AS integrationAccountId,
         connection.provider_connection_id AS providerConnectionId,
         connection.environment AS environment,
         connection.credential_generation AS credentialGeneration,
         credential.vault_handle AS vaultHandle,
         credential.host_pattern AS hostPattern,
         credential.inject_as AS injectAs
       FROM credential_ref AS credential
       JOIN provider_connection AS connection
         ON connection.organisation_id = credential.organisation_id
        AND connection.provider = credential.provider
        AND connection.credential_ref = credential.vault_handle
        AND connection.lifecycle = 'active'
       JOIN provider_credential_generation AS generation
         ON generation.provider_connection_id = connection.provider_connection_id
        AND generation.credential_generation = connection.credential_generation
        AND generation.organisation_id = connection.organisation_id
        AND generation.provider = connection.provider
        AND generation.environment = connection.environment
        AND generation.credential_ref = connection.credential_ref
        AND generation.lifecycle = 'active'
       JOIN integration_account AS account
         ON account.organisation_id = connection.organisation_id
        AND account.provider_connection_id = connection.provider_connection_id
        AND account.provider = connection.provider
        AND account.environment = connection.environment
        AND account.lifecycle = 'active'
       JOIN organisation
         ON organisation.organisation_id = account.organisation_id
        AND organisation.status = 'active'
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = account.organisation_id
        AND onboarding.environment = account.environment
        AND onboarding.lifecycle = 'active'
       WHERE credential.organisation_id = ? AND credential.revoked_at IS NULL
       ORDER BY credential.provider, credential.name, account.integration_account_id`,
    )
    .bind(organisationId)
    .all<CredentialRefRow>();

  const egress = await compileEgressPolicy(rows.results ?? []);

  if (!egress.ok) {
    return egress;
  }

  const capabilityPolicies = await readOrganisationCapabilityPolicies({
    db: bindings.db,
    organisationId,
  });
  if (!capabilityPolicies.ok) {
    return {
      ok: false,
      error: {
        code: "capability_policy_invalid",
        detail: capabilityPolicyErrorDetail(capabilityPolicies.error),
      },
    };
  }
  const allowedTools: string[] = [];
  const deniedTools: string[] = [];
  const approvalRequired: string[] = [];
  for (const policy of capabilityPolicies.value) {
    switch (policy.mode) {
      case "enabled":
        allowedTools.push(policy.capabilityId);
        break;
      case "approval_required":
        allowedTools.push(policy.capabilityId);
        approvalRequired.push(policy.capabilityId);
        break;
      case "disabled":
        deniedTools.push(policy.capabilityId);
        break;
    }
  }

  const version = await nextPolicyVersion(bindings.db, organisationId);

  return {
    ok: true,
    value: {
      version,
      egress: egress.value,
      authz: {
        allowedTools,
        deniedTools,
        approvalRequired,
        maxBudget: budget.value.limits,
      },
      conversationRisk: defaultConversationRiskPolicy(),
      createdAt: now,
    },
  };
}

async function compileEgressPolicy(
  rows: readonly CredentialRefRow[],
): Promise<Result<EgressPolicy, OrganisationPolicyError>> {
  const allowedHosts: string[] = [];
  const injections: EgressPolicy["injections"] = [];

  for (const row of rows) {
    const mode = parseInjectionMode(row.injectAs);

    if (!mode.ok) {
      return mode;
    }

    appendUnique(allowedHosts, row.hostPattern);
    injections.push({
      ruleId: await credentialPolicyRuleId(row),
      hostPattern: row.hostPattern,
      credentialRef: row.vaultHandle,
      mode: mode.value,
    });
  }

  return {
    ok: true,
    value: {
      allowedHosts,
      injections,
      modelRoute: {
        baseUrl: NO_MODEL_EGRESS_URL,
      },
    },
  };
}

function parsePolicySnapshot(
  raw: string,
): Result<
  OrganisationPolicySnapshot,
  { code: "policy_snapshot_invalid"; detail: string }
> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: { code: "policy_snapshot_invalid", detail: "invalid JSON" },
    };
  }

  return parseOrganisationPolicySnapshot(parsed);
}

export function parseOrganisationPolicySnapshot(
  parsed: unknown,
): Result<
  OrganisationPolicySnapshot,
  { code: "policy_snapshot_invalid"; detail: string }
> {
  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: { code: "policy_snapshot_invalid", detail: "object required" },
    };
  }

  const version = parsed.version;
  const egress = parseEgressPolicy(parsed.egress);
  const authz = parseAuthzRules(parsed.authz);
  const conversationRisk = parseConversationRiskPolicy(parsed.conversationRisk);
  const createdAt = parsed.createdAt;

  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0
  ) {
    return {
      ok: false,
      error: { code: "policy_snapshot_invalid", detail: "invalid version" },
    };
  }

  if (!egress.ok) {
    return egress;
  }

  if (!authz.ok) {
    return authz;
  }

  if (!conversationRisk.ok) {
    return conversationRisk;
  }

  if (
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    return {
      ok: false,
      error: { code: "policy_snapshot_invalid", detail: "invalid createdAt" },
    };
  }

  return {
    ok: true,
    value: {
      version,
      egress: egress.value,
      authz: authz.value,
      conversationRisk: conversationRisk.value,
      createdAt,
    },
  };
}

function parseEgressPolicy(
  raw: unknown,
): Result<EgressPolicy, { code: "policy_snapshot_invalid"; detail: string }> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "egress object required",
      },
    };
  }

  const allowedHosts = parseStringArray(raw.allowedHosts, "allowedHosts");
  const injections = parseInjectionRules(raw.injections);
  const modelRoute = parseModelRoute(raw.modelRoute);

  if (!allowedHosts.ok) {
    return allowedHosts;
  }

  if (!injections.ok) {
    return injections;
  }

  if (!modelRoute.ok) {
    return modelRoute;
  }

  return {
    ok: true,
    value: {
      allowedHosts: allowedHosts.value,
      injections: injections.value,
      modelRoute: modelRoute.value,
    },
  };
}

function parseInjectionRules(
  raw: unknown,
): Result<
  EgressPolicy["injections"],
  { code: "policy_snapshot_invalid"; detail: string }
> {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "injections array required",
      },
    };
  }

  const rules: EgressPolicy["injections"] = [];

  for (const value of raw) {
    if (!isRecord(value)) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: "injection object required",
        },
      };
    }

    if (typeof value.ruleId !== "string" || value.ruleId.length === 0) {
      return {
        ok: false,
        error: { code: "policy_snapshot_invalid", detail: "invalid ruleId" },
      };
    }

    if (
      typeof value.hostPattern !== "string" ||
      value.hostPattern.length === 0
    ) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: "invalid hostPattern",
        },
      };
    }

    if (
      typeof value.credentialRef !== "string" ||
      value.credentialRef.length === 0
    ) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: "invalid credentialRef",
        },
      };
    }

    const mode = parseInjectionModeValue(value.mode);

    if (!mode.ok) {
      return mode;
    }

    rules.push({
      ruleId: value.ruleId,
      hostPattern: value.hostPattern,
      credentialRef: value.credentialRef,
      mode: mode.value,
    });
  }

  return { ok: true, value: rules };
}

function parseInjectionMode(
  raw: string,
): Result<InjectionMode, OrganisationPolicyError> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: {
        code: "credential_ref_invalid",
        detail: "inject_as JSON invalid",
      },
    };
  }

  const mode = parseInjectionModeValue(parsed);

  if (!mode.ok) {
    return {
      ok: false,
      error: { code: "credential_ref_invalid", detail: mode.error.detail },
    };
  }

  return mode;
}

function parseInjectionModeValue(
  raw: unknown,
): Result<InjectionMode, { code: "policy_snapshot_invalid"; detail: string }> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "mode object required",
      },
    };
  }

  if (raw.kind === "header") {
    if (typeof raw.header !== "string" || raw.header.length === 0) {
      return {
        ok: false,
        error: { code: "policy_snapshot_invalid", detail: "header required" },
      };
    }

    if (typeof raw.scheme !== "string" && raw.scheme !== null) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: "invalid header scheme",
        },
      };
    }

    return {
      ok: true,
      value: {
        kind: "header",
        header: raw.header.toLowerCase(),
        scheme: raw.scheme,
      },
    };
  }

  if (raw.kind === "bodyPlaceholder") {
    if (
      typeof raw.bodyPlaceholder !== "string" ||
      raw.bodyPlaceholder.length === 0
    ) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: "bodyPlaceholder required",
        },
      };
    }

    return {
      ok: true,
      value: { kind: "bodyPlaceholder", bodyPlaceholder: raw.bodyPlaceholder },
    };
  }

  return {
    ok: false,
    error: {
      code: "policy_snapshot_invalid",
      detail: "unknown injection mode",
    },
  };
}

function parseModelRoute(
  raw: unknown,
): Result<
  EgressPolicy["modelRoute"],
  { code: "policy_snapshot_invalid"; detail: string }
> {
  if (
    !isRecord(raw) ||
    typeof raw.baseUrl !== "string" ||
    raw.baseUrl.length === 0
  ) {
    return {
      ok: false,
      error: { code: "policy_snapshot_invalid", detail: "invalid modelRoute" },
    };
  }

  return { ok: true, value: { baseUrl: raw.baseUrl } };
}

function parseAuthzRules(
  raw: unknown,
): Result<AuthzRules, { code: "policy_snapshot_invalid"; detail: string }> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "authz object required",
      },
    };
  }

  const allowedTools = parseStringArray(raw.allowedTools, "allowedTools");
  const deniedTools = parseStringArray(raw.deniedTools, "deniedTools");
  const approvalRequired = parseStringArray(
    raw.approvalRequired,
    "approvalRequired",
  );
  const maxBudget = parseNullableBudget(raw.maxBudget);

  if (!allowedTools.ok) {
    return allowedTools;
  }

  if (!deniedTools.ok) {
    return deniedTools;
  }

  if (!approvalRequired.ok) {
    return approvalRequired;
  }

  if (!maxBudget.ok) {
    return maxBudget;
  }

  return {
    ok: true,
    value: {
      allowedTools: allowedTools.value,
      deniedTools: deniedTools.value,
      approvalRequired: approvalRequired.value,
      maxBudget: maxBudget.value,
    },
  };
}

function parseNullableBudget(
  raw: unknown,
): Result<Budget | null, { code: "policy_snapshot_invalid"; detail: string }> {
  if (raw === null) {
    return { ok: true, value: null };
  }

  if (!isRecord(raw)) {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "maxBudget object required",
      },
    };
  }

  const maxTokens = parseNullableBudgetLimit(raw.maxTokens, "maxTokens");
  const maxWallMs = parseNullableBudgetLimit(raw.maxWallMs, "maxWallMs");
  const maxToolCalls = parseNullableBudgetLimit(
    raw.maxToolCalls,
    "maxToolCalls",
  );

  if (!maxTokens.ok) {
    return maxTokens;
  }

  if (!maxWallMs.ok) {
    return maxWallMs;
  }

  if (!maxToolCalls.ok) {
    return maxToolCalls;
  }

  return {
    ok: true,
    value: {
      maxTokens: maxTokens.value,
      maxWallMs: maxWallMs.value,
      maxToolCalls: maxToolCalls.value,
    },
  };
}

function parseNullableBudgetLimit(
  raw: unknown,
  field: keyof Budget,
): Result<number | null, { code: "policy_snapshot_invalid"; detail: string }> {
  if (raw === null) {
    return { ok: true, value: null };
  }

  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return {
      ok: false,
      error: { code: "policy_snapshot_invalid", detail: `invalid ${field}` },
    };
  }

  return { ok: true, value: raw };
}

export function parseSessionModelRoute(
  raw: unknown,
): Result<ModelRoute, { code: "policy_snapshot_invalid"; detail: string }> {
  if (
    !isRecord(raw) ||
    typeof raw.model !== "string" ||
    raw.model.length === 0
  ) {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "invalid session modelRoute",
      },
    };
  }

  if (raw.keySource === "platform" && raw.provider === "openai-compatible") {
    if (!hasExactKeys(raw, ["keySource", "provider", "model"])) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: "invalid session modelRoute",
        },
      };
    }

    return {
      ok: true,
      value: {
        keySource: "platform",
        provider: raw.provider,
        model: raw.model,
      },
    };
  }

  if (
    raw.keySource === "organisation_byo" &&
    (raw.provider === "openai" ||
      raw.provider === "anthropic" ||
      raw.provider === "google") &&
    hasExactKeys(raw, ["keySource", "provider", "model", "byoKeyRef"]) &&
    typeof raw.byoKeyRef === "string" &&
    raw.byoKeyRef.length > 0
  ) {
    return {
      ok: true,
      value: {
        keySource: "organisation_byo",
        provider: raw.provider,
        model: raw.model,
        byoKeyRef: raw.byoKeyRef,
      },
    };
  }

  if (
    raw.keySource === "organisation_oauth" &&
    raw.provider === "anthropic" &&
    hasExactKeys(raw, ["keySource", "provider", "model", "connectionId"]) &&
    typeof raw.connectionId === "string" &&
    raw.connectionId.length > 0
  ) {
    return {
      ok: true,
      value: {
        keySource: "organisation_oauth",
        provider: "anthropic",
        model: raw.model,
        connectionId: raw.connectionId,
      },
    };
  }

  const connectionRevision = positiveIntegerOrNull(raw.connectionRevision);
  const authProfileGeneration = positiveIntegerOrNull(
    raw.authProfileGeneration,
  );
  if (
    raw.keySource === "organisation_subscription" &&
    hasExactKeys(raw, [
      "keySource",
      "provider",
      "model",
      "connectionRevision",
      "authProfileGeneration",
    ]) &&
    raw.provider === "openai" &&
    connectionRevision !== null &&
    authProfileGeneration !== null
  ) {
    return {
      ok: true,
      value: {
        keySource: "organisation_subscription",
        provider: "openai",
        model: raw.model,
        connectionRevision,
        authProfileGeneration,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "policy_snapshot_invalid",
      detail: "invalid session modelRoute",
    },
  };
}

function parseConversationRiskPolicy(
  raw: unknown,
): Result<
  ConversationRiskPolicy,
  { code: "policy_snapshot_invalid"; detail: string }
> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "conversationRisk object required",
      },
    };
  }

  const outputScreeningMode = parseConversationRiskOutputScreeningMode(
    raw.outputScreeningMode,
  );

  if (!outputScreeningMode.ok) {
    return outputScreeningMode;
  }

  return {
    ok: true,
    value: {
      outputScreeningMode: outputScreeningMode.value,
    },
  };
}

function parseConversationRiskOutputScreeningMode(
  raw: unknown,
): Result<
  ConversationRiskOutputScreeningMode,
  { code: "policy_snapshot_invalid"; detail: string }
> {
  if (raw === "hold" || raw === "stream") {
    return { ok: true, value: raw };
  }

  return {
    ok: false,
    error: {
      code: "policy_snapshot_invalid",
      detail: "invalid outputScreeningMode",
    },
  };
}

function defaultConversationRiskPolicy(): ConversationRiskPolicy {
  return {
    outputScreeningMode: "stream",
  };
}

function parseStringArray(
  raw: unknown,
  field: string,
): Result<string[], { code: "policy_snapshot_invalid"; detail: string }> {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: `${field} array required`,
      },
    };
  }

  const values: string[] = [];
  const seen = new Set<string>();

  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: `${field} string required`,
        },
      };
    }

    if (seen.has(value)) {
      return {
        ok: false,
        error: {
          code: "policy_snapshot_invalid",
          detail: `${field} must not contain duplicates`,
        },
      };
    }

    seen.add(value);
    values.push(value);
  }

  return { ok: true, value: values };
}

async function nextPolicyVersion(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM policy_snapshot
       WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{ version: number }>();

  return row?.version ?? 1;
}

async function distributePolicy(
  bindings: PolicyBindings,
  organisationId: OrganisationId,
  snapshot: OrganisationPolicySnapshot,
): Promise<void> {
  const body = JSON.stringify(snapshot);
  await bindings.kv.put(
    versionPolicyKey(organisationId, snapshot.version),
    body,
  );
  await bindings.kv.put(latestPolicyKey(organisationId), body);
}

// Plan 12 V6: archiving an organisation removes its latest policy pointer so any
// consumer that reloads converges on the fail-closed default-deny path.
// Versioned snapshot keys remain immutable history. Enforcement does not
// depend on this: every resolver rechecks the authoritative organisation and
// onboarding lifecycle in D1 before decrypting.
export async function holdOrganisationPolicyDistribution(input: {
  readonly kv: KVNamespace;
  readonly organisationId: OrganisationId;
}): Promise<void> {
  await input.kv.delete(latestPolicyKey(input.organisationId));
}

function latestPolicyKey(organisationId: OrganisationId): string {
  return `${POLICY_KV_PREFIX}:${organisationId}:latest`;
}

function versionPolicyKey(
  organisationId: OrganisationId,
  version: number,
): string {
  return `${POLICY_KV_PREFIX}:${organisationId}:v${version}`;
}

function policySnapshotsMatch(
  authoritative: OrganisationPolicySnapshot,
  distributed: OrganisationPolicySnapshot,
): boolean {
  return (
    authoritative.version === distributed.version &&
    JSON.stringify(authoritative) === JSON.stringify(distributed)
  );
}

function capabilityPolicyErrorDetail(
  error: import("./data/capability-policy").CapabilityPolicyError,
): string {
  switch (error.code) {
    case "capability_policy_invalid":
      return `invalid ${error.field}`;
    case "capability_policy_revision_conflict":
      return `revision conflict at ${error.expected}`;
    case "capability_policy_placement_conflict":
      return error.code;
    case "capability_policy_store_failed":
      return error.detail;
  }
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function policyPlacementConflict(): Result<never, OrganisationPolicyError> {
  return {
    ok: false,
    error: {
      code: "policy_settlement_failed",
      detail: "Organisation placement changed during policy publication",
    },
  };
}
