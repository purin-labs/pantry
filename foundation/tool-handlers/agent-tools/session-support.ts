import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { normalizeUntrustedCommerceText } from "@purin-labs/agent-tools/context/untrusted-commerce-text";
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { evaluateChatFlowLabelSink } from "@purin-labs/conversation/chat/information-flow";
import { isConversationId, isProjectId } from "@purin-labs/control-api";
import { validateLiveRequestAuthority } from "@purin-labs/authority/request-authority/index";
import {
  exitApprovalPassReady,
  passOrAskForExitApproval,
} from "../actors/harness-follow-up";
import type { HeldOutputReason } from "@purin-labs/authority/data/held-output-request";
import type { EffectAction } from "@purin-labs/agent-tools/effect-action";
import type {
  HarnessCapabilityName,
  StaffPageToolReceipt,
} from "@purin-labs/agent-tools/catalog/types";
import { StaffPageRequestError } from "@purin-labs/agent-tools/errors";
import type { UncheckedEffect } from "@purin-labs/agent-tools/tool-effect";
import {
  currentFlowSinkCheck,
  evaluateFlowLabelSink,
  emptyFlowLabel,
  FlowLabel as StoredFlowLabel,
  toolEffectAsksAfterOutsideText,
} from "@purin-labs/authority/policy/information-flow/index";
import { buildControlAuthority } from "@purin-labs/authority/request-authority/index";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseCaseId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "@purin-labs/agent/actors/session-execution-admission";
import { preflightHarnessTurnLease } from "@purin-labs/agent/actors/agent-session-harness-authority";
import { CODE_MODE_PILOT_BUDGET } from "@purin-labs/agent/actors/code-mode-budget";
import { admittedExecutionDeadline } from "@purin-labs/agent/actors/code-mode-admission";
import type { CatalogExecutionContext } from "@purin-labs/agent-tools/catalog/execute";
import {
  readControlMutationReplay,
  recordOrganisationCommerceMutationReceipt,
} from "@purin-labs/tenancy/data/control-mutation";
import type { CapabilityDefinition } from "@purin-labs/authority/authorization/access-grants/capability-key";
import {
  readSessionInformationFlow,
  readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding,
} from "@purin-labs/agent/actors/agent-session-information-flow";
import {
  labelAllowsAudiences,
  type FlowLabel,
} from "@purin-labs/authority/policy/index";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import {
  listOrganisationMembers,
  readActiveOrganisationMembershipRevision,
  resolveUser,
  type OrganisationMember,
} from "@purin-labs/tenancy/data/control-plane";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { heldEffectCoversRequest } from "@purin-labs/authority/data/held-output-request";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

export async function collaborationMember(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
  access: "read" | "edit",
): Promise<OrganisationMember> {
  const authority = lease.requestAuthority;
  if (
    (authority.kind !== "control" &&
      authority.kind !== "direct_conversation" &&
      authority.kind !== "shared_conversation") ||
    (access === "edit" && authority.role === "viewer")
  ) {
    throw new Error(
      "Shared workspace access requires a current organisation member with the requested access",
    );
  }
  const members = await listOrganisationMembers({ db, organisationId });
  for (const member of members) {
    if (
      member.personId === authority.requesterPersonId &&
      (authority.kind !== "control" || member.userId === authority.userId) &&
      member.role === authority.role
    ) {
      return member;
    }
  }
  throw new Error("Shared workspace membership changed");
}

export function collaborationEditDeadline(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  boundary: CatalogExecutionContext,
  startedAt: number,
): number {
  switch (boundary.kind) {
    case "direct":
      return Math.min(
        lease.expiresAt,
        startedAt + CODE_MODE_PILOT_BUDGET.maxDurationMs,
      );
    case "code_mode":
      // An edit of a script ends with the script. The turn lease is older than
      // a script that starts late in the turn, so it cannot give this deadline.
      return admittedExecutionDeadline(storage.sql, boundary.executionLease);
    default:
      return assertNever(boundary);
  }
}

