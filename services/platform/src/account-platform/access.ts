import type { OrganisationDatabase } from "../database-handles";
import type {
  ServiceAdmissionActionV1 as AccountAdmissionAction,
  PlatformUserAuthorityV1 as AccountUserAuthority,
} from "@seams-internal/console-shared/accountPlatform";
import {
  acknowledgeAccountAccessRevision,
  type NativeAccountAccessFence,
} from "./access-revision";
import { assertNever, canonicalJson } from "@purin-labs/std";
import {
  parseControlSessionId,
  parseUserId,
  type OrganisationId,
} from "../ids";
import { resolveControlSessionById } from "../data/control-plane";
import { createAccountPlatformClient } from "./client";
import type { AccountPlatformBindings } from "./config";
import { readNativePantryAccountBinding } from "./binding";
import {
  resolveLinkedPantryAccountAutomation,
  resolveLinkedPantryAccountUser,
} from "./identity";
import type { AccountPlatformError } from "./types";
import type { RequestAuthority } from "@purin-labs/contracts";
import type { UserId } from "../ids";
import type { ConversationScope } from "../chat/store";
import type { ActiveControlSession } from "../data/control-plane";
import type { Result } from "../result";
import type { Variant } from "@purin-labs/type-utils";

export type { AccountAdmissionAction, AccountUserAuthority };

export function acceptedExecutionAccountAuthority(
  sessionId: string,
  turnId: string,
): AccountUserAuthority {
  return {
    kind: "accepted_execution",
    acceptedExecutionId: JSON.stringify([sessionId, turnId]),
  };
}

export type AccountEligibilityFailure = Readonly<{
  code:
    | "authority_unavailable"
    | "membership_ineligible"
    | "instance_ineligible"
    | "scope_forbidden";
}>;

export type CurrentAccountEligibility = Readonly<{
  authorityRevision: number;
}>;

/**
 * Each call checks current account authority. An earlier result grants no
 * later access. The access of one read, `accountAccessOfOneRead`, is the one
 * exception: it holds an answer for that read only.
 */
export interface AccountPlatformAccess {
  checkAuthority(
    input: Readonly<{
      authority: RequestAuthority;
      userAuthority: AccountUserAuthority;
      action: AccountAdmissionAction;
    }>,
  ): Promise<Result<CurrentAccountEligibility, AccountEligibilityFailure>>;
  checkAutomation(
    input: Readonly<{
      authority: Variant<
        RequestAuthority,
        "workflow" | "agent_mailbox" | "whatsapp_support"
      >;
      action: AccountAdmissionAction;
    }>,
  ): Promise<Result<CurrentAccountEligibility, AccountEligibilityFailure>>;
  checkUser(
    input: Readonly<{
      userId: UserId;
      authority: AccountUserAuthority;
      action: AccountAdmissionAction;
    }>,
  ): Promise<Result<CurrentAccountEligibility, AccountEligibilityFailure>>;
}

export function createAccountPlatformAccess(
  env: AccountPlatformBindings,
  organisationId: OrganisationId,
  database: OrganisationDatabase,
  fence: NativeAccountAccessFence,
): AccountPlatformAccess {
  return new PantryAccountPlatformAccess(
    env,
    organisationId,
    database,
    fence,
    new Map(),
    "each_call",
  );
}

/**
 * The account access of one read. One read asks the account the same question
 * at several places: the gate of its request, the authority of the person who
 * reads and the capability that the read needs. Here each question is asked
 * one time, and an answer that `access` received for this request less than
 * `READ_ANSWER_MS` ago is that answer.
 *
 * Give it the access of one request only. A caller that must see a change
 * between two of its own checks uses `access` itself, which asks each time.
 */
export function accountAccessOfOneRead(
  access: AccountPlatformAccess,
): AccountPlatformAccess {
  return access instanceof PantryAccountPlatformAccess
    ? access.ofOneRead()
    : access;
}

/** How long one read may use an answer that its request already holds. */
const READ_ANSWER_MS = 5_000;

/**
 * The account answers a disclosure from the person and the action. It does not
 * decide on the evidence id, so each label of a read is one question.
 */
