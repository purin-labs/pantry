import {
  parseUserId,
  parseControlSessionId,
  parsePersonId,
  parseOrganisationId,
  type UserId,
  type ControlSessionId,
  type PersonId,
  type OrganisationId,
} from "./ids";
import type { Result } from "./result";
import type { NearEd25519PublicKey, SeamsIdentityId } from "./seams/nep413";
import type { CanonicalAction } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import {
  isNonNegativeInteger,
  isRecord,
  isSha256Hex,
  sha256Hex,
} from "@purin-labs/std";

declare const approvalProofDigestBrand: unique symbol;

export type ApprovalProofDigest = string & {
  readonly [approvalProofDigestBrand]: "ApprovalProofDigest";
};

export type ApprovalPolicyBinding = {
  readonly kind: "unversioned_default";
};

export type ApprovalActionBinding = {
  readonly stepUpId: string;
  readonly organisationId: OrganisationId;
  readonly actionNonce: string;
  readonly actionDigest: ApprovalProofDigest;
  readonly policy: ApprovalPolicyBinding;
  readonly issuedAt: number;
  readonly expiresAt: number;
};

export type ControlApprovalPrincipal = {
  readonly kind: "app_user";
  readonly userId: UserId;
  readonly personId: PersonId;
  readonly role: "owner" | "admin";
};

export type SeamsApprovalPrincipal = {
  readonly kind: "seams_identity";
  readonly seamsIdentityId: SeamsIdentityId;
  readonly personId: PersonId;
  readonly role: "approve";
};

export type ApprovalEvidence =
  | {
      readonly kind: "app_user";
      readonly principal: ControlApprovalPrincipal;
      readonly authentication:
        | {
            readonly kind: "google_oidc_step_up";
            readonly controlSessionId: ControlSessionId;
            readonly authenticatedAt: number;
            readonly challenge: ApprovalActionBinding;
          }
        | {
            readonly kind: "webauthn_step_up";
            readonly credentialId: string;
            readonly assertionDigest: ApprovalProofDigest;
            readonly authenticatedAt: number;
            readonly challenge: ApprovalActionBinding;
          }
        | {
            /**
             * A click on Approve in a Slack card by an owner or admin whose
             * Slack user has a verified link to their Pantry user. It proves
             * less than a step-up, so the ledger refuses it for an action that
             * moves money (`SLACK_APPROVABLE_ACTION_KINDS`).
             */
            readonly kind: "slack_verified_link";
            readonly integrationAccountId: string;
            readonly workspaceId: string;
            readonly slackUserId: string;
            readonly authenticatedAt: number;
            readonly challenge: ApprovalActionBinding;
          };
    }
  | {
      readonly kind: "seams_identity";
      readonly principal: SeamsApprovalPrincipal;
      readonly authentication: {
        readonly kind: "seams_nep413";
        readonly publicKey: NearEd25519PublicKey;
        readonly proofDigest: ApprovalProofDigest;
        readonly authenticatedAt: number;
        readonly challenge: ApprovalActionBinding;
      };
    };

export type MerchantActionRejectionEvidence = {
  readonly kind: "merchant_rejection";
  readonly principal: ControlApprovalPrincipal;
  readonly authentication:
    | {
        readonly kind: "control_session";
        readonly controlSessionId: ControlSessionId;
        readonly authenticatedAt: number;
      }
    | {
        /** A click on Decline in a Slack card, as `slack_verified_link` above. */
        readonly kind: "slack_verified_link";
        readonly integrationAccountId: string;
        readonly workspaceId: string;
        readonly slackUserId: string;
        readonly authenticatedAt: number;
      };
  readonly decision: {
    readonly kind: "rejected";
    readonly reason: "merchant_declined";
    readonly action: {
      readonly organisationId: OrganisationId;
      readonly actionNonce: string;
      readonly actionDigest: ApprovalProofDigest;
    };
  };
};

export type MerchantActionDecision =
  | {
      readonly kind: "approved";
      readonly decidedAt: number;
      readonly evidence: ApprovalEvidence;
    }
  | {
      readonly kind: "rejected";
      readonly decidedAt: number;
      readonly evidence: MerchantActionRejectionEvidence;
    };

type ApprovalEvidenceError = {
  readonly code: "approval_evidence_invalid";
};

export function parseApprovalProofDigest(
  raw: unknown,
): ApprovalProofDigest | null {
  return isSha256Hex(raw) ? (raw as ApprovalProofDigest) : null;
}