/** The person's membership now, as the Devices page reads it. */
export async function liveDeviceMember(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
): Promise<OrganisationMember | null> {
  const authority = lease.requestAuthority;
  if (
    authority.kind !== "control" &&
    authority.kind !== "direct_conversation" &&
    authority.kind !== "shared_conversation"
  ) {
    return null;
  }
  const members = await listOrganisationMembers({ db, organisationId });
  return (
    members.find(
      (member) =>
        member.personId === authority.requesterPersonId &&
        (authority.kind !== "control" || member.userId === authority.userId),
    ) ?? null
  );
}

export function untrustedDeviceText(value: string): string {
  return normalizeUntrustedCommerceText(value, "display_name").text;
}

/** One step of a staff page: its sink, its receipt scope and its command. */
/** The person whose page a staff page tool acts for. */
type StaffPageMember = Readonly<{ member: OrganisationMember }>;

type StaffPageEffect = Readonly<{
  flowLabel: StoredFlowLabel;
  sink: import("@purin-labs/authority/policy/information-flow/index").ToolEffectSink;
  route: string;
  operation: string;
  body: unknown;
  operationId: string;
  result: string;
  /**
   * The check of content that the page's readers will see, if it has one.
   * The effect's own check asks the writer question, with the action.
   */
  exit?: (mode: "pass_or_ask", writerRule: "asked") => Promise<void>;
  run: (key: string) => Promise<string | null>;
  /** What must see the step at once, after its receipt. */
  settled: () => Promise<void>;
}>;

/**
 * Runs one step that staff also take on the page, with the page's receipt: the
 * same route and operation, a key from this tool call. A repeated call gets the
 * first receipt and runs nothing. A step that the receipt missed meets the
 * queue's stage, which refuses a step that already happened. A refusal runs no
 * command and stores no receipt, so the agent can read and try again.
 */
async function settleStaffPageEffect(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  work: StaffPageMember,
  effect: StaffPageEffect,
): Promise<StaffPageToolReceipt> {
  const decision = await evaluateHarnessFlowSink(
    execution.scope.database,
    execution.scope.accountAccess,
    acceptedExecutionAuthority(lease.session.sessionId, lease.turn.turnId),
    { flowLabel: effect.flowLabel, sink: effect.sink },
  );
  const exit = {
    decision,
    flowLabel: effect.flowLabel,
    sink: effect.sink,
    action: {
      operation: effect.operation,
      arguments: { route: effect.route, body: effect.body },
    },
  };
  // The effect has two checks: this one and the content check below. Neither
  // uses a pass until this one has its approval, so a pass that one check
  // used is not lost when the other one asks.
  let passed = false;
  if (!(await toolEffectPassesExit(env, execution, lease, exit, "check"))) {
    if (!(await toolEffectPassesExit(env, execution, lease, exit)))
      throw new Error(`Staff page effect is not authorized: ${decision.kind}`);
    passed = true;
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: work.member.userId,
  });
  if (identity === null) {
    throw new Error("Staff page member has no user");
  }
  const digest = await digestCanonical({
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    operationId: effect.operationId,
    operation: effect.operation,
    route: effect.route,
  });
  const receiptId = `agent_${digest.replace(/[^0-9a-f]/gu, "").slice(-40)}`;
  const scope = {
    userId: identity.userId,
    organisationScope: execution.scope.organisationId,
    route: effect.route,
    operation: effect.operation,
  };
  const boundary = {
    kind: "unversioned" as const,
    idempotencyKey: receiptId,
    requestHash: await digestCanonical(effect.body),
  };
  const replay = await readControlMutationReplay({
    db: execution.scope.database,
    scope,
    boundary,
  });
  await requireSessionExecution(execution, lease);
  if (replay.kind === "replay") {
    return { receiptId, result: effect.result };
  }
  if (replay.kind === "conflict") {
    throw new Error("Staff page receipt conflict");
  }
  await effect.exit?.("pass_or_ask", "asked");
  if (!passed && !(await toolEffectPassesExit(env, execution, lease, exit)))
    throw new Error(`Staff page effect is not authorized: ${decision.kind}`);
  const refusal = await effect.run(receiptId);
  if (refusal !== null) {
    throw new StaffPageRequestError(refusal);
  }
  const receipt = await recordOrganisationCommerceMutationReceipt({
    executionScope: execution.scope,
    identity,
    scope,
    boundary,
    causationId: String(lease.turn.turnId),
    responseBody: { ok: true, operation: effect.operation },
    now: Date.now(),
  });
  if (!receipt.ok) {
    throw new Error(`Staff page receipt: ${receipt.error.code}`);
  }
  await effect.settled();
  return { receiptId, result: effect.result };
}

