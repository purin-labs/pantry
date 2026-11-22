import { canonicalJson, encodeBase64Url } from "@purin-labs/std";

type CredentialPolicyRuleSource = {
  provider: string;
  name: string;
  integrationAccountId: string;
  providerConnectionId: string;
  environment: string;
  credentialGeneration: number;
  vaultHandle: string;
  hostPattern: string;
  injectAs: string;
};

const textEncoder = new TextEncoder();

export async function credentialPolicyRuleId(
  input: CredentialPolicyRuleSource,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(ruleIdentityPayload(input)),
  );
  const hash = encodeBase64Url(new Uint8Array(digest)).slice(0, 24);

  return `egress.credential.${ruleSegment(input.provider)}.${ruleSegment(input.name)}.${hash}`;
}

function canonicalizeRuleInjectAs(raw: string): string {
  try {
    return canonicalJson(JSON.parse(raw));
  } catch {
    return raw.trim();
  }
}

function ruleIdentityPayload(input: CredentialPolicyRuleSource): string {
  return canonicalJson({
    hostPattern: input.hostPattern,
    injectAs: canonicalizeRuleInjectAs(input.injectAs),
    integrationAccountId: input.integrationAccountId,
    name: input.name,
    provider: input.provider,
    providerConnectionId: input.providerConnectionId,
    environment: input.environment,
    credentialGeneration: input.credentialGeneration,
    vaultHandle: input.vaultHandle,
  });
}

function ruleSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (normalized.length === 0) {
    return "rule";
  }

  return normalized;
}
