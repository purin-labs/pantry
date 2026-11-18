import type { GlobalDatabase } from "../../src/database-handles";
import { encodeBase64Url } from "@seams/std";
import {
  digestApprovalAction,
  type ApprovalActionBinding,
} from "../../src/approval-authentication";
import {
  beginGoogleOidc,
  completeGoogleOidc,
  issueGoogleApprovalGrant,
  type GoogleOidcConfig,
} from "../../src/control/oidc";
import { parseOrganisationId, type UserId } from "../../src/ids";

export async function completeCommerceApprovalFixture(input: {
  readonly db: GlobalDatabase;
  readonly config: GoogleOidcConfig;
  readonly action: Parameters<typeof digestApprovalAction>[0];
  readonly userId: UserId;
  readonly subject: string;
  readonly email: string;
  readonly stepUpId: string;
}): Promise<string> {
  const config = input.config;
  const now = Date.now();
  const organisationId = parseOrganisationId(input.action.organisationId);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  const challenge: ApprovalActionBinding = {
    stepUpId: input.stepUpId,
    organisationId: organisationId.value,
    actionNonce: input.action.nonce.value,
    actionDigest: await digestApprovalAction(input.action),
    policy: { kind: "unversioned_default" },
    issuedAt: now,
    expiresAt: now + 60_000,
  };
  const started = await beginGoogleOidc({
    db: input.db,
    config,
    redirectPath: "/portal",
    authentication: { kind: "approval_step_up", challenge },
    now,
  });
  const nonce = new URL(started.authorizationUrl).searchParams.get("nonce");
  if (nonce === null) throw new Error("Missing OIDC nonce");
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in pair)) throw new Error("Expected RSA key pair");
  const header = encodeJson({ alg: "RS256", kid: "pi-effect" });
  const claims = encodeJson({
    iss: "https://accounts.google.com",
    aud: config.clientId,
    sub: input.subject,
    exp: Math.floor(now / 1000) + 600,
    iat: Math.floor(now / 1000),
    nonce,
    email: input.email,
    email_verified: true,
    name: "E2E Slack Actor",
  });
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const token = `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (jwk instanceof ArrayBuffer) throw new Error("Expected JWK export");
  const completed = await completeGoogleOidc({
    db: input.db,
    config,
    state: started.state,
    code: "pi-effect-code",
    now: Date.now(),
    fetcher: googleResponse.bind(null, token, jwk),
  });
  if (!completed.ok || completed.value.approvalChallenge === null)
    throw new Error("Approval OIDC fixture failed");
  return issueGoogleApprovalGrant(
    {
      stateHash: completed.value.approvalStateHash,
      userId: input.userId,
      challenge: completed.value.approvalChallenge,
    },
    config.clientSecret,
  );
}

async function googleResponse(
  token: string,
  key: JsonWebKey,
  input: RequestInfo | URL,
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://oauth2.googleapis.com/token")
    return Response.json({ id_token: token });
  if (url === "https://www.googleapis.com/oauth2/v3/certs")
    return Response.json({
      keys: [{ ...key, kid: "pi-effect", alg: "RS256", use: "sig" }],
    });
  throw new Error("Unexpected Google approval request");
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}
