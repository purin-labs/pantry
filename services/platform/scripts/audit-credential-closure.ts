import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  auditCredentialClosure,
  type CredentialClosureAuditResult,
  type CredentialClosureDatabase,
  type CredentialClosureQueryResult,
  type CredentialClosureStatement,
} from "../src/credential-vault/closure-audit.ts";
import type {
  ActivePolicyCredentialClosure,
  ActivePolicyCredentialClosureFinding,
} from "../src/credential-vault/active-policy-closure.ts";
import type {
  RetainedVaultRootClosure,
  RetainedVaultRootClosureFinding,
  RetainedVaultRootVersionSummary,
} from "../src/credential-vault/root-closure.ts";
import { parseVaultHandle } from "../src/credential-vault/domain.ts";
import { parseOrganisationId, type OrganisationId } from "../src/ids.ts";
import { isNonNegativeInteger, isPositiveInteger, isRecord } from "@seams/std";

const DATABASE_NAME = "satyr";
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_ACTIVE_ORGANISATIONS = 512;
const RECEIPT_SCHEMA = "satyr.credential-closure-receipt.v1";

export type CredentialClosureAuditMode = "local" | "remote";

export type CredentialClosureEvidenceReason =
  | "invalid_arguments"
  | "d1_command_failed"
  | "d1_response_invalid"
  | "audit_data_invalid"
  | "worker_configuration_invalid"
  | "active_organisation_inventory_invalid"
  | "active_organisation_inventory_empty"
  | "active_organisation_inventory_exceeded"
  | "active_organisation_inventory_changed"
  | "actor_request_failed"
  | "actor_response_invalid"
  | "vault_root_request_failed"
  | "vault_root_response_invalid";

export type CredentialClosureCohort = {
  readonly organisationCount: number;
  readonly organisationDigest: string;
};

export type ActivePolicyCredentialClosureReceipt = {
  readonly organisationId: OrganisationId;
  readonly closure: ActivePolicyCredentialClosure;
};

type CredentialClosureCompletedState = {
  readonly status: "passed" | "failed";
  readonly mode: CredentialClosureAuditMode;
  readonly workerOrigin: string;
  readonly cohort: CredentialClosureCohort;
  readonly d1: CredentialClosureAuditResult;
  readonly activePolicies: readonly ActivePolicyCredentialClosureReceipt[];
  readonly retainedVaultRoots: RetainedVaultRootClosure;
};

type CredentialClosureFindingCount = {
  readonly kind: string;
  readonly count: number;
};

type CredentialClosureCompletedReceipt = {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly status: "passed" | "failed";
  readonly mode: CredentialClosureAuditMode;
  readonly workerOrigin: string;
  readonly cohort: CredentialClosureCohort;
  readonly d1: {
    readonly status: "passed" | "failed";
    readonly summary: CredentialClosureAuditResult["summary"];
    readonly findingKinds: readonly CredentialClosureFindingCount[];
  };
  readonly activePolicies: {
    readonly status: "passed" | "failed";
    readonly auditedOrganisationCount: number;
    readonly failedOrganisationCount: number;
    readonly findingKinds: readonly CredentialClosureFindingCount[];
  };
  readonly retainedVaultRoots: {
    readonly status: "passed" | "failed";
    readonly auditedRowCount: number;
    readonly revokedRowCount: number;
    readonly versions: readonly RetainedVaultRootVersionSummary[];
    readonly findingKinds: readonly CredentialClosureFindingCount[];
  };
};

export type CredentialClosureCommandResult =
  | CredentialClosureCompletedReceipt
  | {
      readonly schema: typeof RECEIPT_SCHEMA;
      readonly status: "evidence_missing";
      readonly mode: CredentialClosureAuditMode | "unresolved";
      readonly reason: CredentialClosureEvidenceReason;
    };

export type CredentialClosureCommandOutcome = {
  readonly result: CredentialClosureCommandResult;
  readonly exitCode: 0 | 1 | 2;
};

export type WranglerExecutor = (args: readonly string[]) => string;
export type CredentialClosureFetch = (request: Request) => Promise<Response>;

