import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { HarnessToolHost } from "@purin-labs/agent/actors/embedded-harness";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import type { SessionId } from "@purin-labs/kernel/ids";
import { bindConversationTurnAccess } from "../src/chat/turn-access";
import type {
  OperatorExecutionOrigin,
  SessionTurnExecution,
} from "../src/chat/turn-access";
import type { MailDraftOrigin } from "../src/actors/email-case-processing";
import { processDirectCaseCommand } from "../src/actors/case-direct-processing";
import {
  SessionExecutionAdmission,
  admittedSessionToolHost,
} from "@purin-labs/agent/actors/session-execution-admission";

declare const scope: OrganisationExecutionScope;
declare const storage: DurableObjectStorage;
declare const sessionId: SessionId;
declare const host: HarnessToolHost;
declare const admission: SessionExecutionAdmission;
declare const lease: HarnessTurnLease;

// @ts-expect-error Admission requires the Actor activation and local export barrier boundary.
new SessionExecutionAdmission(scope, storage, sessionId);

// @ts-expect-error Placement alone cannot authorize Session tool execution.
admittedSessionToolHost(scope, lease, host);

// @ts-expect-error Tool execution must retain the specific admitted turn.
admittedSessionToolHost(admission, host);

// @ts-expect-error A turn authorization check requires its harness lease.
admission.isTurnActive();

// @ts-expect-error Structural construction cannot omit the private local authority.
const forged: SessionExecutionAdmission = { scope };
void forged;

// @ts-expect-error Spreading admission drops its private Actor-local authority.
const copied: SessionExecutionAdmission = { ...admission };
void copied;

declare const turnBinding: Parameters<typeof bindConversationTurnAccess>;
// @ts-expect-error A portal turn binding must retain its originating control session.
bindConversationTurnAccess(
  turnBinding[0],
  turnBinding[1],
  turnBinding[2],
  turnBinding[3],
  turnBinding[4],
);

// @ts-expect-error A control-session origin requires its exact identity.
const missingOriginIdentity: OperatorExecutionOrigin = {
  kind: "control_session",
};
void missingOriginIdentity;

// @ts-expect-error Slack authority cannot carry a global browser session.
const mixedOrigin: OperatorExecutionOrigin = {
  kind: "slack",
  controlSessionId: turnBinding[5],
};
void mixedOrigin;

declare const directCommand: Parameters<typeof processDirectCaseCommand>[1];
declare const controlAuthority: Extract<
  HarnessTurnLease["requestAuthority"],
  { kind: "control" }
>;
declare const workflowAuthority: Extract<
  HarnessTurnLease["requestAuthority"],
  { kind: "workflow" }
>;
const { operatorOrigin: discardedOrigin, ...commandWithoutOrigin } =
  directCommand;
void discardedOrigin;
// @ts-expect-error A spread cannot omit the origin of a control-authorized dispatch.
const unboundDispatch: typeof directCommand = {
  ...commandWithoutOrigin,
  requestAuthority: controlAuthority,
};
void unboundDispatch;
// @ts-expect-error Workflow dispatch cannot borrow a global browser session.
const mixedDispatch: typeof directCommand = {
  ...commandWithoutOrigin,
  requestAuthority: workflowAuthority,
  operatorOrigin: { kind: "control_session", controlSessionId: turnBinding[5] },
};
void mixedDispatch;

// @ts-expect-error A mail continuation requires the exact turn and its authority.
const missingMailAuthority: SessionTurnExecution = {
  sessionId,
  turnId: "turn_fixture",
};
void missingMailAuthority;
// @ts-expect-error A Session draft cannot omit its turn authority.
const missingDraftOrigin: MailDraftOrigin = { kind: "session_turn" };
void missingDraftOrigin;
declare const capturedMailOrigin: Extract<
  MailDraftOrigin,
  { kind: "session_turn" }
>;
// @ts-expect-error A spread cannot convert Session work into background mailbox work.
const mixedMailOrigin: MailDraftOrigin = {
  ...capturedMailOrigin,
  kind: "mailbox",
};
void mixedMailOrigin;

import type { HarnessExecutionAuthority } from "@purin-labs/agent/actors/session-execution-admission";
// @ts-expect-error Transient execution must retain its in-memory lifecycle authority.
const missingTransientLifecycle: HarnessExecutionAuthority = {
  kind: "transient",
  admission,
  lease,
};
void missingTransientLifecycle;
declare const transientAuthority: Extract<
  HarnessExecutionAuthority,
  { kind: "transient" }
>;
// @ts-expect-error Canonical execution cannot substitute transient lifecycle checks.
const mixedHarnessAuthority: HarnessExecutionAuthority = {
  ...transientAuthority,
  kind: "canonical",
};
void mixedHarnessAuthority;

const { scope: capturedDirectScope, ...directCommandWithoutScope } = directCommand;
void capturedDirectScope;
// @ts-expect-error Direct execution cannot omit its admitted regional scope.
const unscopedDirectCommand: typeof directCommand = { ...directCommandWithoutScope };
void unscopedDirectCommand;