/** The Slack thread that an owner or admin connected to a shared draft. */
export type DraftThreadLink = Readonly<{
  caseId: CaseId;
  integrationAccountId: IntegrationAccountId;
  conversationId: string;
}>;

/** An agent edit of a draft that every organisation role reads. */
type SharedDraftEdit = Readonly<{
  /** The draft's name in a refusal, such as "Email draft". */
  draft: string;
  caseId: string;
  capabilityId:
    | typeof CAPABILITY_KEYS.commerceProductDescriptionDraftEdit
    | typeof CAPABILITY_KEYS.marketingEmailDraftEdit
    | typeof CAPABILITY_KEYS.commerceProductionPlanEdit
    | typeof CAPABILITY_KEYS.commerceMenuDraftEdit
    | typeof CAPABILITY_KEYS.commerceWorkflowCanvasMove
    | typeof CAPABILITY_KEYS.commerceRecipeSave
    | typeof CAPABILITY_KEYS.commerceSupplyCostSave
    | typeof CAPABILITY_KEYS.commerceSupplierCreate;
  integrationAccountId: string;
  resourceScope: string;
  readSharedThread: () => Promise<DraftThreadLink | null>;
  /**
   * The shared Portal chat of a draft that a Portal chat may edit. Only the
   * production plan has one.
   */
  readSharedChat?: () => Promise<SharedDraftChat | null>;
  notConnected: string;
}>;

/**
 * The readers that an owner or admin added to the draft's audience when they
 * shared the Slack thread or Portal chat of this turn with it, or null when
 * they did not. A shared chat brings its Project and the person who shared it,
 * whose chat it was while it was private. A Portal chat matches by its Case.
 */
async function draftSharedReaders(
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
  edit: SharedDraftEdit,
): Promise<
  | readonly import("@purin-labs/authority/policy/information-flow/index").FlowAudience[]
  | null
> {
  const authority = lease.requestAuthority;
  if (authority.kind === "shared_conversation") {
    const sharing = await edit.readSharedThread();
    return sharing !== null &&
      sharing.caseId === edit.caseId &&
      sharing.integrationAccountId === authority.integrationAccountId &&
      sharing.conversationId === authority.conversationId
      ? [
          {
            kind: "conversation",
            integrationAccountId: sharing.integrationAccountId,
            conversationId: sharing.conversationId,
          },
        ]
      : null;
  }
  if (authority.kind !== "control" || edit.readSharedChat === undefined) {
    return null;
  }
  const chat = await edit.readSharedChat();
  return chat !== null &&
    chat.caseId === edit.caseId &&
    isConversationId(chat.conversationId) &&
    isProjectId(chat.projectId)
    ? [
        {
          kind: "chat_conversation",
          organisationId,
          conversationId: chat.conversationId,
        },
        { kind: "project", organisationId, projectId: chat.projectId },
        { kind: "person", personId: chat.approverPersonId },
      ]
    : null;
}

/** A Portal chat that an owner or admin shared with a draft. */
export type SharedDraftChat = Readonly<{
  caseId: string;
  conversationId: string;
  projectId: string;
  approverPersonId: string;
}>;

/**
 * The exit check of content that goes into a draft that every member reads.
 * Content that a member may not read raises the approval prompt.
 */
