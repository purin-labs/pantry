import { isNonNegativeInteger, isRecord, isString } from "@purin-labs/std";

type CredentialGenerationLifecycle =
  "staged" | "active" | "superseded" | "revoked" | "failed";

type CredentialVaultEntry =
  | {
      readonly status: "active" | "revoked";
      readonly keyVersion: string;
      readonly storedAt: number;
      readonly rotatedAt: number | null;
      readonly revokedAt: number | null;
    }
  | { readonly status: "missing" };

type CredentialGeneration = {
  readonly credentialGeneration: number;
  readonly lifecycle: CredentialGenerationLifecycle;
  readonly failureCode: string | null;
  readonly createdAt: number;
  readonly activatedAt: number | null;
  readonly supersededAt: number | null;
  readonly revokedAt: number | null;
  readonly vault: CredentialVaultEntry;
};

type CredentialWebhookLifecycle =
  "pending" | "live" | "degraded" | "disabled" | "revoked";

type CredentialWebhook = {
  readonly lifecycle: CredentialWebhookLifecycle;
  readonly eventType: string;
  readonly credentialGeneration: number;
  readonly lastVerifiedAt: number | null;
};

type CredentialRotationStatus =
  "pending_verification" | "verified" | "committed" | "failed";

type CredentialRotation = {
  readonly credentialRotationId: string;
  readonly status: CredentialRotationStatus;
  readonly expectedGeneration: number;
  readonly failureCode: string | null;
  readonly createdAt: number;
  readonly verifiedAt: number | null;
  readonly committedAt: number | null;
};

type CredentialRevocationState = "committed" | "policy_activated";

type CredentialRevocation = {
  readonly state: CredentialRevocationState;
  readonly startedAt: number;
  readonly committedAt: number;
  readonly policyActivatedAt: number | null;
  readonly restrictionLatencyMs: number | null;
};

type CredentialConnection = {
  readonly providerConnectionId: string;
  readonly lifecycle: string;
  readonly authMode: string;
  readonly activeGeneration: number;
  readonly grantedScopes: readonly string[];
};

export type CredentialAccountRecord = {
  readonly integrationAccountId: string;
  readonly provider: string;
  readonly environment: string;
  readonly displayName: string;
  readonly lifecycle: string;
  readonly isDefaultForProvider: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly connection: CredentialConnection;
  readonly generations: readonly CredentialGeneration[];
  readonly webhooks: readonly CredentialWebhook[];
  readonly rotations: readonly CredentialRotation[];
  readonly revocation: CredentialRevocation | null;
  /** When the current result of the provider health check was first seen. */
  readonly lastManifestObservationAt: number | null;
};

export type CredentialInventory = {
  readonly organisationId: string;
  readonly accounts: readonly CredentialAccountRecord[];
};

/** Receipt returned by POST …/accounts/:a/credential-rotations on success. */
export type CredentialRotationReceipt = {
  readonly credentialRotationId: string;
  readonly status: string;
  readonly previousGeneration: number;
  readonly activeGeneration: number;
  readonly policyActivation: "completed" | "reconciling";
};

export function parseCredentialInventoryResponse(
  raw: unknown,
): CredentialInventory {
  if (
    !isRecord(raw) ||
    raw.kind !== "success" ||
    raw.schema_version !== "pantry.credential-inventory.v1" ||
    !isRecord(raw.inventory) ||
    typeof raw.inventory.organisationId !== "string" ||
    !Array.isArray(raw.inventory.accounts)
  ) {
    throw new Error("Credential inventory response is invalid.");
  }
  return {
    organisationId: raw.inventory.organisationId,
    accounts: raw.inventory.accounts.map(parseCredentialAccountRecord),
  };
}

/**
 * Parses the rotation receipt out of a credential-rotation success response.
 * Returns null when the receipt is absent (for example an idempotent replay
 * that answered with a projection only) so callers can still report success.
 */
