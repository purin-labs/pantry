import { Select } from "../../ui/select";
import React from "react";
import { MutationLedger } from "@purin-labs/control/portal/mutation-state";
import { ArchiveConfirm } from "./archive-confirm";
import type { Variant } from "@purin-labs/type-utils";
import {
  formatControlRole,
  isInvitationMutation,
  isMemberMutation,
  isOwnerMember,
  isPendingInvitation,
  mutationBlocked,
  renderMutationFeedback,
} from "./settings-support";
import type { OrganisationInvitation, OrganisationMember } from "@purin-labs/control-api/portal/settings";
import type { SettingsMouseHandler, SettingsMutationFeedback, SettingsSelectHandler, WorkspaceSettingsPageProps } from "./settings-types";

const INVITE_ROLES = [
  { value: "admin", label: "Admin" },
  { value: "operator", label: "Operator" },
  { value: "viewer", label: "Viewer" },
];
const MEMBER_ROLES = [{ value: "owner", label: "Owner" }, ...INVITE_ROLES];

export function WorkspaceSettingsPage(
  props: WorkspaceSettingsPageProps,
): React.ReactNode {
  const lifecycle =
    props.organisation.role === "owner" ? (
      <section
        className="portal-band danger-band"
        aria-labelledby="lifecycle-title"
      >
        <div>
          <h2 id="lifecycle-title">Archive workspace</h2>
          <p>
            Archiving disconnects Shopify, Stripe, and Slack immediately and
            stops workspace updates. You can restore the workspace until data
            deletion starts.
          </p>
        </div>
        {props.organisation.lifecycle === "archived" ? (
          <button
            type="button"
            onClick={props.actions.restoreOrganisation}
            disabled={mutationBlocked(props.mutations, {
              kind: "workspace_lifecycle",
            })}
          >
            Restore workspace
          </button>
        ) : (
          <ArchiveConfirm
            organisationName={props.organisation.name}
            busy={mutationBlocked(props.mutations, {
              kind: "workspace_lifecycle",
            })}
            onArchive={props.actions.archiveOrganisation}
          />
        )}
        {renderMutationFeedback(props.feedback, {
          kind: "workspace_lifecycle",
        })}
      </section>
    ) : null;
  return (
    <>
      <section className="portal-band" aria-labelledby="team-title">
        <div className="section-heading">
          <div>
            <h2 id="team-title">Members and roles</h2>
            <p>Workspace roles control setup and daily operations.</p>
          </div>
        </div>
        <div className="account-list">
          {renderOrganisationMembers(
            props.members,
            props.actions.changeMemberRole,
            props.actions.removeMember,
            props.mutations,
            props.pendingConfirm,
            props.requestConfirm,
            props.canManage,
            props.feedback,
          )}
        </div>
        {renderOrganisationInvitations(
          props.invitations,
          props.actions.revokeInvitation,
          props.mutations,
          props.pendingConfirm,
          props.requestConfirm,
          props.canManage,
          props.feedback,
        )}
        {props.canManage ? (
          <form className="inline-form" onSubmit={props.actions.inviteMember}>
            <label>
              <span>Google account email</span>
              <input name="email" type="email" required />
            </label>
            <label>
              <span>Role</span>
              <Select.Root name="role" items={INVITE_ROLES} defaultValue="operator">
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {INVITE_ROLES.map(renderRoleItem)}
                </Select.Popup>
              </Select.Root>
            </label>
            <button
              type="submit"
              className="connection-primary-action"
              disabled={mutationBlocked(props.mutations, {
                kind: "invite_member",
              })}
            >
              Invite member
            </button>
            {renderMutationFeedback(props.feedback, { kind: "invite_member" })}
            <p className="notice-text">
              Share the invitation link with the invited person. They must sign
              in with this Google account and accept the invitation. The link
              expires after 7 days.
            </p>
          </form>
        ) : null}
      </section>
      {props.canManage ? (props.operationalAreas ?? null) : null}
      {lifecycle}
    </>
  );
}

function renderOrganisationMembers(
  members: readonly OrganisationMember[],
  changeRole: SettingsSelectHandler,
  remove: SettingsMouseHandler,
  mutations: MutationLedger,
  pendingConfirm: string | null,
  requestConfirm: (key: string) => void,
  canManage: boolean,
  feedback: SettingsMutationFeedback,
): React.ReactNode {
  const ownerCount = members.filter(isOwnerMember).length;
  const controls = { mutations, pendingConfirm, requestConfirm, feedback };
  return members.map(
    renderOrganisationMember.bind(
      null,
      changeRole,
      remove,
      controls,
      canManage,
      ownerCount,
    ),
  );
}

