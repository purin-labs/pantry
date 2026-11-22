import type { GlobalDatabase } from "./database-handles";

/**
 * The bindings of the Platform Worker.
 *
 * This file declares the bindings whose types come from the platform or from
 * this module. A binding whose type belongs to a higher module is declared by
 * that module, with a declaration merge of this interface: each Actor
 * namespace beside its class, each queue beside its message type and each
 * container beside its class (Refactor 17, step A1.2). So this file imports
 * no Actor and no area.
 */
export interface Env {
  /** Workers AI: the fallback of Portal voice control, through `voice/engines/` (Plan 82C). */
  AI?: Readonly<{
    run(
      model: "@cf/openai/whisper-large-v3-turbo",
      inputs: Readonly<{
        audio: string;
        language: "en";
        vad_filter: boolean;
        initial_prompt?: string;
      }>,
    ): Promise<Readonly<{ text?: unknown; segments?: unknown }>>;
  }>;
  /** The zone of the shop Macs' names. Without all three, no Mac can enroll. */
  VOICE_DNS_API_TOKEN?: string;
  VOICE_DNS_ZONE_ID?: string;
  VOICE_DNS_ZONE_NAME?: string;
  ASSETS: Fetcher;
  /** Global identity, placement directory and relocation journal. */
  DB: GlobalDatabase;
  /** Only cells with a deployed binding can accept organisation work. */
  ORGANISATION_DB_WNAM?: D1Database;
  ORGANISATION_DB_APAC?: D1Database;
  ORGANISATION_DB_EU?: D1Database;
  POLICY_KV: KVNamespace;
  ARCHIVE: R2Bucket;
  DATA_ENCRYPTION_ROOT: SecretsStoreSecret;
  VAULT_ROOT_V1?: SecretsStoreSecret;
  VAULT_ROOT_V2?: SecretsStoreSecret;
  PANTRY_VAULT_ACTIVE_KEY_VERSION: string;
  COMMERCE: Fetcher;
  /**
   * The model exit Worker, near AWS Tokyo (Plan 73). Each direct request to
   * a model provider goes through it; see `modelProviderFetch`.
   */
  MODEL_EXIT: Fetcher;
  /**
   * The ChatGPT exit Worker and its container (Plan 75). chatgpt.com refuses
   * requests from a Worker, so its requests go through a container instead
   * of MODEL_EXIT; see `modelProviderFetch`.
   */
  CHATGPT_EXIT: Fetcher;
  /**
   * The 1Password store Worker (Plan 79): it runs the 1Password SDK for an
   * Organisation that keeps its Vault items in 1Password.
   */
  VAULT_ONEPASSWORD: Fetcher;
  PANTRY_OAUTH_CALLBACK_ORIGIN?: string;
  PANTRY_PROVIDER_INGRESS_ORIGIN?: string;
  PANTRY_PUBLIC_ORIGIN: string;
  PANTRY_ORGANISATION_PLACEMENT_PROFILE: string;
  PANTRY_DEPLOYMENT_PROFILE?: string;
  PANTRY_FAULT_INJECTION_TOKEN?: string;
  /**
   * "on" lets Connectors start warm Case and Session slots (Plan 55F). Every
   * version reads a slot-backed Actor, so the setting turns on in a release
   * after the one that ships the reading code, and turning it off is safe.
   */
  ORGANISATION_ADMIN_TOKEN?: string;
  COMMERCE_LAB_SIGNING_SECRET?: string;
  SEAMS_WALLET_ORIGIN?: string;
  SEAMS_RELAYER_URL?: string;
  E13_PROBE_TOKEN?: string;
  SESSION_TOKEN_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_APP_ID?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_OAUTH_STATE_SECRET?: string;
  // A deployment holds exactly one Square application's credentials, and
  // Sandbox and production are separate seller populations, so the environment
  // is a property of the configured application rather than a per-request flag.
  SQUARE_OAUTH_ENVIRONMENT?: string;
  SQUARE_OAUTH_CLIENT_ID?: string;
  SQUARE_OAUTH_CLIENT_SECRET?: string;
  STRIPE_CONNECT_CLIENT_ID?: string;
  STRIPE_CONNECT_CLIENT_SECRET?: string;
  STRIPE_CONNECT_WEBHOOK_ID?: string;
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  AIRTABLE_OAUTH_CLIENT_ID?: string;
  AIRTABLE_OAUTH_CLIENT_SECRET?: string;
  NOTION_OAUTH_CLIENT_ID?: string;
  NOTION_OAUTH_CLIENT_SECRET?: string;
  GMAIL_OAUTH_CLIENT_ID?: string;
  GMAIL_OAUTH_CLIENT_SECRET?: string;
  DROPBOX_OAUTH_CLIENT_ID?: string;
  DROPBOX_OAUTH_CLIENT_SECRET?: string;
  GDRIVE_OAUTH_CLIENT_ID?: string;
  GDRIVE_OAUTH_CLIENT_SECRET?: string;
  GDRIVE_PICKER_API_KEY?: string;
  GDRIVE_PICKER_APP_ID?: string;
  GMAIL_PUBSUB_TOPIC?: string;
  GMAIL_PUBSUB_AUDIENCE?: string;
  GMAIL_PUBSUB_SERVICE_ACCOUNT?: string;
  /** Connected Google accounts this project may consume. Defaults to 80. */
  GMAIL_PILOT_ACCOUNT_CAP?: string;
  /** Consumption at which to begin production verification. Defaults to 50. */
  GMAIL_PILOT_SUBMISSION_TRIGGER?: string;
  /** Pantry's shared Meta application. Customer business tokens live in the organisation Vault. */
  WHATSAPP_APP_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID?: string;
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  /**
   * Pantry's own TypeSafe key (Plan 88). Jev features of an Organisation with
   * no key of its own call TypeSafe with it.
   */
  TYPESAFE_API_KEY?: string;
  /**
   * The OpenRouter model of Pantry's paid route, one of PLATFORM_PI_MODELS.
   * Unset in production, which runs PLATFORM_DEFAULT_PI_MODEL; tests that call
   * OpenRouter set a cheaper model.
   */
  PANTRY_PLATFORM_PI_MODEL?: string;
  COMMERCE_BASE_URL?: string;
  COMMERCE_SERVICE_TOKEN?: string;
  /**
   * The origin of a shop's QR order page, with `{name}` for its shop name,
   * such as `https://{name}.menu.seams.tokyo` (Plan 40B phase 2). Without
   * it, a shop's QR code opens its hosted page.
   */
  SHOP_ORDER_PAGE_ORIGIN?: string;
}
