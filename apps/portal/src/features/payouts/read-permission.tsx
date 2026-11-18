/**
 * Lets an owner or admin allow supplier payout reads for their own role, in
 * place on the Suppliers page. Allow turns the capability on and grants it
 * to the role through the same Access mutations as the Access page; nothing
 * else changes. A Slack channel still needs a grant of its own.
 */
import React from "react";
import { Users } from "lucide-react";

import type {
  AccessControlOption,
  AccessRouteTransport,
} from "@seams/control-api/portal/access-models";
import { workspaceParty } from "../access/agent-permission-request";
import {
  accessErrorMessage,
  createGrants,
  enableCapabilities,
} from "../access/permission-enable";
import { PermissionRequestDialog } from "../../ui";

export type PayoutReadRole = "owner" | "admin";

export type PayoutReadAccess = Pick<
  AccessRouteTransport,
  "read" | "readOptions" | "mutate"
>;

const PAYOUT_READ = {
  capabilityId: "commerce.supplier_payout.read",
  capabilityVersion: 1,
  label: "Read supplier payouts",
} as const;

/** The subject labels of the Access page's grant dialog. */
const ROLE_SUBJECT: Readonly<Record<PayoutReadRole, string>> = {
  owner: "Owner role",
  admin: "Admin role",
};

export function PayoutReadPermission(props: {
  readonly organisationId: string;
  readonly workspaceName: string;
  readonly role: PayoutReadRole;
  readonly access: PayoutReadAccess;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Runs after the role may read payouts. */
  readonly onAllowed: () => void;
}): React.ReactNode {
  const [pending, setPending] = React.useState<"allow" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const { organisationId, role, access, onAllowed } = props;

  const allow = React.useCallback(async (): Promise<boolean> => {
    setPending("allow");
    setError(null);
    try {
      const failure = await allowPayoutReads(access, organisationId, role);
      if (failure !== null) {
        setError(failure);
        return false;
      }
      onAllowed();
      return true;
    } finally {
      setPending(null);
    }
  }, [access, organisationId, role, onAllowed]);

  return (
    <PermissionRequestDialog
      open={props.open}
      onClose={props.onClose}
      requester={{
        name: ROLE_SUBJECT[role],
        icon: <Users aria-hidden="true" />,
      }}
      target={workspaceParty(props.workspaceName)}
      title={`Allow the ${ROLE_SUBJECT[role]} to read supplier payouts?`}
      subtitle={`Every ${role} will see what ${props.workspaceName} pays its suppliers, here and in direct messages with Sous Chef in Slack.`}
      scope={null}
      listHeading="This will:"
      items={[
        {
          id: PAYOUT_READ.capabilityId,
          label: PAYOUT_READ.label,
          description: `Turn on payout reads and grant them to the ${ROLE_SUBJECT[role]}. A Slack channel still needs its own grant.`,
          required: true,
        },
      ]}
      selectedIds={[PAYOUT_READ.capabilityId]}
      onSelectionChange={ignoreSelection}
      decision={{
        kind: "grant",
        allowLabel: "Allow",
        denyLabel: "Not now",
        pending,
        error,
        onAllow: allow,
        onDeny: props.onClose,
      }}
      footnote="You can take this away on the Access page."
      signedInAs={null}
    />
  );
}

/**
 * Turns payout reads on and grants them to the role. Returns an error
 * message, or null when the role may read payouts.
 */
async function allowPayoutReads(
  access: PayoutReadAccess,
  organisationId: string,
  role: PayoutReadRole,
): Promise<string | null> {
  const enabled = await enableCapabilities(access, organisationId, [
    PAYOUT_READ,
  ]);
  if (enabled !== null) return enabled;
  const subjects = await access.readOptions(
    organisationId,
    "subjects",
    ROLE_SUBJECT[role].toLowerCase(),
    null,
    null,
  );
  if (!subjects.ok) return accessErrorMessage(subjects.error);
  const subject = subjects.value.items.find(
    isRoleSubject.bind(null, ROLE_SUBJECT[role]),
  );
  if (subject === undefined || subject.revision === null)
    return "Your role is not available in Access settings. Refresh and try again.";
  return createGrants(access, organisationId, [
    {
      subjectRef: { subjectRefId: subject.refId, revision: subject.revision },
      target: {
        kind: "platform",
        capabilityRef: {
          capabilityId: PAYOUT_READ.capabilityId,
          capabilityVersion: PAYOUT_READ.capabilityVersion,
        },
      },
    },
  ]);
}

function isRoleSubject(label: string, option: AccessControlOption): boolean {
  return option.kind === "organisation_role" && option.label === label;
}

function ignoreSelection(): void {}
