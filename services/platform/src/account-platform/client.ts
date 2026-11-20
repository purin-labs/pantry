import { RequestDeadline } from "../request-deadline";
import {
  readSatyrInstanceReleaseV1 as readPantryInstanceReleaseV1,
  readAccountServiceErrorV1 as readAccountError,
  type SatyrInstanceReleaseRequestV1 as PantryInstanceReleaseRequestV1,
  type SatyrInstanceReleaseV1 as PantryInstanceReleaseV1,
} from "@seams-internal/console-shared/accountPlatform";
import { isRecord } from "@purin-labs/std";
import type { Result } from "../result";
import {
  parseAccountPlatformConfiguration,
  type AccountPlatformBindings,
  type AccountPlatformConfiguration,
} from "./config";
import {
  accountObject,
  accountUnavailable,
  type AccountPlatformError,
} from "./types";

/**
 * Plan 95: the one call to the old Console that remains until step 4 deletes
 * this module. Pantry reports an organisation that it deleted for good, so
 * that the Console can archive its instance.
 */
export function createAccountPlatformClient(
  env: AccountPlatformBindings,
): Result<AccountPlatformClient, AccountPlatformError> {
  const config = parseAccountPlatformConfiguration(env);
  return config.ok
    ? { ok: true, value: new AccountPlatformClient(config.value) }
    : config;
}

class AccountPlatformClient {
  constructor(private readonly config: AccountPlatformConfiguration) {}

  get deploymentId(): string {
    return this.config.deploymentId;
  }

  /** Reports that Pantry deleted the instance's organisation for good. */
  releaseInstance(
    input: PantryInstanceReleaseRequestV1,
  ): Promise<Result<PantryInstanceReleaseV1, AccountPlatformError>> {
    return this.post(
      "satyr/instance-release",
      input,
      readPantryInstanceReleaseV1,
    );
  }

  private async post<T>(
    path: string,
    body: object,
    parser: (input: unknown) => T,
    assertion: string | null = null,
  ): Promise<Result<T, AccountPlatformError>> {
    const deadline = new RequestDeadline(ACCOUNT_REQUEST_TIMEOUT_MS);
    try {
      const headers = new Headers({
        "Content-Type": "application/json",
        Accept: "application/json",
      });
      if (assertion !== null)
        headers.set("X-Account-User-Assertion", assertion);
      const request = new Request(
        `https://account-platform.internal/account-platform/v1/${path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "manual",
          signal: deadline.signal,
        },
      );
      const response = await this.config.transport.fetch(request);
      const raw: unknown = await response.json();
      if (!isRecord(raw)) return accountUnavailable();
      switch (raw.kind) {
        case "accepted":
          accountObject(raw, ["kind", "value"]);
          if (!response.ok) return accountUnavailable();
          return { ok: true, value: parser(raw.value) };
        case "rejected":
          accountObject(raw, ["kind", "error"]);
          return { ok: false, error: readAccountError(raw.error) };
        default:
          return accountUnavailable();
      }
    } catch {
      return accountUnavailable();
    } finally {
      deadline.end();
    }
  }
}

const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;
