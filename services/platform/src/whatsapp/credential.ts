import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { resolveActiveProviderConnectionCredential } from "../credential-vault";
import {
  connectionCredentialAuthority,
  resolveActiveProviderAccountContext,
} from "../data/integration-account";
import type { Env } from "../env";
import type { IntegrationAccountId } from "../ids";
import type { Result } from "../result";

type WhatsAppOrganisationCredential = {
  readonly accessToken: string;
  readonly expiresAt: number | null;
  readonly credentialGeneration: number;
};

type WhatsAppOrganisationCredentialError = {
  readonly code:
    | "whatsapp_connection_inactive"
    | "whatsapp_credential_unavailable"
    | "whatsapp_credential_expired";
};

export async function resolveWhatsAppOrganisationCredential(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    integrationAccountId: IntegrationAccountId;
    now: number;
  }>,
): Promise<
  Result<WhatsAppOrganisationCredential, WhatsAppOrganisationCredentialError>
> {
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "whatsapp_connection_inactive" } };
  const context = await resolveActiveProviderAccountContext({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!context.ok || context.value.account.provider !== "whatsapp") {
    return { ok: false, error: { code: "whatsapp_connection_inactive" } };
  }
  const authority = connectionCredentialAuthority(
    context.value.connection.authority,
  );
  const resolved = await resolveActiveProviderConnectionCredential({
    db: input.scope.database,
    keys: input.env,
    context: context.value,
    expectedProvider: "whatsapp",
  });
  if (
    !resolved.ok ||
    (resolved.value.kind !== "bearer" &&
      resolved.value.kind !== "expiring_bearer")
  ) {
    return { ok: false, error: { code: "whatsapp_credential_unavailable" } };
  }
  if (
    resolved.value.kind === "expiring_bearer" &&
    resolved.value.expiresAt <= input.now
  ) {
    return { ok: false, error: { code: "whatsapp_credential_expired" } };
  }
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "whatsapp_connection_inactive" } };
  return {
    ok: true,
    value: {
      accessToken: resolved.value.value,
      expiresAt:
        resolved.value.kind === "expiring_bearer"
          ? resolved.value.expiresAt
          : null,
      credentialGeneration: authority.credentialGeneration,
    },
  };
}