export type CredentialClosureCommandRuntime = {
  readonly execute: WranglerExecutor;
  readonly fetch: CredentialClosureFetch;
  readonly environment: {
    readonly PANTRY_WORKER_URL?: string;
    readonly ORGANISATION_ADMIN_TOKEN?: string;
  };
};

type ModeParseResult =
  | { readonly ok: true; readonly mode: CredentialClosureAuditMode }
  | { readonly ok: false };

type WorkerConfiguration = {
  readonly origin: string;
  readonly adminToken: string;
};

class CredentialClosureCommandError extends Error {
  readonly reason: CredentialClosureEvidenceReason;

  constructor(reason: CredentialClosureEvidenceReason) {
    super(reason);
    this.reason = reason;
  }
}

class WranglerD1Database implements CredentialClosureDatabase {
  constructor(
    private readonly databaseName: string,
    private readonly mode: CredentialClosureAuditMode,
    private readonly execute: WranglerExecutor,
  ) {}

  prepare(query: string): CredentialClosureStatement {
    return new WranglerD1Statement(
      this.databaseName,
      this.mode,
      query,
      this.execute,
    );
  }
}

class WranglerD1Statement implements CredentialClosureStatement {
  constructor(
    private readonly databaseName: string,
    private readonly mode: CredentialClosureAuditMode,
    private readonly query: string,
    private readonly execute: WranglerExecutor,
  ) {}

  async all(): Promise<CredentialClosureQueryResult> {
    const args = buildWranglerArguments(
      this.databaseName,
      this.mode,
      this.query,
    );
    let output: string;

    try {
      output = this.execute(args);
    } catch {
      throw new CredentialClosureCommandError("d1_command_failed");
    }

    return { results: parseWranglerOutput(output) };
  }
}

export async function runCredentialClosureCommand(
  argv: readonly string[],
  runtime: CredentialClosureCommandRuntime = defaultRuntime(),
): Promise<CredentialClosureCommandOutcome> {
  const parsedMode = parseMode(argv);
  if (!parsedMode.ok) {
    return evidenceMissing("unresolved", "invalid_arguments");
  }

  const worker = parseWorkerConfiguration(parsedMode.mode, runtime.environment);
  if (worker === null) {
    return evidenceMissing(parsedMode.mode, "worker_configuration_invalid");
  }

  try {
    const db = new WranglerD1Database(
      DATABASE_NAME,
      parsedMode.mode,
      runtime.execute,
    );
    const initialOrganisations = await readActiveOrganisationCohort(db);
    const d1 = await auditCredentialClosure(db);
    const activePolicies = await inspectActivePolicyCredentials({
      organisationIds: initialOrganisations,
      worker,
      fetch: runtime.fetch,
    });
    const retainedVaultRoots = await inspectRetainedVaultRoots({
      worker,
      fetch: runtime.fetch,
    });
    const finalOrganisations = await readActiveOrganisationCohort(db);
    if (!sameOrganisationCohort(initialOrganisations, finalOrganisations)) {
      return evidenceMissing(
        parsedMode.mode,
        "active_organisation_inventory_changed",
      );
    }

    const status =
      d1.status === "failed" ||
      activePolicies.some(hasFailedPolicyClosure) ||
      retainedVaultRoots.status === "failed"
        ? "failed"
        : "passed";
    const completed: CredentialClosureCompletedState = {
      status,
      mode: parsedMode.mode,
      workerOrigin: worker.origin,
      cohort: cohortReceipt(initialOrganisations),
      d1,
      activePolicies,
      retainedVaultRoots,
    };
    return {
      result: credentialClosureReceipt(completed),
      exitCode: status === "passed" ? 0 : 1,
    };
  } catch (error) {
    const reason =
      error instanceof CredentialClosureCommandError
        ? error.reason
        : "audit_data_invalid";
    return evidenceMissing(parsedMode.mode, reason);
  }
}

async function inspectRetainedVaultRoots(input: {
  readonly worker: WorkerConfiguration;
  readonly fetch: CredentialClosureFetch;
}): Promise<RetainedVaultRootClosure> {
  const url = new URL("/v1/admin/vault-root-closure", input.worker.origin);
  let response: Response;
  try {
    response = await input.fetch(
      new Request(url, {
        headers: { authorization: `Bearer ${input.worker.adminToken}` },
      }),
    );
  } catch {
    throw new CredentialClosureCommandError("vault_root_request_failed");
  }
  if (!response.ok) {
    throw new CredentialClosureCommandError("vault_root_request_failed");
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new CredentialClosureCommandError("vault_root_response_invalid");
  }
  const closure = parseRetainedVaultRootClosureResponse(raw);
  if (closure === null) {
    throw new CredentialClosureCommandError("vault_root_response_invalid");
  }
  return closure;
}

