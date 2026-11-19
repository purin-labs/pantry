import type { GlobalDatabase } from "../database-handles";
import { assertNever } from "@purin-labs/std";
import type { OrganisationPlacementBindings } from "../organisation-execution-scope";
import type { SessionId, OrganisationId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { resolveActorRecoveryAdmission } from "./actor-activation";
import type {
  EmbeddedHarnessModelRouteLease,
  HarnessNativeCodeMode,
  HarnessToolHost,
} from "./embedded-harness";
import { canAdmitSessionWork } from "./portal-chat-cleanup";
import { parseSessionId } from "../ids";
import type {
  HarnessTurnLease,
  WorkspaceRevisionReceipt,
} from "@purin-labs/contracts";
import {
  authorizeChatHarnessLease,
  authorizeSessionTurnExecution,
  sessionTurnExecution,
} from "../chat/turn-access";
import { preflightHarnessTurnLease } from "./agent-session-harness-authority";
import {
  verifyWorkspaceRevisionReceipt,
  type WorkspaceRevisionStoreError,
} from "../workspace-revision-store";
import type { Result } from "../result";

/** A receipt check whose statement also read the placement fence. */
export type FencedWorkspaceReceiptCheck = {
  readonly receipt: WorkspaceRevisionReceipt;
  readonly verified: Result<
    WorkspaceRevisionReceipt,
    WorkspaceRevisionStoreError
  >;
};

/** The earlier check's result when it decided this same receipt. */
export function reusableWorkspaceReceiptCheck(
  check: FencedWorkspaceReceiptCheck | null,
  receipt: WorkspaceRevisionReceipt,
): FencedWorkspaceReceiptCheck["verified"] | null {
  return check !== null &&
    JSON.stringify(check.receipt) === JSON.stringify(receipt)
    ? check.verified
    : null;
}

export class SessionExecutionAdmission {
  private constructor(
    readonly scope: OrganisationExecutionScope,
    private readonly storage: DurableObjectStorage,
    private readonly sessionId: SessionId,
    private readonly globalDatabase: GlobalDatabase,
  ) {}

  static async resolve(
    env: OrganisationPlacementBindings,
    storage: DurableObjectStorage,
    organisationId: OrganisationId,
  ): Promise<SessionExecutionAdmission | null> {
    const recovered = await resolveActorRecoveryAdmission(env, storage.sql);
    if (
      recovered.kind !== "admitted" ||
      recovered.scope.organisationId !== organisationId
    )
      return null;
    const row = storage.sql
      .exec(
        "SELECT logical_object_id FROM state_object_activation WHERE singleton = 1 AND object_kind = 'session'",
      )
      .toArray()[0];
    if (row === undefined || typeof row.logical_object_id !== "string")
      return null;
    const sessionId = requireSessionIdentity(row.logical_object_id);
    const admission = new SessionExecutionAdmission(
      recovered.scope,
      storage,
      sessionId,
      env.DB,
    );
    return admission.isLocallyOpen() ? admission : null;
  }

  async isActive(): Promise<boolean> {
    if (!this.isLocallyOpen()) return false;
    const active = await this.scope.isActive();
    // Export can close local admission while the authoritative read is pending.
    return active && this.isLocallyOpen();
  }

  /**
   * Read the placement fence together with a workspace receipt. The receipt
   * statement matches the same active placement row as the fence statement,
   * so one round trip answers both. The check is null when the statement did
   * not decide the receipt. The caller then checks the receipt where it needs
   * it.
   */
  async isActiveWithWorkspaceReceipt(
    receipt: WorkspaceRevisionReceipt,
  ): Promise<{
    readonly active: boolean;
    readonly check: FencedWorkspaceReceiptCheck | null;
  }> {
    if (!this.isLocallyOpen()) return { active: false, check: null };
    const verified = await verifyWorkspaceRevisionReceipt(
      this.scope,
      this.scope.organisationId,
      receipt,
    );
    // Export can close local admission while the authoritative read is pending.
    if (!this.isLocallyOpen()) return { active: false, check: null };
    if (verified.ok) return { active: true, check: { receipt, verified } };
    switch (verified.error.code) {
      case "workspace_revision_receipt_missing":
      case "workspace_revision_receipt_conflict":
        // The statement matched the active placement row. The receipt is wrong.
        return { active: true, check: { receipt, verified } };
      case "organisation_placement_conflict":
        return { active: false, check: null };
      default:
        // The statement did not run. The fence is read by itself.
        return { active: await this.isActive(), check: null };
    }
  }

  /** Throw when the turn of the lease is no longer active. */
  async requireTurn(lease: HarnessTurnLease): Promise<void> {
    if (!(await this.isTurnActive(lease)))
      throw new Error("session_execution_authority_inactive");
  }

  async isTurnActive(lease: HarnessTurnLease): Promise<boolean> {
    if (
      lease.session.organisationId !== this.scope.organisationId ||
      lease.session.sessionId !== this.sessionId ||
      !preflightHarnessTurnLease(this.storage, lease, Date.now()).ok ||
      !this.isLocallyOpen()
    )
      return false;
    const [active, authorized] = await Promise.all([
      this.isActive(),
      authorizeChatHarnessLease(
        this.globalDatabase,
        this.scope.database,
        this.scope.organisationId,
        lease,
        this.scope.accountAccess,
      ),
    ]);
    return (
      active &&
      authorized &&
      (await this.isActive()) &&
      preflightHarnessTurnLease(this.storage, lease, Date.now()).ok
    );
  }

  async isRecoveryAuthorized(lease: HarnessTurnLease): Promise<boolean> {
    if (
      lease.session.organisationId !== this.scope.organisationId ||
      lease.session.sessionId !== this.sessionId ||
      !(await this.isActive())
    )
      return false;
    const authorized = await authorizeSessionTurnExecution(
      this.globalDatabase,
      this.scope.database,
      this.scope.organisationId,
      sessionTurnExecution(lease),
      this.scope.accountAccess,
    );
    return authorized && (await this.isActive());
  }

  async isTransientTurnActive(lease: HarnessTurnLease): Promise<boolean> {
    if (
      lease.session.organisationId !== this.scope.organisationId ||
      lease.session.sessionId !== this.sessionId ||
      Date.now() >= lease.expiresAt ||
      !(await this.isActive())
    )
      return false;
    const authorized = await authorizeSessionTurnExecution(
      this.globalDatabase,
      this.scope.database,
      this.scope.organisationId,
      sessionTurnExecution(lease),
      this.scope.accountAccess,
    );
    return (
      authorized && (await this.isActive()) && Date.now() < lease.expiresAt
    );
  }

  /**
   * Whether this Session still admits work locally. It reads no placement
   * fence. Use it alone only where a fence read precedes it and nothing has
   * been waited for since.
   */
  isLocallyOpen(): boolean {
    return canAdmitSessionWork(this.storage.sql, {
      requestingOrganisationId: this.scope.organisationId,
      sessionId: this.sessionId,
      placement: this.scope.placement,
    });
  }
}

function requireSessionIdentity(raw: string) {
  const parsed = parseSessionId(raw);
  if (!parsed.ok) throw new Error("activation_mismatch");
  return parsed.value;
}

export function requireSessionExecution(
  admission: SessionExecutionAdmission,
  lease: HarnessTurnLease,
): Promise<void> {
  return admission.requireTurn(lease);
}

export function admittedSessionOperation<Args extends unknown[], Value>(
  admission: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  operation: (...args: Args) => Promise<Value>,
): (...args: Args) => Promise<Value> {
  return admittedHarnessOperation(
    { kind: "canonical", admission, lease },
    operation,
  );
}

export function admittedSessionToolHost(
  authority: HarnessExecutionAuthority,
  host: HarnessToolHost,
): HarnessToolHost {
  return {
    mode: host.mode,
    catalogDigest: host.catalogDigest,
    definitions: host.definitions,
    codeMode: admittedSessionCodeMode(authority, host.codeMode),
    executeTool: admittedHarnessOperation(authority, host.executeTool),
  };
}

function admittedSessionCodeMode(
  authority: HarnessExecutionAuthority,
  codeMode: HarnessNativeCodeMode,
): HarnessNativeCodeMode {
  switch (codeMode.kind) {
    case "disabled":
      return { kind: "disabled" };
    case "enabled":
      return {
        kind: "enabled",
        sandbox: codeMode.sandbox,
        executeTool: admittedHarnessOperation(authority, codeMode.executeTool),
        claimedCapabilities: codeMode.claimedCapabilities,
        // The same Session admission fences a replayed result and a new call.
        authorizeSources: admittedHarnessOperation(
          authority,
          codeMode.authorizeSources,
        ),
        admission: {
          begin: admittedHarnessOperation(authority, codeMode.admission.begin),
          claim: admittedHarnessOperation(authority, codeMode.admission.claim),
          complete: codeMode.admission.complete,
          abandon: codeMode.admission.abandon,
          settle: codeMode.admission.settle,
        },
      };
    default:
      return assertNever(codeMode);
  }
}

export function admittedSessionModelRoute(
  authority: HarnessExecutionAuthority,
  route: EmbeddedHarnessModelRouteLease,
): EmbeddedHarnessModelRouteLease {
  switch (route.kind) {
    case "platform_api_key":
      return {
        kind: route.kind,
        resolveModelApiKey: releaseModelKeyUnderAdmission.bind(
          null,
          authority,
          route.resolveModelApiKey,
        ),
      };
    case "organisation_openai_api_key":
    case "organisation_claude_oauth":
    case "organisation_anthropic_api_key":
      return {
        kind: route.kind,
        providerFetch: route.providerFetch,
        resolveModelApiKey: releaseModelKeyUnderAdmission.bind(
          null,
          authority,
          route.resolveModelApiKey,
        ),
      };
    case "organisation_chatgpt_subscription":
      return {
        kind: route.kind,
        api: route.api,
        providerFetch: route.providerFetch,
        resolveModelApiKey: releaseModelKeyUnderAdmission.bind(
          null,
          authority,
          route.resolveModelApiKey,
        ),
        observeResponse: route.observeResponse,
      };
    default:
      return assertNever(route);
  }
}

export type HarnessExecutionAuthority =
  | Readonly<{
      kind: "canonical";
      admission: SessionExecutionAdmission;
      lease: HarnessTurnLease;
      isOpen?: never;
    }>
  | Readonly<{
      kind: "transient";
      admission: SessionExecutionAdmission;
      lease: HarnessTurnLease;
      isOpen: () => boolean;
    }>;

async function requireHarnessExecution(
  authority: HarnessExecutionAuthority,
): Promise<void> {
  switch (authority.kind) {
    case "canonical":
      return requireSessionExecution(authority.admission, authority.lease);
    case "transient":
      if (
        !authority.isOpen() ||
        !(await authority.admission.isTransientTurnActive(authority.lease)) ||
        !authority.isOpen()
      )
        throw new Error("session_execution_authority_inactive");
      return;
    default:
      return assertNever(authority);
  }
}

/**
 * Reading a model key has no effect. One admission check after the read covers
 * the release: the key leaves only when the turn was still admitted after it
 * was read.
 */
async function releaseModelKeyUnderAdmission(
  authority: HarnessExecutionAuthority,
  resolveModelApiKey: () => Promise<string>,
): Promise<string> {
  const key = await resolveModelApiKey();
  await requireHarnessExecution(authority);
  return key;
}

async function guardHarnessContinuation<Args extends unknown[], Value>(
  authority: HarnessExecutionAuthority,
  operation: (...args: Args) => Promise<Value>,
  ...args: Args
): Promise<Value> {
  await requireHarnessExecution(authority);
  const result = await operation(...args);
  await requireHarnessExecution(authority);
  return result;
}

function admittedHarnessOperation<Args extends unknown[], Value>(
  authority: HarnessExecutionAuthority,
  operation: (...args: Args) => Promise<Value>,
): (...args: Args) => Promise<Value> {
  return (guardHarnessContinuation<Args, Value>).bind(
    null,
    authority,
    operation,
  );
}