export async function passSharedDraftExit(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  member: OrganisationMember,
  edit: Pick<
    SharedDraftEdit,
    "draft" | "capabilityId" | "integrationAccountId" | "resourceScope"
  >,
  flowLabel: StoredFlowLabel,
  sharedWith: readonly import("@purin-labs/authority/policy/information-flow/index").FlowAudience[],
  /**
   * `check` asks nobody and takes no approval pass: a draft preview (Plan
   * 40B phase 7) shows only an edit that would pass the exit now.
   */
  mode: "pass_or_ask" | "check" = "pass_or_ask",
  /**
   * `asked`: this check is the second check of one effect, and the effect's
   * own check asks the writer question with its action (Plan 89).
   */
  writerRule: "ask" | "asked" = "ask",
  /** Sees the decision of a check that does not pass, for a trace. */
  refused?: (decision: FlowSinkDecision) => void,
): Promise<void> {
  const organisationId = execution.scope.organisationId;
  const revision = await readActiveOrganisationMembershipRevision({
    db: execution.scope.database,
    organisationId,
  });
  if (revision === null) {
    throw new Error(`${edit.draft} membership unavailable`);
  }
  const destination = buildControlAuthority({
    organisationId,
    requesterPersonId: member.personId,
    userId: member.userId,
    membershipRevision: revision,
    role: member.role,
  });
  const sink = {
    kind: "tool_effect" as const,
    destinationAuthority: destination.requestAuthority,
    capabilityId: edit.capabilityId,
    integrationAccountId: edit.integrationAccountId,
    resourceScope: edit.resourceScope,
    approvalSatisfied: false,
    readByEveryMember: { sharedWith },
  };
  const decision = await evaluateHarnessFlowSink(
    execution.scope.database,
    execution.scope.accountAccess,
    acceptedExecutionAuthority(lease.session.sessionId, lease.turn.turnId),
    { flowLabel, sink },
  );
  if (
    !(await toolEffectPassesExit(
      env,
      execution,
      lease,
      {
        decision,
        flowLabel,
        sink,
        // A board edit: one Allow covers the later edits of the same
        // request, while their content stays within what was allowed.
        repeatInRequest: heldEffectCoversRequest(edit.resourceScope),
        writerRule,
      },
      mode,
    ))
  ) {
    refused?.(decision);
    throw new Error(`${edit.draft} disclosure is not authorized`);
  }
}

export type EmailMailboxReadScope = Readonly<{
  capability: Variant<CapabilityDefinition, "provider_resource">;
  inputLabel: FlowLabel;
}>;

export function requireCurrentEmailToolLease(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
): CaseId {
  const authorized = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!authorized.ok) {
    throw new Error(`Email authority unavailable: ${authorized.error.code}`);
  }
  if (assignment.sessionId !== lease.session.sessionId) {
    throw new Error("Email session binding invalid");
  }
  const caseId = parseCaseId(assignment.caseId);
  if (!caseId.ok) {
    throw new Error("Email Case identity is invalid");
  }
  return caseId.value;
}

export function selectProviderResourceGrants(
  grants: readonly AccessGrant[],
  capability: Variant<CapabilityDefinition, "provider_resource">,
): readonly AccessGrant[] {
  const matches: AccessGrant[] = [];
  for (const grant of grants) {
    if (
      grant.target.kind === "provider_resource" &&
      grant.target.capabilityId === capability.capabilityId &&
      grant.target.capabilityVersion === capability.capabilityVersion &&
      grant.target.integrationAccountId === capability.integrationAccountId &&
      grant.target.resourceScope === capability.resourceScope
    ) {
      matches.push(grant);
    }
  }
  return matches;
}

export function readAccessGrantId(grant: AccessGrant): string {
  return grant.grantId;
}

export async function requireLiveBakeryReadAuthority(
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
): Promise<void> {
  await requireSessionExecution(execution, lease);
  const live = await validateLiveRequestAuthority({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    authority: lease.requestAuthority,
  });
  if (!live.ok) {
    throw new Error("Saved bakery authority has changed");
  }
  await requireSessionExecution(execution, lease);
}

/**
 * Whether a tool effect may go on after its exit decision (Plan 27C). A level
 * block asks a person. A pass from an earlier approval lets this one effect
 * through, and the Organisation's capability rules still apply to it. A
 * first block raises `ExitApprovalRequestedError`, which the agent reads.
 */
