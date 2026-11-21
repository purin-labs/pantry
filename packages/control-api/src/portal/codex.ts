import type { CodexAllowance } from "../index.ts";
import type {
  ChatGptSignIn,
  OrganisationCodexConnection,
  OrganisationInferenceSelection,
} from "./settings.ts";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord, positiveIntegerOrNull } from "@purin-labs/std";
import { parseInferenceSelection } from "./inference.ts";

export function parseOrganisationInferenceSelectionResponse(
  raw: unknown,
): OrganisationInferenceSelection {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.selection)) {
    throw new Error("The server returned an invalid inference selection.");
  }
  const selection = parseInferenceSelection(raw.selection.kind);
  if (selection === null)
    throw new Error("The server returned an unknown inference selection.");
  return selection;
}

export function parseOrganisationCodexConnectionResponse(
  raw: unknown,
): OrganisationCodexConnection {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.connection)) {
    throw new Error("The server returned an invalid Codex connection.");
  }
  const connection = raw.connection;
  if (connection.kind === "disconnected" && connection.revision === 0) {
    return { kind: "disconnected", revision: 0 };
  }
  const revision = positiveIntegerOrNull(connection.revision);
  if (revision === null)
    throw new Error(
      "The server returned an invalid Codex connection revision.",
    );
  if (connection.kind === "authorizing") {
    const attempt = parseCodexAuthorizationAttempt(connection.attempt);
    if (attempt === null)
      throw new Error("The server returned an invalid Codex authorization.");
    return { kind: "authorizing", revision, attempt };
  }
  if (connection.kind === "connected") {
    const shared = parseConnectedCodexFields(connection);
    const signIn = parseChatGptSignIn(connection.signIn);
    if (
      shared === null ||
      signIn === null ||
      !isFiniteNumber(connection.connectedAt) ||
      !isFiniteNumber(connection.verifiedAt)
    ) {
      throw new Error(
        "The server returned an invalid connected Codex account.",
      );
    }
    return {
      kind: "connected",
      revision,
      signIn,
      planType: shared.planType,
      allowance: shared.allowance,
      connectedAt: connection.connectedAt,
      verifiedAt: connection.verifiedAt,
    };
  }
  if (connection.kind === "action_required") {
    const shared = parseConnectedCodexFields(connection);
    const reason = parseCodexActionRequiredReason(connection.reason);
    const signIn = parseChatGptSignIn(connection.signIn);
    if (
      shared === null ||
      reason === null ||
      signIn === null ||
      !isFiniteNumber(connection.observedAt)
    ) {
      throw new Error("The server returned an invalid Codex repair state.");
    }
    return {
      kind: "action_required",
      revision,
      signIn,
      planType: shared.planType,
      allowance: shared.allowance,
      reason,
      observedAt: connection.observedAt,
    };
  }
  throw new Error("The server returned an unknown Codex connection state.");
}

function parseCodexAuthorizationAttempt(
  raw: unknown,
): Variant<OrganisationCodexConnection, "authorizing">["attempt"] | null {
  if (
    !isRecord(raw) ||
    typeof raw.attemptId !== "string" ||
    raw.attemptId.length === 0 ||
    (raw.method !== "device_code" && raw.method !== "pasted_callback") ||
    typeof raw.verificationUrl !== "string" ||
    (raw.userCode !== null && typeof raw.userCode !== "string") ||
    !isFiniteNumber(raw.expiresAt)
  )
    return null;
  try {
    const verificationUrl = new URL(raw.verificationUrl);
    if (
      verificationUrl.protocol !== "https:" ||
      (verificationUrl.hostname !== "openai.com" &&
        !verificationUrl.hostname.endsWith(".openai.com"))
    )
      return null;
  } catch {
    return null;
  }
  return {
    attemptId: raw.attemptId,
    method: raw.method,
    verificationUrl: raw.verificationUrl,
    userCode: raw.userCode,
    expiresAt: raw.expiresAt,
  };
}

function parseChatGptSignIn(raw: unknown): ChatGptSignIn | null {
  return raw === "codex_device" || raw === "chatgpt_agent" ? raw : null;
}

function parseConnectedCodexFields(
  raw: Record<string, unknown>,
): { readonly planType: string; readonly allowance: CodexAllowance } | null {
  if (typeof raw.planType !== "string" || raw.planType.length === 0)
    return null;
  const allowance = parseCodexAllowance(raw.allowance);
  return allowance === null ? null : { planType: raw.planType, allowance };
}

function parseCodexAllowance(raw: unknown): CodexAllowance | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "unavailable") return { kind: "unavailable" };
  if (raw.kind === "not_reported") return { kind: "not_reported" };
  if (
    raw.kind !== "available" ||
    !isFiniteNumber(raw.usedPercent) ||
    !isNullableFiniteNumber(raw.resetsAt) ||
    !isNullableFiniteNumber(raw.secondaryUsedPercent) ||
    !isNullableFiniteNumber(raw.secondaryResetsAt)
  )
    return null;
  if (
    raw.credits !== "available" &&
    raw.credits !== "exhausted" &&
    raw.credits !== "unknown"
  )
    return null;
  return {
    kind: "available",
    usedPercent: raw.usedPercent,
    resetsAt: raw.resetsAt,
    secondaryUsedPercent: raw.secondaryUsedPercent,
    secondaryResetsAt: raw.secondaryResetsAt,
    credits: raw.credits,
  };
}

function parseCodexActionRequiredReason(
  raw: unknown,
): Variant<OrganisationCodexConnection, "action_required">["reason"] | null {
  return raw === "authorization_expired" ||
    raw === "workspace_access_revoked" ||
    raw === "device_authorization_unavailable" ||
    raw === "allowance_exhausted" ||
    raw === "account_unavailable"
    ? raw
    : null;
}

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw);
}

function isNullableFiniteNumber(raw: unknown): raw is number | null {
  return raw === null || isFiniteNumber(raw);
}
