import type {
  GlobalDatabase,
  OrganisationDatabase,
} from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  authorizeSessionTurnExecution,
  type SessionTurnExecution,
} from "../chat/turn-access";
import {
  resolveOperationalEmailContact,
  type EmailProposalTarget,
  type EmailSelfTestTarget,
} from "./email-operational";

export const EMAIL_SELF_TEST_SUBJECT = "Pantry Gmail canary";
export const EMAIL_SELF_TEST_BODY =
  "This is a synthetic test of Pantry's email drafting and approval workflow. No action is required.";

export type EmailSelfTestRequest = Readonly<{
  kind: "self_test";
  address: string;
  selfTestId?: never;
  customerId?: never;
  supplierId?: never;
  contactId?: never;
  contactRevision?: never;
}>;

export function parseEmailSelfTestRequest(
  value: unknown,
): EmailSelfTestRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const fields = new Map(Object.entries(value));
  const address = fields.get("address");
  if (
    fields.size !== 2 ||
    fields.get("kind") !== "self_test" ||
    typeof address !== "string" ||
    address.length > 320 ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(address)
  )
    return null;
  return { kind: "self_test", address: address.toLowerCase() };
}

export function validEmailSelfTestContent(
  target: EmailProposalTarget | EmailSelfTestRequest,
  subject: string,
  body: string,
): boolean {
  return (
    target.kind !== "self_test" ||
    (subject === EMAIL_SELF_TEST_SUBJECT && body === EMAIL_SELF_TEST_BODY)
  );
}

type SelfTestScope = Readonly<{
  db: Pick<OrganisationDatabase, "prepare">;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  proposalId: string;
  caseId: string;
  now: number;
}>;

export async function registerEmailSelfTest(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    globalDatabase: GlobalDatabase;
    execution: SessionTurnExecution;
    integrationAccountId: IntegrationAccountId;
    proposalId: string;
    caseId: string;
    now: number;
    request: EmailSelfTestRequest;
    expiresAt: number;
  }>,
): Promise<Result<EmailSelfTestTarget, { code: string }>> {
  if (
    input.expiresAt <= input.now ||
    input.expiresAt > input.now + 15 * 60_000
  ) {
    return { ok: false, error: { code: "email_self_test_expiry_invalid" } };
  }
  if (!(await authorizeEmailSelfTestRegistration(input)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const db = input.scope.database.withSession("first-primary");
  await db
    .prepare(
      `DELETE FROM email_self_test WHERE organisation_id = ? AND expires_at <= ?
       AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
         AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      input.scope.organisationId,
      input.now,
      input.scope.organisationId,
      input.scope.placement.placementEpoch,
      input.scope.placement.placementCellId,
      input.scope.fenceToken,
    )
    .run();
  if (!(await authorizeEmailSelfTestRegistration(input)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  await db
    .prepare(
      `INSERT INTO email_self_test (
    organisation_id, self_test_id, integration_account_id, case_id, address, expires_at
  ) SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
      AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')
    ON CONFLICT (organisation_id, self_test_id) DO NOTHING`,
    )
    .bind(
      input.scope.organisationId,
      input.proposalId,
      input.integrationAccountId,
      input.caseId,
      input.request.address,
      input.expiresAt,
      input.scope.organisationId,
      input.scope.placement.placementEpoch,
      input.scope.placement.placementCellId,
      input.scope.fenceToken,
    )
    .run();
  if (!(await authorizeEmailSelfTestRegistration(input)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  const target: EmailSelfTestTarget = {
    kind: "self_test",
    selfTestId: input.proposalId,
  };
  const resolved = await resolveEmailProposalRecipient({
    db,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
    proposalId: input.proposalId,
    caseId: input.caseId,
    now: input.now,
    target,
  });
  if (!(await authorizeEmailSelfTestRegistration(input)))
    return {
      ok: false,
      error: { code: "session_execution_authority_inactive" },
    };
  if (!resolved.ok || resolved.value.address !== input.request.address) {
    return { ok: false, error: { code: "email_self_test_conflict" } };
  }
  return { ok: true, value: target };
}

async function authorizeEmailSelfTestRegistration(
  input: Pick<
    Parameters<typeof registerEmailSelfTest>[0],
    "scope" | "globalDatabase" | "execution"
  >,
): Promise<boolean> {
  if (!(await input.scope.isActive())) return false;
  const authorized = await authorizeSessionTurnExecution(
    input.globalDatabase,
    input.scope.database,
    input.scope.organisationId,
    input.execution,
    input.scope.accountAccess,
  );
  return authorized && (await input.scope.isActive());
}

export async function resolveEmailProposalRecipient(
  input: SelfTestScope &
    Readonly<{
      target: EmailProposalTarget;
    }>,
): Promise<
  Result<{ address: string; displayName: string | null }, { code: string }>
> {
  if (input.target.kind !== "self_test")
    return resolveOperationalEmailContact({
      db: input.db,
      organisationId: input.organisationId,
      target: input.target,
    });
  if (input.target.selfTestId !== input.proposalId) {
    return { ok: false, error: { code: "email_self_test_scope_invalid" } };
  }
  const row = await input.db
    .prepare(
      `SELECT address FROM email_self_test
    WHERE organisation_id = ? AND self_test_id = ? AND integration_account_id = ?
      AND case_id = ? AND expires_at > ?`,
    )
    .bind(
      input.organisationId,
      input.target.selfTestId,
      input.integrationAccountId,
      input.caseId,
      input.now,
    )
    .first<{ address: unknown }>();
  const parsed = parseEmailSelfTestRequest({
    kind: "self_test",
    address: row?.address,
  });
  return parsed === null
    ? { ok: false, error: { code: "email_self_test_unavailable" } }
    : { ok: true, value: { address: parsed.address, displayName: null } };
}