export async function digestApprovalAction(
  action: CanonicalAction,
): Promise<ApprovalProofDigest> {
  const digest = await sha256Hex(
    JSON.stringify({
      organisationId: action.organisationId,
      integrationAccountId: action.integrationAccountId,
      threadId: action.threadId,
      sessionId: action.sessionId,
      host: action.host,
      verb: action.verb,
      path: action.path,
      argsHash: action.argsHash,
      amount: action.amount,
      nonce: action.nonce.value,
      exp: action.exp,
      resourceKey: action.resourceKey,
    }),
  );
  const parsed = parseApprovalProofDigest(digest);
  if (parsed === null) {
    throw new Error("approval_action_digest_invariant");
  }
  return parsed;
}

export function approvalActionBindingMatches(
  binding: ApprovalActionBinding,
  action: CanonicalAction,
  digest: ApprovalProofDigest,
): boolean {
  return (
    binding.organisationId === action.organisationId &&
    binding.actionNonce === action.nonce.value &&
    binding.actionDigest === digest
  );
}

export function parseApprovalEvidence(
  raw: unknown,
): Result<ApprovalEvidence, ApprovalEvidenceError> {
  if (
    !isRecord(raw) ||
    !isRecord(raw.principal) ||
    raw.kind !== raw.principal.kind
  ) {
    return invalidApprovalEvidence();
  }
  switch (raw.kind) {
    case "app_user":
      return parseControlApprovalEvidence(raw);
    case "seams_identity":
      return parseSeamsApprovalEvidence(raw);
    default:
      return invalidApprovalEvidence();
  }
}

export function parseStoredApprovalEvidence(
  raw: unknown,
): Result<ApprovalEvidence, ApprovalEvidenceError> {
  if (typeof raw !== "string") {
    return invalidApprovalEvidence();
  }
  try {
    return parseApprovalEvidence(JSON.parse(raw));
  } catch {
    return invalidApprovalEvidence();
  }
}

export function serializeApprovalEvidence(evidence: ApprovalEvidence): string {
  const parsed = parseApprovalEvidence(evidence);
  if (!parsed.ok) {
    throw new Error("invalid_approval_evidence");
  }
  return JSON.stringify(parsed.value);
}

export function parseMerchantActionRejectionEvidence(
  raw: unknown,
): Result<MerchantActionRejectionEvidence, ApprovalEvidenceError> {
  if (!isRecord(raw) || raw.kind !== "merchant_rejection") {
    return invalidApprovalEvidence();
  }
  const principal = parseControlPrincipal(raw.principal);
  const authentication = parseMerchantRejectionAuthentication(
    raw.authentication,
  );
  const decision = parseMerchantRejectionDecision(raw.decision);
  if (principal === null || authentication === null || decision === null) {
    return invalidApprovalEvidence();
  }
  return {
    ok: true,
    value: { kind: "merchant_rejection", principal, authentication, decision },
  };
}

export function parseStoredMerchantActionRejectionEvidence(
  raw: unknown,
): Result<MerchantActionRejectionEvidence, ApprovalEvidenceError> {
  if (typeof raw !== "string") return invalidApprovalEvidence();
  try {
    return parseMerchantActionRejectionEvidence(JSON.parse(raw));
  } catch {
    return invalidApprovalEvidence();
  }
}

export function serializeMerchantActionRejectionEvidence(
  evidence: MerchantActionRejectionEvidence,
): string {
  const parsed = parseMerchantActionRejectionEvidence(evidence);
  if (!parsed.ok) throw new Error("invalid_merchant_action_rejection_evidence");
  return JSON.stringify(parsed.value);
}

export function parseMerchantActionDecision(
  raw: unknown,
): Result<MerchantActionDecision, ApprovalEvidenceError> {
  if (
    !isRecord(raw) ||
    !Number.isSafeInteger(raw.decidedAt) ||
    Number(raw.decidedAt) < 0
  ) {
    return invalidApprovalEvidence();
  }
  if (raw.kind === "approved") {
    const evidence = parseApprovalEvidence(raw.evidence);
    return evidence.ok
      ? {
          ok: true,
          value: {
            kind: "approved",
            decidedAt: Number(raw.decidedAt),
            evidence: evidence.value,
          },
        }
      : invalidApprovalEvidence();
  }
  if (raw.kind === "rejected") {
    const evidence = parseMerchantActionRejectionEvidence(raw.evidence);
    return evidence.ok
      ? {
          ok: true,
          value: {
            kind: "rejected",
            decidedAt: Number(raw.decidedAt),
            evidence: evidence.value,
          },
        }
      : invalidApprovalEvidence();
  }
  return invalidApprovalEvidence();
}

