import type { OrganisationDatabase } from "../database-handles";
import type {
  OrganisationAdmissionAction,
  OrganisationUserAuthority,
  RequestAuthority,
} from "@purin-labs/contracts";
import { assertNever, canonicalJson } from "@purin-labs/std";
import { parseControlSessionId, type OrganisationId } from "../ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import { resolveControlSessionById } from "../data/control-plane";
import type { ActiveControlSession } from "../data/control-plane";
import type { Env } from "../env";
import type { Result } from "../result";
import type { Variant } from "@purin-labs/type-utils";

export type { OrganisationAdmissionAction, OrganisationUserAuthority };

/** Live sessions are global records. Everything else is regional. */
export type OrganisationAccessBindings = Pick<Env, "DB">;

/** The placement under which the scope of this access was admitted. */
export type OrganisationAccessFence = Readonly<{
  placementEpoch: number;
  placementCellId: string;
  fenceToken: string;
}>;

export function acceptedExecutionAuthority(
  sessionId: string,
  turnId: string,
): OrganisationUserAuthority {
  return {
    kind: "accepted_execution",
    acceptedExecutionId: JSON.stringify([sessionId, turnId]),
  };
}

export type OrganisationAccessFailure = Readonly<{
  code:
    | "authority_unavailable"
    | "membership_ineligible"
    | "instance_ineligible"
    | "scope_forbidden";
}>;

type AccessAnswer = Promise<Result<null, OrganisationAccessFailure>>;

/**
 * Request eligibility of one Organisation (Plan 95). Each call reads the
 * current records: an earlier answer grants no later access. The access of
 * one read, `organisationAccessOfOneRead`, is the one exception: it holds an
 * answer for that read only.
 */
export interface OrganisationAccess {
  checkAuthority(
    input: Readonly<{
      authority: RequestAuthority;
      userAuthority: OrganisationUserAuthority;
      action: OrganisationAdmissionAction;
    }>,
  ): AccessAnswer;
  checkAutomation(
    input: Readonly<{
      authority: Variant<
        RequestAuthority,
        "workflow" | "agent_mailbox" | "whatsapp_support"
      >;
      action: OrganisationAdmissionAction;
    }>,
  ): AccessAnswer;
  checkUser(
    input: Readonly<{
      userId: UserId;
      authority: OrganisationUserAuthority;
      action: OrganisationAdmissionAction;
    }>,
  ): AccessAnswer;
}

export function createOrganisationAccess(
  env: OrganisationAccessBindings,
  organisationId: OrganisationId,
  database: OrganisationDatabase,
  fence: OrganisationAccessFence,
): OrganisationAccess {
  return new NativeOrganisationAccess(
    env,
    organisationId,
    database,
    fence,
    new Map(),
    "each_call",
  );
}

/**
 * The access of one read. One read asks the same question at several places:
 * the gate of its request, the authority of the person who reads and the
 * capability that the read needs. Here each question is asked one time, and
 * an answer that `access` received for this request less than
 * `READ_ANSWER_MS` ago is that answer.
 *
 * Give it the access of one request only. A caller that must see a change
 * between two of its own checks uses `access` itself, which asks each time.
 */
export function organisationAccessOfOneRead(
  access: OrganisationAccess,
): OrganisationAccess {
  return access instanceof NativeOrganisationAccess
    ? access.ofOneRead()
    : access;
}

/** How long one read may use an answer that its request already holds. */
const READ_ANSWER_MS = 5_000;

/**
 * A disclosure is answered from the person and the action, not from the
 * evidence id, so each label of a read is one question.
 */
function questionAuthority(authority: OrganisationUserAuthority): unknown {
  return authority.kind === "disclosure_recipient"
    ? { kind: authority.kind }
    : authority;
}

type AskedUserAnswers = Map<
  string,
  Readonly<{ at: number; answer: AccessAnswer }>
>;

/** The organisation fields that each check reads with its principal. */
const ORGANISATION_COLUMNS = `EXISTS (SELECT 1 FROM organisation_placement p
      WHERE p.organisation_id = ? AND p.status = 'active' AND p.placement_epoch = ?
        AND p.placement_cell_id = ? AND p.fence_token = ?) AS fenceCurrent,
    (SELECT o.status FROM organisation o WHERE o.organisation_id = ?) AS organisationStatus,
    (SELECT b.lifecycle FROM organisation_onboarding b WHERE b.organisation_id = ?) AS lifecycle`;

