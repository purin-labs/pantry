import { RequestDeadline } from "../request-deadline";
import type {
  DelegatedPlatformAssertionV1,
  ServiceOnboardingAssertionV1,
} from "@seams-internal/console-shared/accountPlatform";
import {
  readAccountAutomationGrantV1 as readAutomationGrantReceipt,
  type AccountAutomationGrantChangeV1,
  type AccountAutomationGrantV1 as AccountAutomationGrantReceipt,
} from "@seams-internal/console-shared/accountPlatform";
import {
  readSatyrInstanceReleaseV1 as readPantryInstanceReleaseV1,
  type SatyrInstanceReleaseRequestV1 as PantryInstanceReleaseRequestV1,
  type SatyrInstanceReleaseV1 as PantryInstanceReleaseV1,
} from "@seams-internal/console-shared/accountPlatform";
import {
  readReserveFundsResponseV1 as readReserveResponse,
  readSatyrServiceFeePolicyV1 as readFeePolicyResponse,
  readServiceEligibilityV1,
  readAccountServiceErrorV1 as readAccountError,
  type ReserveFundsResponseV1 as ReserveResponse,
  type SatyrServiceFeePolicyV1 as FeePolicyResponse,
} from "@seams-internal/console-shared/accountPlatform";
import {
  readAccountOnboardingOptions,
  readAccountOnboardingResult,
  type AccountOnboardingRequest,
} from "@seams/control-api";
import type { ActiveControlSession, User } from "../data/control-plane";
import type { StrictUnion, Variant } from "@seams/type-utils";
import {
  readOrganizationInvitationV1 as readAccountInvitation,
  readAccountMembershipListV1 as readAccountMembershipList,
  readIssuedOrganizationInvitationV1 as readAccountIssuedInvitation,
  readOrganizationMembershipWithAccessV1 as readAccountMembershipWithAccess,
  readActiveOrganizationMembershipV1 as readActiveAccountMembership,
  type OrganizationInvitation as AccountInvitation,
  type InviteOrganizationMemberRequest as AccountInviteRequest,
  type OrganizationMembership as AccountMembership,
  type AccountMembershipListV1 as AccountMembershipList,
  type IssuedOrganizationInvitation as AccountIssuedInvitation,
  type OrganizationMembershipWithAccess as AccountMembershipWithAccess,
} from "@seams-internal/console-shared/accountPlatform";
import {
  canonicalJson,
  sha256Hex,
  decodeBase64,
  encodeBase64Url,
  isRecord,
} from "@seams/std";
import { standardBase64 } from "../lenient-base64";
import type { Result } from "../result";
import type { AccountAdmissionAction, AccountUserAuthority } from "./access";
import {
  parseAccountPlatformConfiguration,
  type AccountPlatformBindings,
  type AccountPlatformConfiguration,
} from "./config";
import {
  assertPantryPrincipal,
  readLinkedUser,
  accountObject,
  accountUnavailable,
  readAccountFundsReservation,
  readAccountUsageReceipt,
  readAccountIdentityResolution,
  sameAccountScope,
  type AccountEligibility,
  type AccountFundsReservation,
  type AccountIdentityResolution,
  type AccountIndeterminateRequest,
  type AccountPlatformError,
  type AccountPrincipal,
  type AccountReserveRequest,
  type AccountScope,
  type AccountTerminalDelivery,
  type AccountUsageReceipt,
  type AccountUsageRequest,
  type LinkedPantryAccountAutomation,
  type LinkedPantryAccountUser,
  type PantryAccountBinding,
} from "./types";

export type { AccountPlatformBindings } from "./config";
/** What a check names of the binding. A check does not read the fee policy. */
type CheckedAccountBinding = Pick<PantryAccountBinding, "instanceId" | "scope">;
type AccountUserCheck = Readonly<{
  binding: CheckedAccountBinding;
  user: LinkedPantryAccountUser;
  authority: AccountUserAuthority;
  action: AccountAdmissionAction;
}>;
type AccountAutomationCheck = Readonly<{
  binding: CheckedAccountBinding;
  automation: LinkedPantryAccountAutomation;
  action: AccountAdmissionAction;
}>;
export type AccountMembershipActor = Readonly<{
  binding: PantryAccountBinding;
  user: LinkedPantryAccountUser;
  authority: Variant<AccountUserAuthority, "authenticated_session">;
}>;
type AccountAutomationGrantRequest = Omit<
  AccountAutomationGrantChangeV1,
  "instanceId"
>;
export type { AccountAutomationGrantReceipt };
type SignedRequest = Readonly<{
  binding: CheckedAccountBinding;
  nativePrincipalId: string;
  principal: AccountPrincipal;
  action: AccountAdmissionAction;
  authorityRevision: number;
}>;
type CurrentAccountRequest = SignedRequest & Readonly<{ authorityRevision: 0 }>;

