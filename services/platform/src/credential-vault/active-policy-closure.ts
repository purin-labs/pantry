import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationDO } from "../actors/organisation";
import type { OrganisationStateError } from "../actors/organisation/types";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import type { VaultHandle } from "./domain";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

type ActivePolicyCredentialStub = Pick<
  OrganisationDO,
  "inspectActivePolicyCredentials"
>;

export type ActivePolicyCredentialClosureFinding =
  | {
      readonly kind: "active_policy_missing";
      readonly organisationId: OrganisationId;
    }
  | {
      readonly kind: "active_policy_ref_without_live_vault";
      readonly organisationId: OrganisationId;
      readonly policyVersion: number;
      readonly ruleId: string;
      readonly vaultHandle: VaultHandle;
      readonly vaultIssue: "missing" | "revoked";
    };

export type ActivePolicyCredentialClosure =
  | {
      readonly status: "passed";
      readonly organisationId: OrganisationId;
      readonly activePolicyVersion: number;
      readonly findings: readonly [];
    }
  | {
      readonly status: "failed";
      readonly organisationId: OrganisationId;
      readonly activePolicyVersion: number | null;
      readonly findings: readonly [
        ActivePolicyCredentialClosureFinding,
        ...ActivePolicyCredentialClosureFinding[],
      ];
    };

export type ActivePolicyCredentialClosureError =
  | OrganisationStateError
  | { readonly code: "active_policy_closure_data_invalid" };

type ActivePolicyVaultFindingRow = {
  readonly ruleId: unknown;
  readonly vaultHandle: unknown;
  readonly vaultIssue: unknown;
};

export async function inspectActivePolicyCredentialClosure(input: {
  readonly db: OrganisationDatabase;
  readonly organisation: ActivePolicyCredentialStub;
  readonly organisationId: OrganisationId;
}): Promise<
  Result<ActivePolicyCredentialClosure, ActivePolicyCredentialClosureError>
> {
  const inspected = await input.organisation.inspectActivePolicyCredentials({
    organisationId: input.organisationId,
  });

  if (!inspected.ok) {
    return inspected;
  }
  if (inspected.value.organisationId !== input.organisationId) {
    return {
      ok: false,
      error: { code: "active_policy_closure_data_invalid" },
    };
  }

  switch (inspected.value.kind) {
    case "no_active_policy":
      return {
        ok: true,
        value: {
          status: "failed",
          organisationId: input.organisationId,
          activePolicyVersion: null,
          findings: [
            {
              kind: "active_policy_missing",
              organisationId: input.organisationId,
            },
          ],
        },
      };
    case "active_policy":
      return inspectActivePolicyVaultRefs({
        db: input.db,
        organisationId: input.organisationId,
        activePolicyVersion: inspected.value.activeVersion,
        credentialRefs: inspected.value.credentialRefs,
      });
    default:
      return assertNever(inspected.value);
  }
}

async function inspectActivePolicyVaultRefs(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly activePolicyVersion: number;
  readonly credentialRefs: readonly {
    readonly ruleId: string;
    readonly credentialRef: VaultHandle;
  }[];
}): Promise<
  Result<ActivePolicyCredentialClosure, ActivePolicyCredentialClosureError>
> {
  if (input.credentialRefs.length === 0) {
    return passedClosure(input.organisationId, input.activePolicyVersion);
  }

  const rows = await input.db
    .prepare(
      `WITH policy_ref AS (
       SELECT json_extract(value, '$.ruleId') AS ruleId,
              json_extract(value, '$.credentialRef') AS vaultHandle
       FROM json_each(?)
     )
     SELECT policy_ref.ruleId AS ruleId,
            policy_ref.vaultHandle AS vaultHandle,
            CASE
              WHEN secret.vault_handle IS NULL THEN 'missing'
              ELSE 'revoked'
            END AS vaultIssue
     FROM policy_ref
     LEFT JOIN vault_secret AS secret
       ON secret.organisation_id = ?
      AND secret.vault_handle = policy_ref.vaultHandle
     WHERE secret.vault_handle IS NULL OR secret.revoked_at IS NOT NULL
     ORDER BY policy_ref.ruleId, policy_ref.vaultHandle`,
    )
    .bind(JSON.stringify(input.credentialRefs), input.organisationId)
    .all<ActivePolicyVaultFindingRow>();
  if (!Array.isArray(rows.results)) {
    return {
      ok: false,
      error: { code: "active_policy_closure_data_invalid" },
    };
  }
  const findings: ActivePolicyCredentialClosureFinding[] = [];

  for (const row of rows.results) {
    const finding = parseVaultFinding(row, input);
    if (!finding.ok) {
      return finding;
    }
    findings.push(finding.value);
  }

  const [first, ...rest] = findings;
  return first === undefined
    ? passedClosure(input.organisationId, input.activePolicyVersion)
    : {
        ok: true,
        value: {
          status: "failed",
          organisationId: input.organisationId,
          activePolicyVersion: input.activePolicyVersion,
          findings: [first, ...rest],
        },
      };
}

function parseVaultFinding(
  row: ActivePolicyVaultFindingRow,
  input: {
    readonly organisationId: OrganisationId;
    readonly activePolicyVersion: number;
    readonly credentialRefs: readonly {
      readonly ruleId: string;
      readonly credentialRef: VaultHandle;
    }[];
  },
): Result<
  Variant<
    ActivePolicyCredentialClosureFinding,
    "active_policy_ref_without_live_vault"
  >,
  { readonly code: "active_policy_closure_data_invalid" }
> {
  const expected = input.credentialRefs.find(
    matchesVaultFindingRow.bind(null, row),
  );
  if (
    expected === undefined ||
    (row.vaultIssue !== "missing" && row.vaultIssue !== "revoked")
  ) {
    return { ok: false, error: { code: "active_policy_closure_data_invalid" } };
  }
  return {
    ok: true,
    value: {
      kind: "active_policy_ref_without_live_vault",
      organisationId: input.organisationId,
      policyVersion: input.activePolicyVersion,
      ruleId: expected.ruleId,
      vaultHandle: expected.credentialRef,
      vaultIssue: row.vaultIssue,
    },
  };
}

function matchesVaultFindingRow(
  row: ActivePolicyVaultFindingRow,
  reference: { readonly ruleId: string; readonly credentialRef: VaultHandle },
): boolean {
  return (
    row.ruleId === reference.ruleId &&
    row.vaultHandle === reference.credentialRef
  );
}

function passedClosure(
  organisationId: OrganisationId,
  activePolicyVersion: number,
): Result<ActivePolicyCredentialClosure, never> {
  return {
    ok: true,
    value: {
      status: "passed",
      organisationId,
      activePolicyVersion,
      findings: [],
    },
  };
}
