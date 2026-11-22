import { digestCanonical } from "./digest";
import { nativeChatAudienceMatchesAuthority } from "./native-audience";
import {
  audiencesForAdmission,
  labelAllowsRecipient,
  policyAllowsAudiences,
  policyLevel,
  type FlowLabel,
} from "./labels";
import type {
  ContextAdmissionDecision,
  ContextAdmissionSubject,
  FlowAudience,
  FlowRecipient,
} from "./types";

/**
 * Whether a turn may read a source through a tool that its grants allow (Plan
 * 27C). The exit is the check. A Slack or scheduled turn reads anything, and
 * an answer that may not leave waits for a person in the Case outbox. A Portal
 * chat, a mailbox and WhatsApp have no such wait for their own answer, so
 * they do not read private content that their readers may not see.
 */
export async function decideContextAdmission(
  input: Readonly<{
    readonly subject: ContextAdmissionSubject;
    readonly inputLabel: FlowLabel;
  }>,
): Promise<ContextAdmissionDecision> {
  const authority = input.subject.requestAuthority;
  const answerCanWait =
    authority.kind === "direct_conversation" ||
    authority.kind === "shared_conversation" ||
    authority.kind === "workflow";
  return admission(
    input,
    answerCanWait ||
      labelOpenToAudiences(input.inputLabel, subjectAudiences(input.subject)),
  );
}

/**
 * Whether a source enters a turn with no request from the agent: its context,
 * Memory and Project context. Private content stays out unless the turn's
 * readers may see it, or else every answer of the turn would ask for approval.
 * Content bound to one recipient stays with a turn that writes to that person.
 */
export async function decideAutomaticContextAdmission(
  input: Readonly<{
    subject: ContextAdmissionSubject;
    inputLabel: FlowLabel;
    recipient: FlowRecipient | null;
  }>,
): Promise<ContextAdmissionDecision> {
  return admission(
    input,
    labelOpenToAudiences(input.inputLabel, subjectAudiences(input.subject)) &&
      labelAllowsRecipient(input.inputLabel, input.recipient),
  );
}

function subjectAudiences(
  subject: ContextAdmissionSubject,
): readonly FlowAudience[] | null {
  if (subject.kind === "authority_derived")
    return audiencesForAdmission(subject.requestAuthority, subject.caseId);
  return nativeChatAudienceMatchesAuthority(
    subject.audience,
    subject.requestAuthority,
  )
    ? subject.audience.readers
    : null;
}

function labelOpenToAudiences(
  label: FlowLabel,
  audiences: readonly FlowAudience[] | null,
): boolean {
  if (audiences === null) return false;
  return label.policies.every(
    (policy) =>
      policy.owner.kind === "recipient_constraint" ||
      policyAllowsAudiences(policy, audiences) ||
      policyLevel(policy) !== "private",
  );
}

async function admission(
  input: Readonly<{
    subject: ContextAdmissionSubject;
    inputLabel: FlowLabel;
  }>,
  admitted: boolean,
): Promise<ContextAdmissionDecision> {
  const authorityDigest = await digestCanonical(input.subject.requestAuthority);
  return admitted
    ? {
        kind: "admit",
        inputLabelDigest: input.inputLabel.digest,
        authorityDigest,
      }
    : {
        kind: "deny",
        inputLabelDigest: input.inputLabel.digest,
        authorityDigest,
        reason: "audience_not_permitted",
      };
}