type AccountAssertionPayload = StrictUnion<
  | (Omit<
      Pick<DelegatedPlatformAssertionV1, keyof DelegatedPlatformAssertionV1>,
      "toJSON" | "scope" | "principal"
    > & { readonly scope: AccountScope; readonly principal: AccountPrincipal })
  | Pick<ServiceOnboardingAssertionV1, keyof ServiceOnboardingAssertionV1>
>;

type OnboardingCommand =
  | Readonly<{
      operation: "identity";
      body: Readonly<{ version: 1; googleIdToken: string }>;
    }>
  | Readonly<{ operation: "options"; body: Readonly<{ version: 1 }> }>
  | Readonly<{ operation: "start"; body: AccountOnboardingRequest }>;
export function createAccountPlatformClient(
  env: AccountPlatformBindings,
): Result<AccountPlatformClient, AccountPlatformError> {
  const config = parseAccountPlatformConfiguration(env);
  return config.ok
    ? { ok: true, value: new AccountPlatformClient(config.value) }
    : config;
}

export class AccountPlatformClient {
  constructor(private readonly config: AccountPlatformConfiguration) {}

  get deploymentId(): string {
    return this.config.deploymentId;
  }

  registerOnboardingIdentity(
    user: User,
    session: ActiveControlSession,
    googleIdToken: string,
  ) {
    return this.onboarding(
      { operation: "identity", body: { version: 1, googleIdToken } },
      user,
      session,
      readLinkedUser,
    );
  }

  onboardingOptions(user: User, session: ActiveControlSession) {
    return this.onboarding(
      { operation: "options", body: { version: 1 } },
      user,
      session,
      readAccountOnboardingOptions,
    );
  }

  startOnboarding(
    user: User,
    session: ActiveControlSession,
    input: AccountOnboardingRequest,
  ) {
    return this.onboarding(
      { operation: "start", body: input },
      user,
      session,
      readAccountOnboardingResult,
    );
  }