export function parseCredentialRotationReceiptResponse(
  raw: unknown,
): CredentialRotationReceipt | null {
  if (!isRecord(raw) || raw.kind !== "success") {
    throw new Error("Credential rotation response is invalid.");
  }
  const rotation = raw.rotation;
  if (
    !isRecord(rotation) ||
    typeof rotation.credential_rotation_id !== "string" ||
    typeof rotation.status !== "string" ||
    !isNonNegativeInteger(rotation.previous_generation) ||
    !isNonNegativeInteger(rotation.active_generation) ||
    (rotation.policy_activation !== "completed" &&
      rotation.policy_activation !== "reconciling")
  ) {
    return null;
  }
  return {
    credentialRotationId: rotation.credential_rotation_id,
    status: rotation.status,
    previousGeneration: rotation.previous_generation,
    activeGeneration: rotation.active_generation,
    policyActivation: rotation.policy_activation,
  };
}

function parseCredentialAccountRecord(raw: unknown): CredentialAccountRecord {
  if (
    !isRecord(raw) ||
    typeof raw.integrationAccountId !== "string" ||
    typeof raw.provider !== "string" ||
    typeof raw.environment !== "string" ||
    typeof raw.displayName !== "string" ||
    typeof raw.lifecycle !== "string" ||
    typeof raw.isDefaultForProvider !== "boolean" ||
    !epochMs(raw.createdAt) ||
    !epochMs(raw.updatedAt) ||
    !Array.isArray(raw.generations) ||
    !Array.isArray(raw.webhooks) ||
    !Array.isArray(raw.rotations)
  ) {
    throw new Error("Credential inventory account is invalid.");
  }
  return {
    integrationAccountId: raw.integrationAccountId,
    provider: raw.provider,
    environment: raw.environment,
    displayName: raw.displayName,
    lifecycle: raw.lifecycle,
    isDefaultForProvider: raw.isDefaultForProvider,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    connection: parseCredentialConnection(raw.connection),
    generations: raw.generations.map(parseCredentialGeneration),
    webhooks: raw.webhooks.map(parseCredentialWebhook),
    rotations: raw.rotations.map(parseCredentialRotation),
    revocation:
      raw.revocation === null || raw.revocation === undefined
        ? null
        : parseCredentialRevocation(raw.revocation),
    lastManifestObservationAt: optionalEpochMs(
      raw.lastManifestObservationAt,
      "manifest observation",
    ),
  };
}

function parseCredentialConnection(raw: unknown): CredentialConnection {
  if (
    !isRecord(raw) ||
    typeof raw.providerConnectionId !== "string" ||
    typeof raw.lifecycle !== "string" ||
    typeof raw.authMode !== "string" ||
    !isNonNegativeInteger(raw.activeGeneration) ||
    !Array.isArray(raw.grantedScopes) ||
    !raw.grantedScopes.every(isString)
  ) {
    throw new Error("Credential inventory connection is invalid.");
  }
  return {
    providerConnectionId: raw.providerConnectionId,
    lifecycle: raw.lifecycle,
    authMode: raw.authMode,
    activeGeneration: raw.activeGeneration,
    grantedScopes: raw.grantedScopes.filter(isString),
  };
}

function parseCredentialGeneration(raw: unknown): CredentialGeneration {
  if (
    !isRecord(raw) ||
    !isNonNegativeInteger(raw.credentialGeneration) ||
    !isCredentialGenerationLifecycle(raw.lifecycle) ||
    !(raw.failureCode === null || typeof raw.failureCode === "string") ||
    !epochMs(raw.createdAt)
  ) {
    throw new Error("Credential generation entry is invalid.");
  }
  return {
    credentialGeneration: raw.credentialGeneration,
    lifecycle: raw.lifecycle,
    failureCode: raw.failureCode,
    createdAt: raw.createdAt,
    activatedAt: optionalEpochMs(raw.activatedAt, "generation activation"),
    supersededAt: optionalEpochMs(raw.supersededAt, "generation supersession"),
    revokedAt: optionalEpochMs(raw.revokedAt, "generation revocation"),
    vault: parseCredentialVaultEntry(raw.vault),
  };
}

