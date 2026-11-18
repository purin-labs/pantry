import {
  configuredValue,
  exactScopeIsGranted,
  pkceChallenge,
  SHORT_PROVIDER_STATE_TTL_MS,
} from "./authorization";
import {
  providerHttpFailure,
  type ProviderCleanupAdapter,
  type ProviderCleanupResult,
  type ProviderOnboardingAdapter,
} from "./domain";
import {
  gmailScopesForProduct,
  parseGmailAuthorizationProduct,
  type GmailAuthorizationProduct,
} from "../mail/gmail-authorization";
import {
  gmailGetProfile,
  gmailBrowseInbox,
  gmailReadInboxReferences,
  gmailReadInboxThread,
  gmailReadThreadHeadline,
  gmailGetMessageMetadata,
  gmailGetMessageContent,
  gmailGetAttachment,
  gmailSearchMessages,
  gmailFindByRfcMessageId,
  gmailFindDraftByRfcMessageId,
  gmailStartWatch,
  gmailStopWatch,
  gmailListInboxAdditions,
  gmailReadInboxHistoryPage,
  gmailCreateDraft,
  gmailGetDraft,
  gmailUpdateDraft,
  gmailDeleteDraft,
  gmailSendRaw,
  gmailSendRawMessage,
} from "../mail/gmail-adapter";
import type { MailProviderAdapter } from "./mail";

export const gmailMailAdapter: MailProviderAdapter<"gmail"> = {
  provider: "gmail",
  products: {
    full_mailbox_pilot: {
      product: "full_mailbox_pilot",
      reads: {
        readProfile: gmailGetProfile,
        browseInbox: gmailBrowseInbox,
        readInboxReferences: gmailReadInboxReferences,
        readConversation: gmailReadInboxThread,
        readThreadHeadline: gmailReadThreadHeadline,
        readMessageMetadata: gmailGetMessageMetadata,
        readMessage: gmailGetMessageContent,
        readAttachment: gmailGetAttachment,
        searchMessages: gmailSearchMessages,
        findSubmissionEvidence: gmailFindByRfcMessageId,
      },
      observation: {
        startWatch: gmailStartWatch,
        stopWatch: gmailStopWatch,
        readInboxAdditions: gmailListInboxAdditions,
        readInboxHistoryPage: gmailReadInboxHistoryPage,
      },
      drafts: {
        create: gmailCreateDraft,
        read: gmailGetDraft,
        replaceBody: gmailUpdateDraft,
        dispose: gmailDeleteDraft,
        findCreationEvidence: gmailFindDraftByRfcMessageId,
      },
      submission: {
        sendReply: gmailSendRaw,
        sendMessage: gmailSendRawMessage,
      },
    },
    send_only: {
      product: "send_only",
      submission: { sendMessage: gmailSendRawMessage },
    },
  },
};

const MANUAL_INSTRUCTION = "revoke_gmail_access_in_google" as const;
// Google grants the OpenID shorthand "email" under its canonical identifier
// (".../auth/userinfo.email"), so the shorthand never appears in the token
// response's scope field and an exact granted-scope comparison against it
// always fails. Request the canonical form; "openid" is echoed verbatim.
const GMAIL_SCOPES = gmailScopesForProduct("full_mailbox_pilot");

export const gmailCleanupAdapter: ProviderCleanupAdapter<"gmail"> = {
  provider: "gmail",
  manualActionInstruction: MANUAL_INSTRUCTION,
  remove: revokeGoogleGrant,
};

export const gmailOnboardingAdapter: ProviderOnboardingAdapter<"gmail"> = {
  provider: "gmail",
  requiredScopes: GMAIL_SCOPES,
  stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
  parseStartContext: parseGmailStartContext,
  configurationIsValid: gmailConfigurationIsValid,
  authorizationSecret: gmailAuthorizationSecret,
  authorizationUrl: gmailAuthorizationUrl,
  scopeIsGranted: exactScopeIsGranted,
};

function parseGmailStartContext(raw: unknown): {
  readonly provider: "gmail";
  readonly authorizationProduct: GmailAuthorizationProduct;
} | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const authorizationProduct = parseGmailAuthorizationProduct(
    value.authorizationProduct,
  );
  return value.provider === "gmail" && authorizationProduct !== null
    ? { provider: "gmail", authorizationProduct }
    : null;
}

function gmailConfigurationIsValid(
  env: Parameters<typeof gmailAuthorizationSecret>[0],
): boolean {
  return gmailConfigurationIsValidForProduct(env, "full_mailbox_pilot");
}

export function gmailConfigurationIsValidForProduct(
  env: Parameters<typeof gmailAuthorizationSecret>[0],
  product: GmailAuthorizationProduct,
): boolean {
  return (
    gmailAuthorizationClientId(env, product) !== null &&
    gmailAuthorizationSecretForProduct(env, product) !== null
  );
}

function gmailAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"gmail">["configurationIsValid"]
  >[0],
): string | null {
  return gmailAuthorizationSecretForProduct(env, "full_mailbox_pilot");
}

export function gmailAuthorizationClientId(
  env: Parameters<typeof gmailAuthorizationSecret>[0],
  _product: GmailAuthorizationProduct,
): string | null {
  return configuredValue(env.GMAIL_OAUTH_CLIENT_ID);
}

export function gmailAuthorizationSecretForProduct(
  env: Parameters<typeof gmailAuthorizationSecret>[0],
  _product: GmailAuthorizationProduct,
): string | null {
  return configuredValue(env.GMAIL_OAUTH_CLIENT_SECRET);
}

export function gmailRequiredScopesForProduct(
  product: GmailAuthorizationProduct,
): readonly string[] {
  return gmailScopesForProduct(product);
}

async function gmailAuthorizationUrl(
  input: Parameters<ProviderOnboardingAdapter<"gmail">["authorizationUrl"]>[0],
): Promise<string> {
  if (input.pkceVerifier === null)
    throw new Error("Gmail PKCE verifier is missing");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    gmailScopesForProduct(input.context.authorizationProduct).join(" "),
  );
  url.searchParams.set("state", input.state);
  url.searchParams.set(
    "code_challenge",
    await pkceChallenge(input.pkceVerifier),
  );
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  // select_account forces Google's chooser. Without it an organisation already
  // signed in as one mailbox re-consents that same account, so "Add another
  // mailbox" would silently reconnect the existing one instead of adding a
  // second. consent stays so a refresh token is always issued.
  url.searchParams.set("prompt", "select_account consent");
  return url.toString();
}

async function revokeGoogleGrant(
  input: Parameters<ProviderCleanupAdapter<"gmail">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  const tokens = input.credentials.oauthTokens;
  if (tokens === null)
    return permanentFailure("provider_cleanup_credential_missing");
  return revokeGoogleOAuthToken(tokens.refreshToken, input.fetcher);
}

export async function revokeGoogleOAuthToken(
  refreshToken: string,
  fetcher: typeof fetch,
): Promise<ProviderCleanupResult> {
  let response: Response;
  try {
    response = await fetcher("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch {
    return {
      kind: "retryable_failure",
      reason: "provider_cleanup_http_unavailable",
    };
  }
  return response.ok
    ? { kind: "removed" }
    : providerHttpFailure(response.status, MANUAL_INSTRUCTION);
}

function permanentFailure(
  reason: "provider_cleanup_credential_missing",
): ProviderCleanupResult {
  return { kind: "permanent_failure", reason, instruction: MANUAL_INSTRUCTION };
}