  private async onboarding<T>(
    command: OnboardingCommand,
    user: User,
    session: ActiveControlSession,
    parser: (input: unknown) => T,
  ): Promise<Result<T, AccountPlatformError>> {
    const { operation, body } = command;
    if (
      session.userId !== user.userId ||
      session.expiresAt <= Date.now() ||
      user.issuer !== "https://accounts.google.com"
    )
      return scopeForbidden();
    const path = `/account-platform/v1/onboarding/${operation}`;
    const assertion = await signAccountPayload(this.config, {
      version: 1,
      purpose: "satyr_onboarding",
      issuer: this.config.assertion.issuer,
      audience: this.config.assertion.audience,
      nativePrincipalId: user.userId,
      nativeSessionId: session.controlSessionId,
      subject: user.subject,
      requestDigest: await sha256Hex(canonicalJson({ path, body })),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!assertion.ok) return assertion;
    return this.post(`onboarding/${operation}`, body, parser, assertion.value);
  }

  reserveFunds(
    input: AccountReserveRequest,
  ): Promise<Result<ReserveResponse, AccountPlatformError>> {
    return this.post("funds/reserve", input, readReserveResponse);
  }
  markIndeterminate(
    input: AccountIndeterminateRequest,
  ): Promise<Result<AccountFundsReservation, AccountPlatformError>> {
    return this.post("funds/indeterminate", input, readAccountFundsReservation);
  }
  recordUsage(
    input: AccountUsageRequest,
  ): Promise<Result<AccountUsageReceipt, AccountPlatformError>> {
    return this.post("usage", input, readAccountUsageReceipt);
  }
  settleFunds(
    input: Variant<AccountTerminalDelivery, "settle">,
  ): Promise<Result<AccountFundsReservation, AccountPlatformError>> {
    return this.post("funds/settle", input, readAccountFundsReservation);
  }
  releaseFunds(
    input: Variant<AccountTerminalDelivery, "release">,
  ): Promise<Result<AccountFundsReservation, AccountPlatformError>> {
    return this.post("funds/release", input, readAccountFundsReservation);
  }
  reconcileFunds(
    input: Variant<AccountTerminalDelivery, "reconcile">,
  ): Promise<Result<AccountFundsReservation, AccountPlatformError>> {
    return this.post("funds/reconcile", input, readAccountFundsReservation);
  }
  getReservation(
    reservationId: string,
  ): Promise<Result<AccountFundsReservation, AccountPlatformError>> {
    return this.post(
      "funds/status",
      { version: 1, reservationId },
      readAccountFundsReservation,
    );
  }
  getFeePolicy(
    instanceId: string,
  ): Promise<Result<FeePolicyResponse, AccountPlatformError>> {
    return this.post(
      "fee-policy",
      { version: 1, instanceId },
      readFeePolicyResponse,
    );
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

  listMemberships(
    input: AccountMembershipActor,
  ): Promise<Result<AccountMembershipList, AccountPlatformError>> {
    return this.signedPostUser(
      "memberships/list",
      { version: 1, instanceId: input.binding.instanceId },
      membershipCheck(input, "disclose"),
      readAccountMembershipList,
    );
  }
  inviteMembership(
    input: AccountMembershipActor &
      Readonly<{ invitation: AccountInviteRequest }>,
  ): Promise<Result<AccountIssuedInvitation, AccountPlatformError>> {
    return this.signedPostUser(
      "memberships/invite",
      {
        version: 1,
        instanceId: input.binding.instanceId,
        invitation: input.invitation,
      },
      membershipCheck(input, "execute"),
      readAccountIssuedInvitation,
    );
  }
  revokeMembership(
    input: AccountMembershipActor & Readonly<{ membershipId: string }>,
  ): Promise<Result<AccountMembershipWithAccess, AccountPlatformError>> {
    return this.signedPostUser(
      "memberships/revoke",
      {
        version: 1,
        instanceId: input.binding.instanceId,
        membershipId: input.membershipId,
      },
      membershipCheck(input, "execute"),
      readAccountMembershipWithAccess,
    );
  }
  revokeInvitation(
    input: AccountMembershipActor & Readonly<{ invitationId: string }>,
  ): Promise<Result<AccountInvitation, AccountPlatformError>> {
    return this.signedPostUser(
      "invitations/revoke",
      {
        version: 1,
        instanceId: input.binding.instanceId,
        invitationId: input.invitationId,
      },
      membershipCheck(input, "execute"),
      readAccountInvitation,
    );
  }
  acceptInvitation(
    input: AccountMembershipActor &
      Readonly<{ invitationId: string; token: string }>,
  ): Promise<
    Result<Variant<AccountMembership, "active">, AccountPlatformError>
  > {
    return this.signedPostUser(
      "invitations/accept",
      {
        version: 1,
        instanceId: input.binding.instanceId,
        invitationId: input.invitationId,
        token: input.token,
      },
      membershipCheck(input, "execute"),
      readActiveAccountMembership,
    );
  }

  setAutomationGrant(
    input: AccountMembershipActor & AccountAutomationGrantRequest,
  ): Promise<Result<AccountAutomationGrantReceipt, AccountPlatformError>> {
    return this.signedPostUser(
      "automation-grants/set",
      {
        version: 1,
        instanceId: input.binding.instanceId,
        automationId: input.automationId,
        grantId: input.grantId,
        nativePrincipalId: input.nativePrincipalId,
        access: input.access,
        expectedAccessRevision: input.expectedAccessRevision,
      },
      membershipCheck(input, "execute"),
      readAutomationGrantReceipt,
    );
  }

  async linkUser(
    input: AccountUserCheck & Readonly<{ googleIdToken: string }>,
  ): Promise<Result<AccountIdentityResolution, AccountPlatformError>> {
    const signed = userSignedRequest(input);
    const assertion = await signAccountAssertion(this.config, signed);
    if (!assertion.ok) return assertion;
    return this.post(
      "identity/link",
      {
        version: 1,
        instanceId: input.binding.instanceId,
        googleIdToken: input.googleIdToken,
      },
      readAccountIdentityResolution,
      assertion.value,
    );
  }

  async checkUser(
    input: AccountUserCheck,
  ): Promise<Result<AccountEligibility, AccountPlatformError>> {
    if (
      input.authority.kind === "disclosure_recipient" &&
      input.action !== "disclose"
    )
      return scopeForbidden();
    if (
      input.authority.kind === "authenticated_provider_event" &&
      input.action !== "execute"
    )
      return scopeForbidden();
    return this.checkCurrent(userSignedRequest(input));
  }

  async checkAutomation(
    input: AccountAutomationCheck,
  ): Promise<Result<AccountEligibility, AccountPlatformError>> {
    return this.checkCurrent({
      binding: input.binding,
      nativePrincipalId: input.automation.nativePrincipalId,
      principal: {
        kind: "automation",
        automationId: input.automation.automationId,
        grantId: input.automation.grantId,
      },
      action: input.action,
      authorityRevision: 0,
    });
  }

  async signedPostUser<T>(
    path: string,
    body: object,
    input: AccountUserCheck,
    parser: (input: unknown) => T,
  ): Promise<Result<T, AccountPlatformError>> {
    if (input.authority.kind !== "authenticated_session")
      return scopeForbidden();
    const current = await this.currentIdentity(userSignedRequest(input));
    if (!current.ok) return current;
    const assertion = await signAccountAssertion(this.config, current.value);
    if (!assertion.ok) return assertion;
    return this.post(path, body, parser, assertion.value);
  }

  private async currentIdentity(
    input: CurrentAccountRequest,
  ): Promise<Result<SignedRequest, AccountPlatformError>> {
    const assertion = await signAccountAssertion(this.config, input);
    if (!assertion.ok) return assertion;
    const resolved = await this.post(
      "identity/resolve",
      { version: 1, instanceId: input.binding.instanceId },
      readAccountIdentityResolution,
      assertion.value,
    );
    if (!resolved.ok) return resolved;
    if (!sameResolvedIdentity(resolved.value, input)) return scopeForbidden();
    return {
      ok: true,
      value: {
        binding: input.binding,
        nativePrincipalId: input.nativePrincipalId,
        principal: input.principal,
        action: input.action,
        authorityRevision: resolved.value.authorityRevision,
      },
    };
  }

  private async checkCurrent(
    input: CurrentAccountRequest,
  ): Promise<Result<AccountEligibility, AccountPlatformError>> {
    const assertion = await signAccountAssertion(this.config, input);
    if (!assertion.ok) return assertion;
    const result = await this.post(
      "eligibility/current",
      {
        version: 1,
        instanceId: input.binding.instanceId,
        principal: input.principal,
        action: input.action,
      },
      readEligibility,
      assertion.value,
    );
    if (!result.ok) return result;
    if (
      result.value.instanceId !== input.binding.instanceId ||
      !sameAccountScope(result.value.scope, input.binding.scope) ||
      result.value.action !== input.action ||
      canonicalJson(result.value.principal) !== canonicalJson(input.principal)
    )
      return scopeForbidden();
    return result;
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

function userSignedRequest(input: AccountUserCheck): CurrentAccountRequest {
  return {
    binding: input.binding,
    nativePrincipalId: input.user.nativeUserId,
    principal: {
      kind: "user",
      identity: {
        kind: "verified_provider_subject",
        userId: input.user.platformUserId,
        issuer: input.user.issuer,
        subject: input.user.subject,
        verificationReceiptId: input.user.verificationReceiptId,
      },
      authority: input.authority,
    },
    action: input.action,
    authorityRevision: 0,
  };
}
function sameResolvedIdentity(
  resolved: AccountIdentityResolution,
  requested: SignedRequest,
): boolean {
  return (
    resolved.instanceId === requested.binding.instanceId &&
    resolved.nativePrincipalId === requested.nativePrincipalId &&
    sameAccountScope(resolved.scope, requested.binding.scope) &&
    canonicalJson(resolved.principal) === canonicalJson(requested.principal)
  );
}
async function signAccountAssertion(
  config: AccountPlatformConfiguration,
  input: SignedRequest,
): Promise<Result<string, AccountPlatformError>> {
  return signAccountPayload(config, {
    version: 1,
    issuer: config.assertion.issuer,
    audience: config.assertion.audience,
    principal: input.principal,
    nativePrincipalId: input.nativePrincipalId,
    scope: input.binding.scope,
    instanceId: input.binding.instanceId,
    action: input.action,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    authorityRevision: input.authorityRevision,
  });
}

async function signAccountPayload(
  config: AccountPlatformConfiguration,
  assertion: AccountAssertionPayload,
): Promise<Result<string, AccountPlatformError>> {
  try {
    const privateBytes = decodeBase64(standardBase64(config.assertion.pkcs8));
    if (privateBytes === null) return accountUnavailable();
    const key = await crypto.subtle.importKey(
      "pkcs8",
      copyBuffer(privateBytes),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const header = encodeBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          alg: "EdDSA",
          typ: "JWT",
          kid: config.assertion.keyId,
        }),
      ),
    );
    const payload = encodeBase64Url(
      new TextEncoder().encode(JSON.stringify(assertion)),
    );
    const signature = await crypto.subtle.sign(
      "Ed25519",
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return {
      ok: true,
      value: `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`,
    };
  } catch {
    return accountUnavailable();
  }
}
function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
function scopeForbidden<T>(): Result<T, AccountPlatformError> {
  return { ok: false, error: { code: "scope_forbidden" } };
}
function readEligibility(input: unknown): AccountEligibility {
  const eligibility = readServiceEligibilityV1(input);
  assertPantryPrincipal(eligibility.principal);
  return {
    authorityRevision: eligibility.authorityRevision,
    accessRevision: eligibility.accessRevision,
    scope: eligibility.scope,
    instanceId: eligibility.instanceId,
    principal: eligibility.principal,
    action: eligibility.action,
  };
}
function membershipCheck(
  input: AccountMembershipActor,
  action: "execute" | "disclose",
): AccountUserCheck {
  return {
    binding: input.binding,
    user: input.user,
    authority: input.authority,
    action,
  };
}