function parseCredentialVaultEntry(raw: unknown): CredentialVaultEntry {
  if (!isRecord(raw)) {
    throw new Error("Credential vault entry is invalid.");
  }
  if (raw.status === "missing") {
    return { status: "missing" };
  }
  if (
    (raw.status !== "active" && raw.status !== "revoked") ||
    typeof raw.keyVersion !== "string" ||
    !epochMs(raw.storedAt)
  ) {
    throw new Error("Credential vault entry is invalid.");
  }
  return {
    status: raw.status,
    keyVersion: raw.keyVersion,
    storedAt: raw.storedAt,
    rotatedAt: optionalEpochMs(raw.rotatedAt, "vault rotation"),
    revokedAt: optionalEpochMs(raw.revokedAt, "vault revocation"),
  };
}

function parseCredentialWebhook(raw: unknown): CredentialWebhook {
  if (
    !isRecord(raw) ||
    !isCredentialWebhookLifecycle(raw.lifecycle) ||
    typeof raw.eventType !== "string" ||
    !isNonNegativeInteger(raw.credentialGeneration)
  ) {
    throw new Error("Credential webhook entry is invalid.");
  }
  return {
    lifecycle: raw.lifecycle,
    eventType: raw.eventType,
    credentialGeneration: raw.credentialGeneration,
    lastVerifiedAt: optionalEpochMs(raw.lastVerifiedAt, "webhook verification"),
  };
}

function parseCredentialRotation(raw: unknown): CredentialRotation {
  if (
    !isRecord(raw) ||
    typeof raw.credentialRotationId !== "string" ||
    !isCredentialRotationStatus(raw.status) ||
    !isNonNegativeInteger(raw.expectedGeneration) ||
    !(raw.failureCode === null || typeof raw.failureCode === "string") ||
    !epochMs(raw.createdAt)
  ) {
    throw new Error("Credential rotation entry is invalid.");
  }
  return {
    credentialRotationId: raw.credentialRotationId,
    status: raw.status,
    expectedGeneration: raw.expectedGeneration,
    failureCode: raw.failureCode,
    createdAt: raw.createdAt,
    verifiedAt: optionalEpochMs(raw.verifiedAt, "rotation verification"),
    committedAt: optionalEpochMs(raw.committedAt, "rotation commit"),
  };
}

function parseCredentialRevocation(raw: unknown): CredentialRevocation {
  if (
    !isRecord(raw) ||
    !isCredentialRevocationState(raw.state) ||
    !epochMs(raw.startedAt) ||
    !epochMs(raw.committedAt)
  ) {
    throw new Error("Credential revocation entry is invalid.");
  }
  return {
    state: raw.state,
    startedAt: raw.startedAt,
    committedAt: raw.committedAt,
    policyActivatedAt: optionalEpochMs(
      raw.policyActivatedAt,
      "revocation policy activation",
    ),
    restrictionLatencyMs:
      raw.restrictionLatencyMs === null ||
      raw.restrictionLatencyMs === undefined
        ? null
        : isNonNegativeInteger(raw.restrictionLatencyMs)
          ? raw.restrictionLatencyMs
          : null,
  };
}

function isCredentialGenerationLifecycle(
  raw: unknown,
): raw is CredentialGenerationLifecycle {
  return (
    raw === "staged" ||
    raw === "active" ||
    raw === "superseded" ||
    raw === "revoked" ||
    raw === "failed"
  );
}

function isCredentialWebhookLifecycle(
  raw: unknown,
): raw is CredentialWebhookLifecycle {
  return (
    raw === "pending" ||
    raw === "live" ||
    raw === "degraded" ||
    raw === "disabled" ||
    raw === "revoked"
  );
}

function isCredentialRotationStatus(
  raw: unknown,
): raw is CredentialRotationStatus {
  return (
    raw === "pending_verification" ||
    raw === "verified" ||
    raw === "committed" ||
    raw === "failed"
  );
}

function isCredentialRevocationState(
  raw: unknown,
): raw is CredentialRevocationState {
  return raw === "committed" || raw === "policy_activated";
}

function optionalEpochMs(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined) return null;
  if (!epochMs(raw)) {
    throw new Error(`Credential inventory ${field} timestamp is invalid.`);
  }
  return raw;
}

function epochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
