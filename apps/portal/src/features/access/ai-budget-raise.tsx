import React from "react";
import {
  PermissionRequestDialog,
  PantryMark,
  type PermissionRequestDecision,
  type PermissionRequestItem,
} from "../../ui";
import type { AiBudgetLimits, AiBudgetView } from "@seams/control-api/portal/ai-budget";
import { workspaceParty } from "./agent-permission-request";
import { AGENT_NAME } from "../../agent-name";
import type { AccessRouteTransport } from "@seams/control-api/portal/access-models";

type Props = Readonly<{
  organisationId: string;
  workspaceName: string;
  access: Pick<AccessRouteTransport, "readBudget" | "saveBudget">;
  onClose: () => void;
}>;

type Load =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; view: AiBudgetView }>
  | Readonly<{ kind: "saved"; limits: AiBudgetLimits }>
  | Readonly<{ kind: "failed"; message: string }>;

type Raise = Readonly<{
  id: keyof AiBudgetLimits;
  label: string;
  description: string;
  value: number;
}>;

/**
 * Opened from a Slack notice when a request stopped at an AI budget limit.
 * The owner or admin raises the limits in place; the new limits apply to
 * Slack threads and chats that start after the change.
 */
export function AiBudgetRaisePrompt(props: Props): React.ReactNode {
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [selected, setSelected] = React.useState<readonly string[] | null>(
    null,
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let current = true;
    props.access.readBudget(props.organisationId).then(
      (view) => current && setLoad({ kind: "ready", view }),
      (caught: unknown) =>
        current &&
        setLoad({
          kind: "failed",
          message:
            caught instanceof Error
              ? caught.message
              : "AI budget settings are unavailable.",
        }),
    );
    return () => {
      current = false;
    };
  }, [props.access, props.organisationId]);

  if (load.kind === "loading") return null;
  const raises = load.kind === "ready" ? raisesFor(load.view) : [];
  const chosen = selected ?? raises.map((raise) => raise.id);
  const items: PermissionRequestItem[] = raises.map((raise) => ({
    id: raise.id,
    label: raise.label,
    description: raise.description,
    required: false,
  }));
  const decision = decisionFor(load, raises, pending, error, props.onClose, {
    raise: async (ids) => {
      if (load.kind !== "ready") return false;
      setPending(true);
      setError(null);
      const limits = raisedLimits(load.view.limits, raises, ids);
      try {
        await props.access.saveBudget(
          props.organisationId,
          load.view.revision,
          limits,
        );
        setLoad({ kind: "saved", limits });
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "The AI budget could not be saved. Try again.",
        );
        return false;
      } finally {
        setPending(false);
      }
    },
  });
  return (
    <PermissionRequestDialog
      open
      onClose={props.onClose}
      requester={{ name: AGENT_NAME, icon: <PantryMark /> }}
      target={workspaceParty(props.workspaceName)}
      title="Raise the AI budget for new threads"
      subtitle={<>A request in Slack stopped at an AI budget limit.</>}
      scope={null}
      listHeading="Choose what to raise:"
      items={items}
      selectedIds={chosen}
      onSelectionChange={setSelected}
      decision={decision}
      footnote={
        <>
          New limits apply to Slack threads and chats that start after this
          change; a thread that stopped keeps its limits. You can change them
          in Access.
        </>
      }
      signedInAs={null}
    />
  );
}

function decisionFor(
  load: Exclude<Load, Readonly<{ kind: "loading" }>>,
  raises: readonly Raise[],
  pending: boolean,
  error: string | null,
  close: () => void,
  actions: Readonly<{ raise: (ids: readonly string[]) => Promise<boolean> }>,
): PermissionRequestDecision {
  const closeAction = { label: "Close", onSelect: close };
  const explain = (message: string): PermissionRequestDecision => ({
    kind: "explain",
    message,
    pending: null,
    error: null,
    primary: closeAction,
    secondary: null,
  });
  if (load.kind === "failed") return explain(load.message);
  if (load.kind === "saved")
    return explain(
      "The AI budget was raised. New threads and chats use the new limits.",
    );
  if (!load.view.canManage)
    return explain(
      "Only an owner or admin can raise the AI budget. Send them this page.",
    );
  if (raises.length === 0)
    return explain("Every AI budget limit is already at its maximum.");
  return {
    kind: "grant",
    allowLabel: "Raise",
    denyLabel: "Not now",
    pending: pending ? "allow" : null,
    error,
    onAllow: actions.raise,
    onDeny: close,
  };
}

/** Each limit below its maximum, doubled up to that maximum. */
function raisesFor(view: AiBudgetView): readonly Raise[] {
  const raises: Raise[] = [];
  const next = (key: keyof AiBudgetLimits) =>
    Math.min(view.maximum[key], view.limits[key] * 2);
  if (view.limits.maxTokens < view.maximum.maxTokens)
    raises.push({
      id: "maxTokens",
      label: `Tokens for each thread: ${count(view.limits.maxTokens)} to ${count(next("maxTokens"))}`,
      description: "Tokens count for a whole Slack thread or chat.",
      value: next("maxTokens"),
    });
  if (view.limits.maxWallMs < view.maximum.maxWallMs)
    raises.push({
      id: "maxWallMs",
      label: `Time for one request: ${duration(view.limits.maxWallMs)} to ${duration(next("maxWallMs"))}`,
      description: "Each request may run this long before Seams Pantry stops it.",
      value: Math.floor(next("maxWallMs") / 1000) * 1000,
    });
  if (view.limits.maxToolCalls < view.maximum.maxToolCalls)
    raises.push({
      id: "maxToolCalls",
      label: `Tool calls for each thread: ${count(view.limits.maxToolCalls)} to ${count(next("maxToolCalls"))}`,
      description: "Tool calls count for a whole Slack thread or chat.",
      value: next("maxToolCalls"),
    });
  return raises;
}

function raisedLimits(
  limits: AiBudgetLimits,
  raises: readonly Raise[],
  ids: readonly string[],
): AiBudgetLimits {
  const raised = { ...limits };
  for (const raise of raises)
    if (ids.includes(raise.id)) raised[raise.id] = raise.value;
  return raised;
}

function count(value: number): string {
  return value.toLocaleString("en-GB");
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds % 60 === 0
    ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}`
    : `${seconds} seconds`;
}