function parseRetainedVaultRootClosureResponse(
  raw: unknown,
): RetainedVaultRootClosure | null {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.closure)) return null;
  const closure = raw.closure;
  if (
    !isNonNegativeInteger(closure.auditedRowCount) ||
    !isNonNegativeInteger(closure.revokedRowCount) ||
    closure.revokedRowCount > closure.auditedRowCount ||
    !Array.isArray(closure.versions) ||
    !Array.isArray(closure.findings)
  ) {
    return null;
  }
  const versions = parseRetainedVaultRootVersions(closure.versions);
  if (
    versions === null ||
    sumRootVersionRows(versions) !== closure.auditedRowCount
  ) {
    return null;
  }
  const findings = parseRetainedVaultRootFindings(closure.findings, versions);
  if (findings === null || !rootCountsReconcile(versions, findings))
    return null;
  const counts = {
    auditedRowCount: closure.auditedRowCount,
    revokedRowCount: closure.revokedRowCount,
    versions,
  };
  const [first, ...rest] = findings;
  if (closure.status === "passed") {
    return first === undefined
      ? { status: "passed", ...counts, findings: [] }
      : null;
  }
  return closure.status === "failed" && first !== undefined
    ? { status: "failed", ...counts, findings: [first, ...rest] }
    : null;
}

function parseRetainedVaultRootVersions(
  raw: readonly unknown[],
): RetainedVaultRootVersionSummary[] | null {
  const versions: RetainedVaultRootVersionSummary[] = [];
  let previousOrder = -1;
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      (entry.keyVersion !== "v1" && entry.keyVersion !== "v2") ||
      !isPositiveInteger(entry.rowCount) ||
      !isNonNegativeInteger(entry.decryptedCount) ||
      entry.decryptedCount > entry.rowCount
    ) {
      return null;
    }
    const order = entry.keyVersion === "v1" ? 0 : 1;
    if (order <= previousOrder) return null;
    versions.push({
      keyVersion: entry.keyVersion,
      rowCount: entry.rowCount,
      decryptedCount: entry.decryptedCount,
    });
    previousOrder = order;
  }
  return versions;
}

function parseRetainedVaultRootFindings(
  raw: readonly unknown[],
  versions: readonly RetainedVaultRootVersionSummary[],
): RetainedVaultRootClosureFinding[] | null {
  const findings: RetainedVaultRootClosureFinding[] = [];
  const keys = new Set<string>();
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      (entry.keyVersion !== "v1" && entry.keyVersion !== "v2") ||
      !isPositiveInteger(entry.affectedRows) ||
      !versions.some(matchesRootVersion.bind(null, entry.keyVersion)) ||
      (entry.kind !== "referenced_vault_root_unavailable" &&
        entry.kind !== "retained_vault_ciphertext_invalid" &&
        entry.kind !== "retained_vault_plaintext_invalid")
    ) {
      return null;
    }
    const key = `${entry.keyVersion}:${entry.kind}`;
    if (keys.has(key)) return null;
    findings.push({
      kind: entry.kind,
      keyVersion: entry.keyVersion,
      affectedRows: entry.affectedRows,
    });
    keys.add(key);
  }
  return findings;
}

function matchesRootVersion(
  keyVersion: "v1" | "v2",
  version: RetainedVaultRootVersionSummary,
): boolean {
  return version.keyVersion === keyVersion;
}

function sumRootVersionRows(
  versions: readonly RetainedVaultRootVersionSummary[],
): number {
  return versions.reduce(sumRootRows, 0);
}

function sumRootRows(
  total: number,
  version: RetainedVaultRootVersionSummary,
): number {
  return total + version.rowCount;
}

function rootCountsReconcile(
  versions: readonly RetainedVaultRootVersionSummary[],
  findings: readonly RetainedVaultRootClosureFinding[],
): boolean {
  return versions.every(rootVersionCountsReconcile.bind(null, findings));
}

