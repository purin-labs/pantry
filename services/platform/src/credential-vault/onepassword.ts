import type { Result } from "../result";
import type {
  ExternalVaultAdapter,
  ExternalVaultRead,
  ExternalVaultReadError,
} from "./external-import";
import { isRecord } from "@seams/std";

export type OnePasswordItemLocator = {
  readonly vaultId: string;
  readonly itemId: string;
  readonly fieldId: string;
};

export type OnePasswordAdapterConfig = {
  readonly origin: string;
  readonly token: string;
};

type OnePasswordField = {
  readonly id: unknown;
  readonly value: unknown;
};

export function createOnePasswordAdapter(input: {
  readonly config: OnePasswordAdapterConfig;
  readonly locator: OnePasswordItemLocator;
  readonly fetcher: typeof fetch;
}): ExternalVaultAdapter {
  const sourceLocator = onePasswordSourceLocator(input.locator);

  return {
    source: { kind: "onepassword", locator: sourceLocator },
    read(): Promise<Result<ExternalVaultRead, ExternalVaultReadError>> {
      return readOnePasswordItem(input);
    },
  };
}

async function readOnePasswordItem(input: {
  readonly config: OnePasswordAdapterConfig;
  readonly locator: OnePasswordItemLocator;
  readonly fetcher: typeof fetch;
}): Promise<Result<ExternalVaultRead, ExternalVaultReadError>> {
  let response: Response;

  try {
    response = await input.fetcher(
      onePasswordItemUrl(input.config.origin, input.locator),
      {
        headers: { Authorization: `Bearer ${input.config.token}` },
      },
    );
  } catch {
    return { ok: false, error: { code: "external_vault_unavailable" } };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: { code: "external_vault_unauthorized" } };
  }

  if (!response.ok) {
    return { ok: false, error: { code: "external_vault_unavailable" } };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return { ok: false, error: { code: "external_vault_response_invalid" } };
  }

  return parseOnePasswordItem(body, input.locator.fieldId);
}

function parseOnePasswordItem(
  body: unknown,
  fieldId: string,
): Result<ExternalVaultRead, ExternalVaultReadError> {
  if (
    !isRecord(body) ||
    typeof body.version !== "number" ||
    !Number.isSafeInteger(body.version) ||
    body.version < 1 ||
    typeof body.state !== "string"
  ) {
    return { ok: false, error: { code: "external_vault_response_invalid" } };
  }

  const revision = String(body.version);

  if (body.state === "ARCHIVED") {
    return { ok: true, value: { kind: "authenticated_tombstone", revision } };
  }

  if (body.state !== "ACTIVE" || !Array.isArray(body.fields)) {
    return { ok: false, error: { code: "external_vault_response_invalid" } };
  }

  const field = body.fields.find(
    (candidate): candidate is OnePasswordField =>
      isRecord(candidate) && candidate.id === fieldId,
  );

  if (
    field === undefined ||
    typeof field.value !== "string" ||
    field.value.length === 0
  ) {
    return { ok: false, error: { code: "external_vault_secret_invalid" } };
  }

  return {
    ok: true,
    value: {
      kind: "secret",
      revision,
      secret: { kind: "bearer", value: field.value },
    },
  };
}

function onePasswordItemUrl(
  origin: string,
  locator: OnePasswordItemLocator,
): string {
  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${base}/v1/vaults/${encodeURIComponent(locator.vaultId)}/items/${encodeURIComponent(locator.itemId)}`;
}

function onePasswordSourceLocator(locator: OnePasswordItemLocator): string {
  return [
    "op-connect",
    encodeURIComponent(locator.vaultId),
    encodeURIComponent(locator.itemId),
    encodeURIComponent(locator.fieldId),
  ].join(":");
}