/**
 * The lifecycles of an Organisation that has ended. Each other lifecycle
 * admits a request. An archived Organisation stays eligible until its purge,
 * so that its owner can read it and restore it; the lifecycle checks of each
 * route and Actor refuse its other work. An archive writes the lifecycle, so
 * an Organisation with no lifecycle row was never archived.
 */
const ENDED_LIFECYCLES: ReadonlySet<unknown> = new Set(["purging", "purged"]);

/** An archived Organisation has the status `deleted` until its purge. */
const ELIGIBLE_STATUSES: ReadonlySet<unknown> = new Set(["active", "deleted"]);

type OrganisationRow = Readonly<{
  fenceCurrent: unknown;
  organisationStatus: unknown;
  lifecycle: unknown;
}>;

class NativeOrganisationAccess implements OrganisationAccess {
  constructor(
    private readonly env: OrganisationAccessBindings,
    private readonly organisationId: OrganisationId,
    private readonly database: OrganisationDatabase,
    private readonly fence: OrganisationAccessFence,
    /** What this access was asked, by question. Only one read reads it. */
    private readonly asked: AskedUserAnswers,
    private readonly asks: "each_call" | "one_time_for_one_read",
  ) {}

  ofOneRead(): OrganisationAccess {
    return new NativeOrganisationAccess(
      this.env,
      this.organisationId,
      this.database,
      this.fence,
      this.asked,
      "one_time_for_one_read",
    );
  }

  checkUser(
    input: Parameters<OrganisationAccess["checkUser"]>[0],
  ): AccessAnswer {
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
    input: Parameters<OrganisationAccess["checkUser"]>[0],
  ): AccessAnswer {
    // A disclosure label admits only a disclosure, and a provider event only
    // starts work.
    if (
      (input.authority.kind === "disclosure_recipient" &&
        input.action !== "disclose") ||
      (input.authority.kind === "authenticated_provider_event" &&
        input.action !== "execute")
    )
      return { ok: false, error: { code: "scope_forbidden" } };
    const [member, session] = await Promise.all([
      this.readMember(input.userId),
      this.nativeSession(input),
    ]);
    if (!member.ok) return member;
    if (!session.ok) return session;
    const role = member.value;
    // A viewer reads and replays. Only the other roles start work or restore.
    if (
      role === "viewer" &&
      input.action !== "disclose" &&
      input.action !== "replay"
    )
      return { ok: false, error: { code: "membership_ineligible" } };
    return { ok: true, value: null };
  }

  /** The active role of the person, read with the organisation in one statement. */
  private async readMember(
    userId: UserId,
  ): Promise<Result<string, OrganisationAccessFailure>> {
    try {
      const row = await this.database
        .withSession("first-primary")
        .prepare(
          `SELECT ${ORGANISATION_COLUMNS},
    (SELECT g.role FROM service_role_grant g
      WHERE g.organisation_id = ? AND g.user_id = ? AND g.status = 'active') AS role`,
        )
        .bind(...this.organisationBindings(), this.organisationId, userId)
        .first<OrganisationRow & { role: unknown }>();
      const organisation = organisationEligibility(row);
      if (!organisation.ok) return organisation;
      return typeof row?.role === "string"
        ? { ok: true, value: row.role }
        : { ok: false, error: { code: "membership_ineligible" } };
    } catch {
      return { ok: false, error: { code: "authority_unavailable" } };
    }
  }