function rootVersionCountsReconcile(
  findings: readonly RetainedVaultRootClosureFinding[],
  version: RetainedVaultRootVersionSummary,
): boolean {
  const affected = findings
    .filter(matchesRootFindingVersion.bind(null, version.keyVersion))
    .reduce(sumAffectedRows, 0);
  return version.decryptedCount + affected === version.rowCount;
}

function matchesRootFindingVersion(
  keyVersion: "v1" | "v2",
  finding: RetainedVaultRootClosureFinding,
): boolean {
  return finding.keyVersion === keyVersion;
}

function sumAffectedRows(
  total: number,
  finding: RetainedVaultRootClosureFinding,
): number {
  return total + finding.affectedRows;
}

async function readActiveOrganisationCohort(
  db: CredentialClosureDatabase,
): Promise<readonly OrganisationId[]> {
  const result = await db
    .prepare(
      `SELECT organisation_id AS organisationId
     FROM organisation
     WHERE status = 'active'
     ORDER BY organisation_id
     LIMIT ${MAX_ACTIVE_ORGANISATIONS + 1}`,
    )
    .all();
  if (!Array.isArray(result.results)) {
    throw new CredentialClosureCommandError(
      "active_organisation_inventory_invalid",
    );
  }
  if (result.results.length === 0) {
    throw new CredentialClosureCommandError(
      "active_organisation_inventory_empty",
    );
  }
  if (result.results.length > MAX_ACTIVE_ORGANISATIONS) {
    throw new CredentialClosureCommandError(
      "active_organisation_inventory_exceeded",
    );
  }

  const organisationIds: OrganisationId[] = [];
  let previous: OrganisationId | null = null;
  for (const raw of result.results) {
    if (!isRecord(raw) || typeof raw.organisationId !== "string") {
      throw new CredentialClosureCommandError(
        "active_organisation_inventory_invalid",
      );
    }
    const parsed = parseOrganisationId(raw.organisationId);
    if (!parsed.ok || (previous !== null && previous >= parsed.value)) {
      throw new CredentialClosureCommandError(
        "active_organisation_inventory_invalid",
      );
    }
    organisationIds.push(parsed.value);
    previous = parsed.value;
  }
  return organisationIds;
}

async function inspectActivePolicyCredentials(input: {
  readonly organisationIds: readonly OrganisationId[];
  readonly worker: WorkerConfiguration;
  readonly fetch: CredentialClosureFetch;
}): Promise<readonly ActivePolicyCredentialClosureReceipt[]> {
  const receipts: ActivePolicyCredentialClosureReceipt[] = [];
  for (const organisationId of input.organisationIds) {
    receipts.push(
      await inspectOrganisationActivePolicy({
        organisationId,
        worker: input.worker,
        fetch: input.fetch,
      }),
    );
  }
  return receipts;
}

async function inspectOrganisationActivePolicy(input: {
  readonly organisationId: OrganisationId;
  readonly worker: WorkerConfiguration;
  readonly fetch: CredentialClosureFetch;
}): Promise<ActivePolicyCredentialClosureReceipt> {
  const url = new URL(
    "/v1/admin/active-policy-credential-closure",
    input.worker.origin,
  );
  url.searchParams.set("organisationId", input.organisationId);
  let response: Response;
  try {
    response = await input.fetch(
      new Request(url, {
        headers: { authorization: `Bearer ${input.worker.adminToken}` },
      }),
    );
  } catch {
    throw new CredentialClosureCommandError("actor_request_failed");
  }
  if (!response.ok) {
    throw new CredentialClosureCommandError("actor_request_failed");
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new CredentialClosureCommandError("actor_response_invalid");
  }
  const closure = parseActivePolicyClosureResponse(raw, input.organisationId);
  if (closure === null) {
    throw new CredentialClosureCommandError("actor_response_invalid");
  }
  return { organisationId: input.organisationId, closure };
}

