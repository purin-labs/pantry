import type { Env } from "../env";
import type { Result } from "../result";

type WhatsAppApplicationConfiguration = {
  readonly appId: string;
  readonly embeddedSignupConfigId: string;
};

type WhatsAppEmbeddedSignupCredential = {
  readonly appId: string;
  readonly appSecret: string;
};

type WhatsAppApplicationError = {
  readonly code: "whatsapp_application_not_configured";
};

type WhatsAppApplicationBindings = Pick<
  Env,
  | "WHATSAPP_APP_ID"
  | "WHATSAPP_APP_SECRET"
  | "WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID"
>;

export function resolveWhatsAppApplicationConfiguration(
  env: WhatsAppApplicationBindings,
): Result<WhatsAppApplicationConfiguration, WhatsAppApplicationError> {
  const appId = trimmed(env.WHATSAPP_APP_ID);
  const embeddedSignupConfigId = trimmed(
    env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
  );
  if (appId === null || embeddedSignupConfigId === null) {
    return {
      ok: false,
      error: { code: "whatsapp_application_not_configured" },
    };
  }
  return { ok: true, value: { appId, embeddedSignupConfigId } };
}

export function resolveWhatsAppEmbeddedSignupCredential(
  env: Pick<
    WhatsAppApplicationBindings,
    "WHATSAPP_APP_ID" | "WHATSAPP_APP_SECRET"
  >,
): Result<WhatsAppEmbeddedSignupCredential, WhatsAppApplicationError> {
  const appId = trimmed(env.WHATSAPP_APP_ID);
  const appSecret = trimmed(env.WHATSAPP_APP_SECRET);
  return appId === null || appSecret === null
    ? { ok: false, error: { code: "whatsapp_application_not_configured" } }
    : { ok: true, value: { appId, appSecret } };
}

function trimmed(value: string | undefined): string | null {
  const candidate = value?.trim() ?? "";
  return candidate.length === 0 ? null : candidate;
}