function questionAuthority(authority: AccountUserAuthority): unknown {
  return authority.kind === "disclosure_recipient"
    ? { kind: authority.kind }
    : authority;
}

type UserAnswer = ReturnType<AccountPlatformAccess["checkUser"]>;
type AskedUserAnswers = Map<
  string,
  Readonly<{ at: number; answer: UserAnswer }>
>;

class PantryAccountPlatformAccess implements AccountPlatformAccess {
  constructor(
    private readonly env: AccountPlatformBindings,
    private readonly organisationId: OrganisationId,
    private readonly database: OrganisationDatabase,
    private readonly fence: NativeAccountAccessFence,
    /** What this access was asked, by question. Only one read reads it. */
    private readonly asked: AskedUserAnswers,
    private readonly asks: "each_call" | "one_time_for_one_read",
  ) {}

  ofOneRead(): AccountPlatformAccess {
    return new PantryAccountPlatformAccess(
      this.env,
      this.organisationId,
      this.database,
      this.fence,
      this.asked,
      "one_time_for_one_read",
    );
  }

  checkUser(
    input: Parameters<AccountPlatformAccess["checkUser"]>[0],
  ): UserAnswer {
    const question = canonicalJson([
      input.userId,
      questionAuthority(input.authority),
      input.action,
    ]);
    const now = Date.now();
    const known = this.asked.get(question);
    if (
      this.asks === "one_time_for_one_read" &&
      known !== undefined &&
      now - known.at < READ_ANSWER_MS
    )
      return known.answer;
    for (const [earlier, { at }] of this.asked)
      if (now - at >= READ_ANSWER_MS) this.asked.delete(earlier);
    const answer = this.askUser(input);
    this.asked.set(question, { at: now, answer });
    return answer;
  }

  private async askUser(
    input: Parameters<AccountPlatformAccess["checkUser"]>[0],
  ): UserAnswer {
    const client = createAccountPlatformClient(this.env);
    if (!client.ok) return accessFailure(client.error);
    const [native, user] = await Promise.all([
      readNativePantryAccountBinding(this.env, this.organisationId),
      resolveLinkedPantryAccountUser(this.env, input.userId),
    ]);
    if (!native.ok) return accessFailure(native.error);
    if (!user.ok) return accessFailure(user.error);
    // Eligibility checks the current instance and scope. Only billing needs
    // the fee policy. The native session is an independent live check.
    const [checked, session] = await Promise.all([
      client.value.checkUser({
        binding: native.value,
        user: user.value,
        authority: input.authority,
        action: input.action,
      }),
      this.nativeSession(input),
    ]);
    if (!checked.ok) return accessFailure(checked.error);
    if (!session.ok) return session;
    const acknowledged = await acknowledgeAccountAccessRevision({
      database: this.database,
      organisationId: this.organisationId,
      userId: input.userId,
      accessRevision: checked.value.accessRevision,
      fence: this.fence,
    });
    if (!acknowledged.ok) return acknowledged;
    return {
      ok: true,
      value: { authorityRevision: checked.value.authorityRevision },
    };
  }

  /** An authenticated session must still be this person's live session. */
  private async nativeSession(
    input: Parameters<AccountPlatformAccess["checkUser"]>[0],
  ): Promise<Result<null, AccountEligibilityFailure>> {
    if (input.authority.kind !== "authenticated_session")
      return { ok: true, value: null };
    const sessionId = parseControlSessionId(input.authority.nativeSessionId);
    if (!sessionId.ok) return { ok: false, error: { code: "scope_forbidden" } };
    try {
      const session = await resolveControlSessionById({
        db: this.env.DB,
        controlSessionId: sessionId.value,
        now: Date.now(),
      });
      return session.ok && session.value.userId === input.userId
        ? { ok: true, value: null }
        : { ok: false, error: { code: "membership_ineligible" } };
    } catch {
      return { ok: false, error: { code: "authority_unavailable" } };
    }
  }