  /** An authenticated session must still be this person's live session. */
  private async nativeSession(
    input: Parameters<OrganisationAccess["checkUser"]>[0],
  ): Promise<Result<null, OrganisationAccessFailure>> {
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
    input: Parameters<OrganisationAccess["checkAuthority"]>[0],
  ): AccessAnswer {
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

  /**
   * An automation acts while its own record is current: the enabled revision
   * of a workflow, or the current revision of a mailbox or support binding
   * whose integration account is active.
   */
  async checkAutomation(
    input: Parameters<OrganisationAccess["checkAutomation"]>[0],
  ): AccessAnswer {
    if (input.authority.organisationId !== this.organisationId)
      return { ok: false, error: { code: "scope_forbidden" } };
    let current: string;
    let bindings: readonly (string | number)[];
    switch (input.authority.kind) {
      case "workflow":
        current = `EXISTS (SELECT 1 FROM cue_subscription
          WHERE organisation_id = ? AND subscription_id = ? AND version = ? AND enabled = 1)
        OR EXISTS (SELECT 1 FROM schedule_binding
          WHERE organisation_id = ? AND binding_id = ? AND revision = ? AND enabled = 1)`;
        bindings = [
          this.organisationId,
          input.authority.workflowId,
          input.authority.workflowRevision,
          this.organisationId,
          input.authority.workflowId,
          input.authority.workflowRevision,
        ];
        break;
      case "agent_mailbox":
        current = `EXISTS (SELECT 1 FROM agent_mailbox_binding b
          JOIN integration_account a ON a.organisation_id = b.organisation_id
            AND a.integration_account_id = b.integration_account_id
          WHERE b.organisation_id = ? AND b.mailbox_binding_id = ?
            AND b.current_revision = ? AND a.lifecycle = 'active')`;
        bindings = [
          this.organisationId,
          input.authority.mailboxBindingId,
          input.authority.bindingRevision,
        ];
        break;
      case "whatsapp_support":
        current = `EXISTS (SELECT 1 FROM whatsapp_support_binding b
          JOIN integration_account a ON a.organisation_id = b.organisation_id
            AND a.integration_account_id = b.integration_account_id
          WHERE b.organisation_id = ? AND b.support_binding_id = ?
            AND b.current_revision = ? AND a.lifecycle = 'active')`;
        bindings = [
          this.organisationId,
          input.authority.supportBindingId,
          input.authority.bindingRevision,
        ];
        break;
      default:
        return assertNever(input.authority);
    }
    try {
      const row = await this.database
        .withSession("first-primary")
        .prepare(
          `SELECT ${ORGANISATION_COLUMNS}, (${current}) AS automationCurrent`,
        )
        .bind(...this.organisationBindings(), ...bindings)
        .first<OrganisationRow & { automationCurrent: unknown }>();
      const organisation = organisationEligibility(row);
      if (!organisation.ok) return organisation;
      return row?.automationCurrent === 1
        ? { ok: true, value: null }
        : { ok: false, error: { code: "membership_ineligible" } };
    } catch {
      return { ok: false, error: { code: "authority_unavailable" } };
    }
  }

  private organisationBindings(): readonly (string | number)[] {
    return [
      this.organisationId,
      this.fence.placementEpoch,
      this.fence.placementCellId,
      this.fence.fenceToken,
      this.organisationId,
      this.organisationId,
    ];
  }
}

/**
 * A placement that froze or moved since the scope was admitted leaves the
 * decision to the next placement. A suspended Organisation, and one that is
 * purging or purged, admits nobody.
 */
function organisationEligibility(
  row: OrganisationRow | null,
): Result<null, OrganisationAccessFailure> {
  if (row?.fenceCurrent !== 1)
    return { ok: false, error: { code: "authority_unavailable" } };
  if (
    !ELIGIBLE_STATUSES.has(row.organisationStatus) ||
    ENDED_LIFECYCLES.has(row.lifecycle)
  )
    return { ok: false, error: { code: "instance_ineligible" } };
  return { ok: true, value: null };
}

/**
 * The scope of a chat (`ConversationScope` of `chat/store.ts`) with the
 * authority of the person who reads it.
 */
export type AuthorizedConversationScope = Readonly<{
  organisationId: OrganisationId;
  userId: UserId;
  accountAuthority: OrganisationUserAuthority;
}>;

export function authenticatedConversationScope(
  organisationId: OrganisationId,
  session: ActiveControlSession,
): AuthorizedConversationScope {
  return {
    organisationId,
    userId: session.userId,
    accountAuthority: {
      kind: "authenticated_session",
      nativeSessionId: session.controlSessionId,
    },
  };
}