async function toolEffectPassesExit(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  input: {
    decision: Awaited<ReturnType<typeof evaluateHarnessFlowSink>>;
    flowLabel: import("@purin-labs/authority/policy/information-flow/index").FlowLabel;
    sink: import("@purin-labs/authority/policy/information-flow/index").ToolEffectSink;
    repeatInRequest?: boolean;
    /**
     * The operation and its arguments. A Session that read outside-written
     * text shows them to the person, and the Allow covers them only (Plan
     * 89). Without them the Allow covers one step of this capability.
     */
    action?: EffectAction;
    /** `asked`: another check of the same effect asks the writer question. */
    writerRule?: "ask" | "asked";
  },
  mode: "pass_or_ask" | "check" = "pass_or_ask",
): Promise<boolean> {
  const { decision } = input;
  if (decision.kind === "allow") {
    return true;
  }
  if (
    (decision.kind !== "deny" && decision.kind !== "approval_required") ||
    (decision.reason.code !== "audience_not_permitted" &&
      decision.reason.code !== "outside_written")
  ) {
    return false;
  }
  const writerAsked = input.writerRule === "asked";
  // The writer rule is the last rule, so nothing else stops this check.
  if (writerAsked && decision.reason.code === "outside_written") return true;
  const rules = await evaluateHarnessFlowSink(
    execution.scope.database,
    execution.scope.accountAccess,
    acceptedExecutionAuthority(lease.session.sessionId, lease.turn.turnId),
    { flowLabel: await emptyFlowLabel(), sink: input.sink },
  );
  if (rules.kind !== "allow") {
    return false;
  }
  const reason: HeldOutputReason =
    decision.reason.code === "outside_written"
      ? "outside_written"
      : decision.reason.reasonCode === "aifc.outside_organisation" ||
          decision.reason.reasonCode === "aifc.other_recipient"
        ? "outside_organisation"
        : "private_source";
  // A pass for a reader block did not show the action. So an effect that the
  // writer rule also stops needs its own pass after that one.
  const reasons: readonly HeldOutputReason[] =
    reason !== "outside_written" &&
    !writerAsked &&
    toolEffectAsksAfterOutsideText(input.flowLabel, input.sink)
      ? [reason, "outside_written"]
      : [reason];
  const request = (each: HeldOutputReason) => ({
    execution,
    lease,
    effect: input.sink,
    flowLabel: input.flowLabel,
    repeatInRequest: input.repeatInRequest === true,
    reason: each,
    action: input.action ?? null,
  });
  // No pass is used until each one waits: a pass that this call used before
  // the other rule stopped it would be lost, and the person would be asked
  // for it again.
  const missing: HeldOutputReason[] = [];
  for (const each of reasons)
    if (reasons.length > 1 || mode === "check")
      if (!(await exitApprovalPassReady(request(each)))) missing.push(each);
  if (mode === "check") return missing.length === 0;
  const first = missing[0];
  if (first !== undefined)
    return passOrAskForExitApproval({ env, ...request(first) });
  for (const each of reasons)
    if (!(await passOrAskForExitApproval({ env, ...request(each) })))
      return false;
  return true;
}

async function evaluateHarnessFlowSink(
  db: OrganisationDatabase,
  accountAccess: import("@purin-labs/tenancy/organisation-access/access").OrganisationAccess,
  userAuthority: import("@purin-labs/tenancy/organisation-access/access").OrganisationUserAuthority,
  input: {
    flowLabel: import("@purin-labs/authority/policy/information-flow/index").FlowLabel;
    sink: import("@purin-labs/authority/policy/information-flow/index").ToolEffectSink;
  },
) {
  const authority = input.sink.destinationAuthority;
  if (authority.kind === "control") {
    return evaluateChatFlowLabelSink(
      db,
      accountAccess,
      input.flowLabel,
      authority,
      input.sink,
    );
  }
  const current = await validateLiveRequestAuthority({
    db,
    accountAccess,
    userAuthority,
    authority,
    action: "execute",
  });
  if (!current.ok) {
    return { kind: "unavailable" as const };
  }
  const check = await currentFlowSinkCheck({
    db,
    flowLabel: input.flowLabel,
    sink: input.sink,
  });
  if (!check.ok) {
    return { kind: "unavailable" as const };
  }
  return evaluateFlowLabelSink(check.value);
}