  async checkAuthority(
    input: Parameters<AccountPlatformAccess["checkAuthority"]>[0],
  ): ReturnType<AccountPlatformAccess["checkAuthority"]> {
    if (input.authority.organisationId !== this.organisationId)
      return { ok: false, error: { code: "scope_forbidden" } };
    switch (input.authority.kind) {
      case "control": {
        const userId = parseUserId(input.authority.userId);
        if (!userId.ok)
          return { ok: false, error: { code: "scope_forbidden" } };
        return this.checkUser({
          userId: userId.value,
          authority: input.userAuthority,
          action: input.action,
        });
      }
      case "direct_conversation":
      case "shared_conversation": {
        try {
          const row = await this.database
            .prepare(
              `SELECT user_id AS userId FROM service_role_grant
             WHERE organisation_id = ? AND person_id = ? AND role = ? AND status = 'active'`,
            )
            .bind(
              this.organisationId,
              input.authority.requesterPersonId,
              input.authority.role,
            )
            .first<{ userId: unknown }>();
          const userId =
            row === null || typeof row.userId !== "string"
              ? null
              : parseUserId(row.userId);
          if (userId === null || !userId.ok)
            return { ok: false, error: { code: "membership_ineligible" } };
          return this.checkUser({
            userId: userId.value,
            authority: input.userAuthority,
            action: input.action,
          });
        } catch {
          return { ok: false, error: { code: "authority_unavailable" } };
        }
      }
      case "workflow":
      case "agent_mailbox":
      case "whatsapp_support":
        return this.checkAutomation({
          authority: input.authority,
          action: input.action,
        });
      default:
        return assertNever(input.authority);
    }
  }

  async checkAutomation(
    input: Parameters<AccountPlatformAccess["checkAutomation"]>[0],
  ): ReturnType<AccountPlatformAccess["checkAutomation"]> {
    if (input.authority.organisationId !== this.organisationId)
      return { ok: false, error: { code: "scope_forbidden" } };
    const client = createAccountPlatformClient(this.env);
    if (!client.ok) return accessFailure(client.error);
    let native: Parameters<typeof resolveLinkedPantryAccountAutomation>[2];
    switch (input.authority.kind) {
      case "workflow":
        native = {
          kind: input.authority.kind,
          nativeId: input.authority.workflowId,
          revision: input.authority.workflowRevision,
        };
        break;
      case "agent_mailbox":
        native = {
          kind: input.authority.kind,
          nativeId: input.authority.mailboxBindingId,
          revision: input.authority.bindingRevision,
        };
        break;
      case "whatsapp_support":
        native = {
          kind: input.authority.kind,
          nativeId: input.authority.supportBindingId,
          revision: input.authority.bindingRevision,
        };
        break;
      default:
        return assertNever(input.authority);
    }
    const [nativeBinding, automation] = await Promise.all([
      readNativePantryAccountBinding(this.env, this.organisationId),
      resolveLinkedPantryAccountAutomation(
        this.env,
        this.organisationId,
        native,
      ),
    ]);
    if (!nativeBinding.ok) return accessFailure(nativeBinding.error);
    if (!automation.ok) return accessFailure(automation.error);
    const checked = await client.value.checkAutomation({
      binding: nativeBinding.value,
      automation: automation.value,
      action: input.action,
    });
    if (!checked.ok) return accessFailure(checked.error);
    if (checked.value.accessRevision !== automation.value.accessRevision) {
      return accessFailure({ code: "scope_forbidden" });
    }
    return {
      ok: true,
      value: { authorityRevision: checked.value.authorityRevision },
    };
  }
}

function accessFailure(
  error: AccountPlatformError,
): Result<never, AccountEligibilityFailure> {
  switch (error.code) {
    case "scope_forbidden":
    case "membership_ineligible":
    case "instance_ineligible":
    case "authority_unavailable":
      return { ok: false, error: { code: error.code } };
    default:
      return { ok: false, error: { code: "authority_unavailable" } };
  }
}

export type AccountConversationScope = ConversationScope &
  Readonly<{ accountAuthority: AccountUserAuthority }>;

export function authenticatedAccountConversationScope(
  organisationId: OrganisationId,
  session: ActiveControlSession,
): AccountConversationScope {
  return {
    organisationId,
    userId: session.userId,
    accountAuthority: {
      kind: "authenticated_session",
      nativeSessionId: session.controlSessionId,
    },
  };
}
