/**
 * Shown in place when an action is refused for a permission that the person
 * lacks. An owner or admin allows it here, through the same Access mutations
 * as the Access page: Allow switches the capability on when it is off and
 * adds the grant that the refusal named. The action then runs again. A
 * member who cannot change Access sees who must allow it.
 */
import React from "react";
import { UserRound } from "lucide-react";
import {
  parsePermissionRequiredProblem,
  type PermissionRequired,
} from "@purin-labs/control-api";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "@purin-labs/control/portal/control-client";
import {
  PermissionRequestDialog,
  PantryMark,
  type PermissionRequestDecision,
} from "../../ui";
import { createAccessRouteTransport } from "./api";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";
import {
  createGrants,
  enableCapabilities,
  mayEnableEvery,
} from "./permission-enable";

type Props = Readonly<{
  organisationId: string;
  permission: PermissionRequired;
  /** The refused action, as on its button: "Send for approval". */
  action: string;
  /** What a grant covers, as "for this product only". */
  grantScope: string;
  onAllowed: () => void;
  onClose: () => void;
  access?: Pick<AccessRouteTransport, "read" | "mutate">;
}>;

type Authority = "loading" | "grant" | "explain";

/** The permission that a refused control request names, if any. */
export function permissionRequiredOf(
  caught: unknown,
): PermissionRequired | null {
  return caught instanceof ControlApiError
    ? parsePermissionRequiredProblem(caught.details)
    : null;
}

const ACCESS = createAccessRouteTransport(
  controlRead,
  controlMutation,
  noGoogleDrivePicker,
);

export function PermissionRequiredPrompt(props: Props): React.ReactNode {
  const { organisationId, permission, onAllowed } = props;
  const access = props.access ?? ACCESS;
  const [authority, setAuthority] = React.useState<Authority>("loading");
  const [pending, setPending] = React.useState<"allow" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let current = true;
    void access.read(organisationId, null, null).then((result) => {
      if (current)
        setAuthority(
          result.ok && mayEnableEvery(result.value, [permission])
            ? "grant"
            : "explain",
        );
    });
    return () => {
      current = false;
    };
  }, [access, organisationId, permission]);

  const allow = React.useCallback(async (): Promise<boolean> => {
    setPending("allow");
    setError(null);
    try {
      const failure =
        (await enableCapabilities(access, organisationId, [permission])) ??
        (permission.grant === null
          ? null
          : await createGrants(access, organisationId, [permission.grant]));
      if (failure !== null) {
        setError(failure);
        return false;
      }
      onAllowed();
      return true;
    } finally {
      setPending(null);
    }
  }, [access, organisationId, permission, onAllowed]);

  const label = lowerFirst(permission.label);
  const decision: PermissionRequestDecision =
    authority === "explain"
      ? {
          kind: "explain",
          message: `Ask an owner or admin of this workspace to allow you to ${label}. Only they can allow it.`,
          pending: null,
          error: null,
          primary: { label: "Close", onSelect: props.onClose },
          secondary: null,
        }
      : {
          kind: "grant",
          pending: authority === "loading" ? "allow" : pending,
          error,
          onAllow: allow,
          onDeny: props.onClose,
          denyLabel: "Cancel",
        };
  return (
    <PermissionRequestDialog
      open={true}
      onClose={props.onClose}
      requester={{ name: "You", icon: <UserRound aria-hidden="true" /> }}
      target={{ name: "Purin Pantry", icon: <PantryMark /> }}
      title={`${props.action} needs permission to ${label}`}
      subtitle={subtitle(permission, props.grantScope)}
      scope={null}
      listHeading="This will allow you to:"
      items={[
        {
          id: permission.capabilityId,
          label: permission.label,
          description: permission.description,
          required: true,
        },
      ]}
      selectedIds={[permission.capabilityId]}
      onSelectionChange={ignoreSelection}
      decision={decision}
      footnote={footnote(permission)}
      signedInAs={null}
    />
  );
}

function subtitle(permission: PermissionRequired, grantScope: string): string {
  return permission.grant === null
    ? "Allow turns this on for the whole workspace, then tries again."
    : `Allow gives you this permission ${grantScope}, then tries again.`;
}

function footnote(permission: PermissionRequired): string | null {
  if (permission.mode === "enabled") return null;
  return permission.grant === null
    ? "Every role that holds this permission can then use it. You can turn it off again in Access."
    : "Allow also turns this on for the whole workspace. You can change both in Access.";
}

function noGoogleDrivePicker(): Promise<null> {
  return Promise.resolve(null);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function ignoreSelection(): void {
  // The single item is required, so the selection cannot change.
}
