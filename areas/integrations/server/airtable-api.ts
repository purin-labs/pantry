import type {
  AirtableReadRequest,
  AirtableWriteRequest,
} from "./actors/airtable-tool-input";

const MAX_AIRTABLE_RESPONSE_BYTES = 512 * 1024;

export async function callAirtableApi(
  credential: string,
  request: AirtableReadRequest | AirtableWriteRequest,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      body: request.body,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
    });
  } catch {
    throw airtableTransportError(request.method);
  }
  if (response.status >= 500 && request.method !== "GET") {
    throw new Error(
      "airtable_write_outcome_unknown: inspect the base before another write",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Airtable API rejected the request (HTTP ${response.status})`,
    );
  }
  if (response.status === 204) {
    return { status: 204 };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw airtableResponseError(request.method);
  }

  if (new TextEncoder().encode(text).byteLength > MAX_AIRTABLE_RESPONSE_BYTES) {
    throw airtableResponseError(request.method);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw airtableResponseError(request.method);
  }

  return redactProviderSecrets(value);
}

function airtableTransportError(
  method: AirtableReadRequest["method"] | AirtableWriteRequest["method"],
): Error {
  if (method === "GET") {
    return new Error("Airtable unavailable");
  }

  return new Error(
    "airtable_write_outcome_unknown: inspect the base before another write",
  );
}

function airtableResponseError(
  method: AirtableReadRequest["method"] | AirtableWriteRequest["method"],
): Error {
  if (method === "GET") {
    return new Error("Airtable response unreadable; request a smaller page");
  }

  return new Error(
    "airtable_write_outcome_unknown: inspect the base before another write",
  );
}

function redactProviderSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactProviderSecrets);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "macSecretBase64" ||
      key === "accessToken" ||
      key === "refreshToken"
    ) {
      continue;
    }
    result[key] = redactProviderSecrets(item);
  }
  return result;
}