function parseControlApprovalEvidence(
  raw: Record<string, unknown>,
): Result<ApprovalEvidence, ApprovalEvidenceError> {
  const principal = parseControlPrincipal(raw.principal);
  const authentication = parseControlAuthentication(raw.authentication);
  if (principal === null || authentication === null) {
    return invalidApprovalEvidence();
  }
  return {
    ok: true,
    value: { kind: "app_user", principal, authentication },
  };
}

function parseSeamsApprovalEvidence(
  raw: Record<string, unknown>,
): Result<ApprovalEvidence, ApprovalEvidenceError> {
  const principal = parseSeamsPrincipal(raw.principal);
  const authentication = parseSeamsAuthentication(raw.authentication);
  if (principal === null || authentication === null) {
    return invalidApprovalEvidence();
  }
  return {
    ok: true,
    value: { kind: "seams_identity", principal, authentication },
  };
}

function parseControlPrincipal(raw: unknown): ControlApprovalPrincipal | null {
  if (
    !isRecord(raw) ||
    raw.kind !== "app_user" ||
    (raw.role !== "owner" && raw.role !== "admin") ||
    typeof raw.userId !== "string" ||
    typeof raw.personId !== "string"
  ) {
    return null;
  }
  const userId = parseUserId(raw.userId);
  const personId = parsePersonId(raw.personId);
  return userId.ok && personId.ok
    ? {
        kind: "app_user",
        userId: userId.value,
        personId: personId.value,
        role: raw.role,
      }
    : null;
}

function parseSeamsPrincipal(raw: unknown): SeamsApprovalPrincipal | null {
  if (
    !isRecord(raw) ||
    raw.kind !== "seams_identity" ||
    raw.role !== "approve" ||
    typeof raw.seamsIdentityId !== "string" ||
    raw.seamsIdentityId.length === 0 ||
    raw.seamsIdentityId.length > 256 ||
    typeof raw.personId !== "string"
  ) {
    return null;
  }
  const personId = parsePersonId(raw.personId);
  const seamsIdentityId = parseSeamsIdentityId(raw.seamsIdentityId);
  return personId.ok && seamsIdentityId !== null
    ? {
        kind: "seams_identity",
        seamsIdentityId,
        personId: personId.value,
        role: "approve",
      }
    : null;
}

