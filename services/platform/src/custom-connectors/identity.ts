import type { Result } from "../result";
import { isSha256Hex } from "@purin-labs/std";

declare const customConnectorIdBrand: unique symbol;
declare const customConnectorRevisionBrand: unique symbol;
declare const customConnectorDefinitionDigestBrand: unique symbol;
declare const customConnectorAuthoringDigestBrand: unique symbol;
declare const customConnectorSetupAttemptIdBrand: unique symbol;

export type CustomConnectorId = string & {
  readonly [customConnectorIdBrand]: "CustomConnectorId";
};

export type CustomConnectorRevision = number & {
  readonly [customConnectorRevisionBrand]: "CustomConnectorRevision";
};

export type CustomConnectorDefinitionDigest = string & {
  readonly [customConnectorDefinitionDigestBrand]: "CustomConnectorDefinitionDigest";
};

export type CustomConnectorAuthoringDigest = string & {
  readonly [customConnectorAuthoringDigestBrand]: "CustomConnectorAuthoringDigest";
};

export type CustomConnectorSetupAttemptId = string & {
  readonly [customConnectorSetupAttemptIdBrand]: "CustomConnectorSetupAttemptId";
};

export type CustomConnectorRevisionIdentity = {
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
};

type CustomConnectorIdentityParseError = {
  readonly code: "invalid_custom_connector_identity";
  readonly field:
    | "connectorId"
    | "revision"
    | "definitionDigest"
    | "authoringDigest"
    | "setupAttemptId";
};

const CUSTOM_CONNECTOR_ID =
  /^custom_connector_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const CUSTOM_CONNECTOR_SETUP_ATTEMPT_ID =
  /^custom_connector_setup_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;

export function parseCustomConnectorId(
  raw: unknown,
): Result<CustomConnectorId, CustomConnectorIdentityParseError> {
  if (typeof raw !== "string" || !CUSTOM_CONNECTOR_ID.test(raw)) {
    return invalidIdentity("connectorId");
  }

  return { ok: true, value: raw as CustomConnectorId };
}

export function newCustomConnectorId(): CustomConnectorId {
  const parsed = parseCustomConnectorId(
    `custom_connector_${crypto.randomUUID()}`,
  );
  if (!parsed.ok) throw new Error("generated custom connector ID is invalid");
  return parsed.value;
}

export function parseCustomConnectorSetupAttemptId(
  raw: unknown,
): Result<CustomConnectorSetupAttemptId, CustomConnectorIdentityParseError> {
  if (typeof raw !== "string" || !CUSTOM_CONNECTOR_SETUP_ATTEMPT_ID.test(raw)) {
    return invalidIdentity("setupAttemptId");
  }

  return { ok: true, value: raw as CustomConnectorSetupAttemptId };
}

export function newCustomConnectorSetupAttemptId(): CustomConnectorSetupAttemptId {
  const parsed = parseCustomConnectorSetupAttemptId(
    `custom_connector_setup_${crypto.randomUUID()}`,
  );
  if (!parsed.ok) {
    throw new Error("generated custom connector setup attempt ID is invalid");
  }
  return parsed.value;
}

export function parseCustomConnectorRevision(
  raw: unknown,
): Result<CustomConnectorRevision, CustomConnectorIdentityParseError> {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    return invalidIdentity("revision");
  }

  return { ok: true, value: raw as CustomConnectorRevision };
}

export function parseCustomConnectorDefinitionDigest(
  raw: unknown,
): Result<CustomConnectorDefinitionDigest, CustomConnectorIdentityParseError> {
  if (!isSha256Hex(raw)) {
    return invalidIdentity("definitionDigest");
  }

  return { ok: true, value: raw as CustomConnectorDefinitionDigest };
}

export function parseCustomConnectorAuthoringDigest(
  raw: unknown,
): Result<CustomConnectorAuthoringDigest, CustomConnectorIdentityParseError> {
  if (!isSha256Hex(raw)) {
    return invalidIdentity("authoringDigest");
  }

  return { ok: true, value: raw as CustomConnectorAuthoringDigest };
}

export function buildCustomConnectorRevisionIdentity(input: {
  readonly connectorId: CustomConnectorId;
  readonly revision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
}): CustomConnectorRevisionIdentity {
  return {
    connectorId: input.connectorId,
    revision: input.revision,
    definitionDigest: input.definitionDigest,
  };
}

function invalidIdentity(
  field: CustomConnectorIdentityParseError["field"],
): Result<never, CustomConnectorIdentityParseError> {
  return {
    ok: false,
    error: { code: "invalid_custom_connector_identity", field },
  };
}