function parseActivePolicyClosureResponse(
  raw: unknown,
  expectedOrganisationId: OrganisationId,
): ActivePolicyCredentialClosure | null {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.closure)) return null;
  const closure = raw.closure;
  const organisationId =
    typeof closure.organisationId === "string"
      ? parseOrganisationId(closure.organisationId)
      : { ok: false as const };
  if (
    !organisationId.ok ||
    organisationId.value !== expectedOrganisationId ||
    !Array.isArray(closure.findings)
  ) {
    return null;
  }

  if (closure.status === "passed") {
    return isPositiveInteger(closure.activePolicyVersion) &&
      closure.findings.length === 0
      ? {
          status: "passed",
          organisationId: organisationId.value,
          activePolicyVersion: closure.activePolicyVersion,
          findings: [],
        }
      : null;
  }
  if (closure.status !== "failed" || closure.findings.length === 0) return null;

  const findings: ActivePolicyCredentialClosureFinding[] = [];
  for (const finding of closure.findings) {
    const parsed = parseActivePolicyClosureFinding(
      finding,
      organisationId.value,
    );
    if (parsed === null) return null;
    findings.push(parsed);
  }
  const [first, ...rest] = findings;
  if (first === undefined) return null;
  if (first.kind === "active_policy_missing") {
    return closure.activePolicyVersion === null && findings.length === 1
      ? {
          status: "failed",
          organisationId: organisationId.value,
          activePolicyVersion: null,
          findings: [first],
        }
      : null;
  }
  if (!isPositiveInteger(closure.activePolicyVersion)) return null;
  for (const finding of findings) {
    if (
      finding.kind !== "active_policy_ref_without_live_vault" ||
      finding.policyVersion !== closure.activePolicyVersion
    )
      return null;
  }
  return {
    status: "failed",
    organisationId: organisationId.value,
    activePolicyVersion: closure.activePolicyVersion,
    findings: [first, ...rest],
  };
}

function parseActivePolicyClosureFinding(
  raw: unknown,
  organisationId: OrganisationId,
): ActivePolicyCredentialClosureFinding | null {
  if (!isRecord(raw) || raw.organisationId !== organisationId) return null;
  if (raw.kind === "active_policy_missing") {
    return { kind: "active_policy_missing", organisationId };
  }
  if (
    raw.kind !== "active_policy_ref_without_live_vault" ||
    !isPositiveInteger(raw.policyVersion) ||
    typeof raw.ruleId !== "string" ||
    raw.ruleId.length === 0 ||
    typeof raw.vaultHandle !== "string" ||
    (raw.vaultIssue !== "missing" && raw.vaultIssue !== "revoked")
  )
    return null;
  const handle = parseVaultHandle(raw.vaultHandle);
  return handle.ok
    ? {
        kind: "active_policy_ref_without_live_vault",
        organisationId,
        policyVersion: raw.policyVersion,
        ruleId: raw.ruleId,
        vaultHandle: handle.value,
        vaultIssue: raw.vaultIssue,
      }
    : null;
}

function hasFailedPolicyClosure(
  receipt: ActivePolicyCredentialClosureReceipt,
): boolean {
  return receipt.closure.status === "failed";
}

function cohortReceipt(
  organisationIds: readonly OrganisationId[],
): CredentialClosureCohort {
  return {
    organisationCount: organisationIds.length,
    organisationDigest: createHash("sha256")
      .update(JSON.stringify(organisationIds))
      .digest("hex"),
  };
}

function sameOrganisationCohort(
  left: readonly OrganisationId[],
  right: readonly OrganisationId[],
): boolean {
  return (
    left.length === right.length &&
    left.every(matchesOrganisationAtIndex.bind(null, right))
  );
}

function matchesOrganisationAtIndex(
  right: readonly OrganisationId[],
  organisationId: OrganisationId,
  index: number,
): boolean {
  return right[index] === organisationId;
}

function parseWorkerConfiguration(
  mode: CredentialClosureAuditMode,
  environment: CredentialClosureCommandRuntime["environment"],
): WorkerConfiguration | null {
  const token = environment.ORGANISATION_ADMIN_TOKEN;
  const rawUrl = environment.PANTRY_WORKER_URL;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof rawUrl !== "string"
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  )
    return null;

  const loopback = isLoopbackHostname(url.hostname);
  if (mode === "local" && !loopback) return null;
  if (mode === "remote" && (url.protocol !== "https:" || loopback)) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { origin: url.origin, adminToken: token };
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}