function renderOrganisationMember(
  changeRole: SettingsSelectHandler,
  remove: SettingsMouseHandler,
  controls: {
    readonly mutations: MutationLedger;
    readonly pendingConfirm: string | null;
    readonly requestConfirm: (key: string) => void;
    readonly feedback: SettingsMutationFeedback;
  },
  canManage: boolean,
  ownerCount: number,
  member: OrganisationMember,
): React.ReactNode {
  const isFinalOwner = member.role === "owner" && ownerCount === 1;
  const rowBusy = isMemberMutation(controls.mutations, member.userId);
  return (
    <div className="account-row" key={member.userId}>
      <span>
        <strong>{member.displayName}</strong>
        <small>{member.email}</small>
        {canManage && isFinalOwner ? (
          <small>Keep at least one owner in this workspace.</small>
        ) : null}
      </span>
      {canManage ? (
        <div className="account-actions">
          <Select.Root
            items={MEMBER_ROLES}
            value={member.role}
            onValueChange={changeMemberRole.bind(
              null,
              changeRole,
              member.userId,
            )}
            disabled={rowBusy || isFinalOwner}
          >
            <Select.Trigger
              aria-label={`Role for ${member.displayName}`}
              data-control-identity-id={member.userId}
            >
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{MEMBER_ROLES.map(renderRoleItem)}</Select.Popup>
          </Select.Root>
          <ConfirmButton
            confirmKey={`member-remove:${member.userId}`}
            pendingConfirm={controls.pendingConfirm}
            requestConfirm={controls.requestConfirm}
            onConfirmed={remove}
            disabled={rowBusy || isFinalOwner}
            label="Remove member"
            confirmLabel="Confirm member removal"
            data={{ "control-identity-id": member.userId }}
          />
        </div>
      ) : (
        <span className="lifecycle">{formatControlRole(member.role)}</span>
      )}
      {renderMutationFeedback(controls.feedback, {
        kind: "member",
        userId: member.userId,
      })}
    </div>
  );
}

function renderOrganisationInvitations(
  invitations: readonly OrganisationInvitation[],
  revoke: SettingsMouseHandler,
  mutations: MutationLedger,
  pendingConfirm: string | null,
  requestConfirm: (key: string) => void,
  canManage: boolean,
  feedback: SettingsMutationFeedback,
): React.ReactNode {
  const pending = invitations.filter(isPendingInvitation);
  if (pending.length === 0) return null;
  const controls = { mutations, pendingConfirm, requestConfirm, feedback };
  return (
    <div className="account-list" aria-label="Pending invitations">
      {pending.map(
        renderOrganisationInvitationRow.bind(null, revoke, controls, canManage),
      )}
    </div>
  );
}

function renderOrganisationInvitationRow(
  revoke: SettingsMouseHandler,
  controls: {
    readonly mutations: MutationLedger;
    readonly pendingConfirm: string | null;
    readonly requestConfirm: (key: string) => void;
    readonly feedback: SettingsMutationFeedback;
  },
  canManage: boolean,
  invitation: Variant<OrganisationInvitation, "pending">,
): React.ReactNode {
  return (
    <div className="account-row" key={invitation.organisationInvitationId}>
      <span>
        <strong>{invitation.invitedEmail}</strong>
        <small>
          Pending {formatControlRole(invitation.role)} invitation · requires
          acceptance when they sign in with this Google account
        </small>
      </span>
      {canManage ? (
        <ConfirmButton
          confirmKey={`revoke:${invitation.organisationInvitationId}`}
          pendingConfirm={controls.pendingConfirm}
          requestConfirm={controls.requestConfirm}
          onConfirmed={revoke}
          disabled={isInvitationMutation(
            controls.mutations,
            invitation.organisationInvitationId,
          )}
          label="Revoke"
          confirmLabel="Confirm revoke"
          data={{ "invitation-id": invitation.organisationInvitationId }}
        />
      ) : null}
      {renderMutationFeedback(controls.feedback, {
        kind: "invitation",
        invitationId: invitation.organisationInvitationId,
      })}
    </div>
  );
}

export function ConfirmButton(props: {
  readonly confirmKey: string;
  readonly pendingConfirm: string | null;
  readonly requestConfirm: (key: string) => void;
  readonly onConfirmed: SettingsMouseHandler;
  readonly disabled: boolean;
  readonly label: string;
  readonly confirmLabel: string;
  readonly data: Readonly<Record<string, string>>;
}): React.ReactNode {
  const confirming = props.pendingConfirm === props.confirmKey;
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(props.data))
    attributes[`data-${key}`] = value;
  return (
    <button
      type="button"
      {...attributes}
      className={confirming ? "confirming" : undefined}
      aria-pressed={confirming}
      disabled={props.disabled}
      onClick={
        confirming
          ? runConfirmedAction.bind(null, props.onConfirmed)
          : requestButtonConfirm.bind(
              null,
              props.requestConfirm,
              props.confirmKey,
            )
      }
    >
      {confirming ? props.confirmLabel : props.label}
    </button>
  );
}

function ConfirmedAction(
  action: SettingsMouseHandler,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  void action(event);
}

function runConfirmedAction(
  action: SettingsMouseHandler,
  event: React.MouseEvent<HTMLButtonElement>,
): void {
  ConfirmedAction(action, event);
}

function requestButtonConfirm(
  request: (key: string) => void,
  key: string,
): void {
  request(key);
}

function renderRoleItem(
  role: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={role.value} value={role.value}>
      {role.label}
    </Select.Item>
  );
}

function changeMemberRole(
  changeRole: SettingsSelectHandler,
  userId: string,
  role: string | null,
): void {
  if (role !== null) void changeRole(userId, role);
}