/**
 * The effect of a tool that stages content for a person, such as a reply
 * draft. The work label of the Session may flow into it. The effect still
 * waits for a person, so approval is not yet satisfied.
 */
export function proposalFlowEffect<Result>(
  lease: HarnessTurnLease,
  effect: Readonly<{
    capabilityId: HarnessCapabilityName;
    integrationAccountId: IntegrationAccountId;
    resourceScope: string;
  }>,
  run: () => Promise<Result>,
): ToolEffect<Result> {
  return {
    kind: "effect",
    label: {
      source: "work",
      unavailable: "Proposal information-flow context unavailable",
    },
    sink: {
      kind: "tool_effect",
      destinationAuthority: lease.requestAuthority,
      capabilityId: effect.capabilityId,
      integrationAccountId: effect.integrationAccountId,
      resourceScope: effect.resourceScope,
      approvalSatisfied: false,
    },
    refusal: (decision) =>
      `The proposal requires policy resolution: ${decision}`,
    run,
  };
}

/** The decision of an exit check, before a pass or an ask. */
export type FlowSinkDecision = Awaited<
  ReturnType<typeof evaluateHarnessFlowSink>
>;

/** The draft that a content check names: what `passSharedDraftExit` reads. */
type SharedDraftSink = Pick<
  SharedDraftEdit,
  "draft" | "capabilityId" | "integrationAccountId" | "resourceScope"
>;

/**
 * An effect that `prepare` of a tool returns, with the exit checks that the
 * tool has (Refactor 17, step A1.4). `settleToolEffect` reads the label, runs
 * the checks and calls `run`. A step that a tool does after its check and
 * before its effect is the first step of `run`.
 *
 * - `none`: no exit check, as before this step: the tool has other rules.
 * - `effect`: one check of the turn's authority as the sink.
 * - `shared_draft`: the content check of a draft that every member reads.
 * - `staff_page`: a step of a staff page, with its receipt and its checks.
 */
export type ToolEffect<Result = unknown> =
  | UncheckedEffect<Result>
  | Readonly<{
      kind: "effect";
      /**
       * The label that the check reads: the label of the turn, or the work
       * label of the Session. `unavailable` is the error with no label.
       */
      label: Readonly<{ source: "turn" | "work"; unavailable: string }>;
      sink: import("@purin-labs/authority/policy/information-flow/index").ToolEffectSink;
      /** The operation and its arguments, when the person's Allow shows them. */
      action?: EffectAction;
      /** The error of a check that does not pass, from the decision kind. */
      refusal: (decision: string) => string;
      run: () => Promise<Result>;
    }>
  | Readonly<{
      kind: "shared_draft";
      member: OrganisationMember;
      /** The error with no label of the turn. */
      unavailable: string;
      /**
       * `lookup`: when a role cannot read the label, the turn's conversation
       * must be shared with the draft, and its readers join the audience.
       */
      draft:
        | Readonly<{
            shared: "every_member";
            edit: SharedDraftSink;
            /** Sees the decision of a check that does not pass, for a trace. */
            refused?: (decision: FlowSinkDecision) => void;
          }>
        | Readonly<{
            shared: "lookup";
            edit: SharedDraftEdit;
            /** The error of a conversation that is not shared, if not a plain one. */
            notShared?: (message: string) => Error;
          }>;
      run: () => Promise<Result>;
    }>
  | Readonly<{
      kind: "staff_page";
      /** The person of the page. The area of the tool holds the rest of its work. */
      work: StaffPageMember;
      /** The error with no label of the turn. */
      unavailable: string;
      effect: Omit<StaffPageEffect, "flowLabel" | "exit">;
      /** The check of content that the page's readers will see, if any. */
      content?: Readonly<{ member: OrganisationMember; edit: SharedDraftSink }>;
    }>;