function buildWranglerArguments(
  databaseName: string,
  mode: CredentialClosureAuditMode,
  query: string,
): readonly string[] {
  return [
    "exec",
    "wrangler",
    "d1",
    "execute",
    databaseName,
    "--env",
    mode === "remote" ? "production" : "local",
    mode === "remote" ? "--remote" : "--local",
    ...(mode === "local"
      ? ["--persist-to", ".wrangler/square-acceptance"]
      : []),
    "--command",
    query,
    "--json",
  ];
}

function parseMode(argv: readonly string[]): ModeParseResult {
  if (argv.length === 0) return { ok: true, mode: "local" };
  return argv.length === 1 && argv[0] === "--remote"
    ? { ok: true, mode: "remote" }
    : { ok: false };
}

function executeWrangler(args: readonly string[]): string {
  return execFileSync("pnpm", [...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function defaultRuntime(): CredentialClosureCommandRuntime {
  return {
    execute: executeWrangler,
    fetch: globalThis.fetch,
    environment: {
      PANTRY_WORKER_URL: process.env.PANTRY_WORKER_URL,
      ORGANISATION_ADMIN_TOKEN: process.env.ORGANISATION_ADMIN_TOKEN,
    },
  };
}

function parseWranglerOutput(output: string): readonly unknown[] {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new CredentialClosureCommandError("d1_response_invalid");
  }
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new CredentialClosureCommandError("d1_response_invalid");
  }
  const response = raw[0];
  if (
    !isRecord(response) ||
    response.success !== true ||
    !Array.isArray(response.results)
  ) {
    throw new CredentialClosureCommandError("d1_response_invalid");
  }
  return response.results;
}

function evidenceMissing(
  mode: CredentialClosureAuditMode | "unresolved",
  reason: CredentialClosureEvidenceReason,
): CredentialClosureCommandOutcome {
  return {
    result: {
      schema: RECEIPT_SCHEMA,
      status: "evidence_missing",
      mode,
      reason,
    },
    exitCode: 2,
  };
}

function credentialClosureReceipt(
  completed: CredentialClosureCompletedState,
): CredentialClosureCompletedReceipt {
  const policyFindings: ActivePolicyCredentialClosureFinding[] = [];
  let failedOrganisationCount = 0;
  for (const receipt of completed.activePolicies) {
    if (receipt.closure.status === "failed") {
      failedOrganisationCount += 1;
      policyFindings.push(...receipt.closure.findings);
    }
  }

  return {
    schema: RECEIPT_SCHEMA,
    status: completed.status,
    mode: completed.mode,
    workerOrigin: completed.workerOrigin,
    cohort: completed.cohort,
    d1: {
      status: completed.d1.status,
      summary: completed.d1.summary,
      findingKinds: countFindingKinds(completed.d1.findings),
    },
    activePolicies: {
      status: failedOrganisationCount === 0 ? "passed" : "failed",
      auditedOrganisationCount: completed.activePolicies.length,
      failedOrganisationCount,
      findingKinds: countFindingKinds(policyFindings),
    },
    retainedVaultRoots: {
      status: completed.retainedVaultRoots.status,
      auditedRowCount: completed.retainedVaultRoots.auditedRowCount,
      revokedRowCount: completed.retainedVaultRoots.revokedRowCount,
      versions: completed.retainedVaultRoots.versions,
      findingKinds: countFindingKinds(completed.retainedVaultRoots.findings),
    },
  };
}

function countFindingKinds(
  findings: readonly { readonly kind: string }[],
): readonly CredentialClosureFindingCount[] {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(compareFindingKinds)
    .map(buildFindingKindCount);
}

function compareFindingKinds(
  left: readonly [string, number],
  right: readonly [string, number],
): number {
  return left[0].localeCompare(right[0]);
}

function buildFindingKindCount(
  entry: readonly [string, number],
): CredentialClosureFindingCount {
  return { kind: entry[0], count: entry[1] };
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypoint)
  );
}

async function main(): Promise<void> {
  const outcome = await runCredentialClosureCommand(process.argv.slice(2));
  console.log(JSON.stringify(outcome.result, null, 2));
  process.exitCode = outcome.exitCode;
}

if (isMainModule()) await main();