function parseControlAuthentication(
  raw: unknown,
): Variant<ApprovalEvidence, "app_user">["authentication"] | null {
  if (!isRecord(raw) || !isNonNegativeInteger(raw.authenticatedAt)) {
    return null;
  }
  switch (raw.kind) {
    case "google_oidc_step_up": {
      if (typeof raw.controlSessionId !== "string") return null;
      const controlSessionId = parseControlSessionId(raw.controlSessionId);
      const challenge = parseApprovalActionBinding(raw.challenge);
      return controlSessionId.ok && challenge !== null
        ? {
            kind: raw.kind,
            controlSessionId: controlSessionId.value,
            authenticatedAt: raw.authenticatedAt,
            challenge,
          }
        : null;
    }
    case "webauthn_step_up": {
      const assertionDigest = parseApprovalProofDigest(raw.assertionDigest);
      const challenge = parseApprovalActionBinding(raw.challenge);
      return typeof raw.credentialId === "string" &&
        raw.credentialId.length > 0 &&
        assertionDigest !== null &&
        challenge !== null
        ? {
            kind: raw.kind,
            credentialId: raw.credentialId,
            assertionDigest,
            authenticatedAt: raw.authenticatedAt,
            challenge,
          }
        : null;
    }
    case "slack_verified_link": {
      const challenge = parseApprovalActionBinding(raw.challenge);
      return isBoundedString(raw.integrationAccountId) &&
        isBoundedString(raw.workspaceId) &&
        isBoundedString(raw.slackUserId) &&
        challenge !== null
        ? {
            kind: raw.kind,
            integrationAccountId: raw.integrationAccountId,
            workspaceId: raw.workspaceId,
            slackUserId: raw.slackUserId,
            authenticatedAt: raw.authenticatedAt,
            challenge,
          }
        : null;
    }
    default:
      return null;
  }
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function parseMerchantRejectionAuthentication(
  raw: unknown,
): MerchantActionRejectionEvidence["authentication"] | null {
  if (
    isRecord(raw) &&
    raw.kind === "slack_verified_link" &&
    typeof raw.integrationAccountId === "string" &&
    typeof raw.workspaceId === "string" &&
    typeof raw.slackUserId === "string" &&
    isNonNegativeInteger(raw.authenticatedAt)
  )
    return {
      kind: "slack_verified_link",
      integrationAccountId: raw.integrationAccountId,
      workspaceId: raw.workspaceId,
      slackUserId: raw.slackUserId,
      authenticatedAt: raw.authenticatedAt,
    };
  if (
    !isRecord(raw) ||
    raw.kind !== "control_session" ||
    typeof raw.controlSessionId !== "string" ||
    !isNonNegativeInteger(raw.authenticatedAt)
  ) {
    return null;
  }
  const controlSessionId = parseControlSessionId(raw.controlSessionId);
  return controlSessionId.ok
    ? {
        kind: "control_session",
        controlSessionId: controlSessionId.value,
        authenticatedAt: raw.authenticatedAt,
      }
    : null;
}

function parseMerchantRejectionDecision(
  raw: unknown,
): MerchantActionRejectionEvidence["decision"] | null {
  if (
    !isRecord(raw) ||
    raw.kind !== "rejected" ||
    raw.reason !== "merchant_declined" ||
    !isRecord(raw.action) ||
    typeof raw.action.organisationId !== "string" ||
    typeof raw.action.actionNonce !== "string" ||
    raw.action.actionNonce.length === 0 ||
    raw.action.actionNonce.length > 128
  ) {
    return null;
  }
  const organisationId = parseOrganisationId(raw.action.organisationId);
  const actionDigest = parseApprovalProofDigest(raw.action.actionDigest);
  return organisationId.ok && actionDigest !== null
    ? {
        kind: "rejected",
        reason: "merchant_declined",
        action: {
          organisationId: organisationId.value,
          actionNonce: raw.action.actionNonce,
          actionDigest,
        },
      }
    : null;
}

function parseSeamsAuthentication(
  raw: unknown,
): Variant<ApprovalEvidence, "seams_identity">["authentication"] | null {
  if (
    !isRecord(raw) ||
    raw.kind !== "seams_nep413" ||
    typeof raw.publicKey !== "string" ||
    !raw.publicKey.startsWith("ed25519:") ||
    !isNonNegativeInteger(raw.authenticatedAt)
  ) {
    return null;
  }
  const proofDigest = parseApprovalProofDigest(raw.proofDigest);
  const publicKey = parseSeamsPublicKey(raw.publicKey);
  const challenge = parseApprovalActionBinding(raw.challenge);
  return proofDigest === null || publicKey === null || challenge === null
    ? null
    : {
        kind: raw.kind,
        publicKey,
        proofDigest,
        authenticatedAt: raw.authenticatedAt,
        challenge,
      };
}

function parseApprovalActionBinding(
  raw: unknown,
): ApprovalActionBinding | null {
  if (
    !isRecord(raw) ||
    typeof raw.stepUpId !== "string" ||
    raw.stepUpId.length === 0 ||
    raw.stepUpId.length > 128 ||
    typeof raw.organisationId !== "string" ||
    typeof raw.actionNonce !== "string" ||
    raw.actionNonce.length === 0 ||
    raw.actionNonce.length > 128 ||
    !isNonNegativeInteger(raw.issuedAt) ||
    !isNonNegativeInteger(raw.expiresAt) ||
    raw.expiresAt <= raw.issuedAt ||
    !isRecord(raw.policy) ||
    raw.policy.kind !== "unversioned_default"
  ) {
    return null;
  }
  const organisationId = parseOrganisationId(raw.organisationId);
  const actionDigest = parseApprovalProofDigest(raw.actionDigest);
  return organisationId.ok && actionDigest !== null
    ? {
        stepUpId: raw.stepUpId,
        organisationId: organisationId.value,
        actionNonce: raw.actionNonce,
        actionDigest,
        policy: { kind: "unversioned_default" },
        issuedAt: raw.issuedAt,
        expiresAt: raw.expiresAt,
      }
    : null;
}

function parseSeamsIdentityId(raw: string): SeamsIdentityId | null {
  return raw.startsWith("seams:") && raw.length > "seams:".length
    ? (raw as SeamsIdentityId)
    : null;
}

function parseSeamsPublicKey(raw: string): NearEd25519PublicKey | null {
  return raw.startsWith("ed25519:") && raw.length > "ed25519:".length
    ? (raw as NearEd25519PublicKey)
    : null;
}

function invalidApprovalEvidence(): Result<never, ApprovalEvidenceError> {
  return { ok: false, error: { code: "approval_evidence_invalid" } };
}