type EffectContext = Readonly<{
  env: Env;
  storage: DurableObjectStorage;
  execution: SessionExecutionAdmission;
  lease: HarnessTurnLease;
}>;

async function turnFlowLabel(
  context: EffectContext,
  unavailable: string,
): Promise<StoredFlowLabel> {
  const { storage, execution, lease } = context;
  const current = await readPersistedSessionTurnFlowBinding(storage.sql, {
    organisationId: execution.scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
  });
  if (
    !current.ok ||
    current.value === null ||
    current.value.authorityPartitionDigest !== lease.authorityPartitionDigest
  ) {
    throw new Error(unavailable);
  }
  return current.value.binding.flowLabel;
}

async function sessionWorkLabel(
  context: EffectContext,
  unavailable: string,
): Promise<StoredFlowLabel> {
  const { storage, execution, lease } = context;
  const flow = await readSessionInformationFlow(storage.sql, {
    organisationId: execution.scope.organisationId,
    sessionId: lease.session.sessionId,
  });
  if (
    !flow.ok ||
    flow.value === null ||
    flow.value.context.authorityPartitionDigest !==
      lease.authorityPartitionDigest
  ) {
    throw new Error(unavailable);
  }
  return flow.value.context.workLabel;
}

/**
 * The one place that runs the exit check of an effect tool. The executor
 * calls it with what `prepare` returned: it reads the label, runs each check
 * of the effect in the tool's order, and then runs the effect.
 */
export async function settleToolEffect(
  context: EffectContext,
  effect: ToolEffect,
): Promise<unknown> {
  const { env, execution, lease } = context;
  switch (effect.kind) {
    case "none":
      return effect.run();
    case "effect": {
      const flowLabel =
        effect.label.source === "turn"
          ? await turnFlowLabel(context, effect.label.unavailable)
          : await sessionWorkLabel(context, effect.label.unavailable);
      const decision = await evaluateHarnessFlowSink(
        execution.scope.database,
        execution.scope.accountAccess,
        acceptedExecutionAuthority(lease.session.sessionId, lease.turn.turnId),
        { flowLabel, sink: effect.sink },
      );
      if (
        !(await toolEffectPassesExit(env, execution, lease, {
          decision,
          flowLabel,
          sink: effect.sink,
          ...(effect.action === undefined ? {} : { action: effect.action }),
        }))
      ) {
        throw new Error(effect.refusal(decision.kind));
      }
      return effect.run();
    }
    case "shared_draft": {
      const flowLabel = await turnFlowLabel(context, effect.unavailable);
      const { draft } = effect;
      let sharedWith: readonly import("@purin-labs/authority/policy/information-flow/index").FlowAudience[] =
        [];
      if (draft.shared === "lookup") {
        const everyRoleReads = (
          ["owner", "admin", "operator", "viewer"] as const
        ).every((role) =>
          labelAllowsAudiences(flowLabel, [
            { kind: "organisation_role", role },
          ]),
        );
        const readers = everyRoleReads
          ? []
          : await draftSharedReaders(
              execution.scope.organisationId,
              lease,
              draft.edit,
            );
        if (readers === null) {
          throw (
            draft.notShared?.(draft.edit.notConnected) ??
            new Error(draft.edit.notConnected)
          );
        }
        sharedWith = readers;
      }
      await passSharedDraftExit(
        env,
        execution,
        lease,
        effect.member,
        draft.edit,
        flowLabel,
        sharedWith,
        "pass_or_ask",
        "ask",
        draft.shared === "every_member" ? draft.refused : undefined,
      );
      return effect.run();
    }
    case "staff_page": {
      const flowLabel = await turnFlowLabel(context, effect.unavailable);
      const { content } = effect;
      return settleStaffPageEffect(env, execution, lease, effect.work, {
        ...effect.effect,
        flowLabel,
        ...(content === undefined
          ? {}
          : {
              exit: passSharedDraftExit.bind(
                null,
                env,
                execution,
                lease,
                content.member,
                content.edit,
                flowLabel,
                [],
              ),
            }),
      });
    }
    default:
      return assertNever(effect);
  }
}
