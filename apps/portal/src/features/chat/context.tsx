import React from "react";
import { Popover } from "@base-ui/react/popover";
import { Box, ChevronDown, ShieldCheck, X } from "lucide-react";
import { assertNever } from "@purin-labs/std";
import {
  navigationGroupTitle,
  type WorkspaceNavigationGroupName,
} from "@purin-labs/ui/route";
import type {
  Project,
  ProjectDirectory,
  ProjectSnapshot,
  ChatContextDetails,
} from "@purin-labs/control-api";
import type { Chat } from "@purin-labs/control-api/portal/chat";
import { bakerySurfaceForOrganisation } from "@purin-labs/area-kitchen/ui/features/bakery-surface-registry";
import { useScreenChipDecision } from "./screen-chip";
import { KITCHEN_SURFACE } from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";

export type ChatWorkspaceContext = Readonly<{
  organisation: string;
  workspace: string;
  area: WorkspaceNavigationGroupName;
  view: string;
}>;

/**
 * Whether the next message lets the agent load Kitchen. The composer
 * chip decides (Plan 87 phase 2): with the chip off on the Kitchen page, the
 * message keeps the Kitchen out.
 */
type ChatBakeryContext = "included" | "excluded";

type Props = Readonly<{
  organisationId: string;
  context: ChatWorkspaceContext;
  conversation: Chat | null;
  projects: ProjectDirectory | null;
}>;

export function ChatContextChip({
  organisationId,
  context,
  conversation,
  projects,
}: Props): React.ReactNode {
  const chip = useScreenChipDecision(conversation);
  const bakery: ChatBakeryContext =
    chip.screen?.page === KITCHEN_SURFACE && !chip.attached
      ? "excluded"
      : "included";
  const observations = confirmedContexts(conversation);
  const active = activeConfirmedContext(observations, conversation);
  const label = confirmedContextLabel(active, organisationId, bakery);
  const projectState = projectContextState(conversation, projects);
  const projectLabel =
    projectState.kind === "pending"
      ? "Context updates with the next message"
      : projectState.desired?.name;
  return (
    <Popover.Root>
      <Popover.Trigger
        className="chat-context-chip"
        aria-label={`Chat context: ${projectLabel === undefined ? label : `${label} · ${projectLabel}`}`}
      >
        <span>
          {projectLabel === undefined ? label : `${label} · ${projectLabel}`}
        </span>
        <ChevronDown size={13} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          sideOffset={8}
          align="start"
          collisionPadding={12}
          collisionAvoidance={{ side: "flip", align: "shift" }}
          className="chat-context-positioner"
        >
          <Popover.Popup className="chat-context-popup">
            <div className="chat-context-heading">
              <Popover.Title>Chat context</Popover.Title>
              <Popover.Close aria-label="Close chat context">
                <X size={15} aria-hidden="true" />
              </Popover.Close>
            </div>
            <p className="chat-context-scope">
              {context.organisation} · {context.workspace}
            </p>
            <dl>
              <dt>Current view</dt>
              <dd>
                {navigationGroupTitle(context.area)} · {context.view}
              </dd>
            </dl>
            {active !== null ? (
              <dl aria-live="polite">
                <dt>Active work</dt>
                <dd>{label}</dd>
              </dl>
            ) : null}
            {observations
              .filter(isSourceObservation)
              .slice(-8)
              .map(renderSourceObservation)}
            {active?.kind === "failed" || active?.kind === "cancelled" ? (
              <p role="status">{active.message}</p>
            ) : null}
            <p className="chat-context-source">
              <Box size={14} aria-hidden="true" />
              <span>{bakeryContextDescription(bakery)}</span>
            </p>
            {renderProjectContext(conversation, projects)}
            <p className="chat-context-source">
              <ShieldCheck size={14} aria-hidden="true" />
              <span>Workspace permissions apply</span>
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function confirmedContexts(
  conversation: Chat | null,
): readonly ChatContextDetails[] {
  if (conversation === null) return [];
  const requestId =
    conversation.work.kind === "ready"
      ? latestUserRequestId(conversation.timeline)
      : conversation.work.requestId;
  const contexts: Readonly<{
    createdAt: number;
    details: ChatContextDetails;
  }>[] = [];
  for (const event of conversation.timeline) {
    if (
      event.requestId === requestId &&
      (event.kind === "context" ||
        event.kind === "activity" ||
        event.kind === "progress") &&
      event.contextDetails !== undefined
    )
      contexts.push({
        createdAt: event.createdAt,
        details: event.contextDetails,
      });
  }
  return contexts.sort(compareContextTime).map(contextDetails);
}

function compareContextTime(
  first: Readonly<{ createdAt: number }>,
  second: Readonly<{ createdAt: number }>,
): number {
  return first.createdAt - second.createdAt;
}
function contextDetails(
  context: Readonly<{ details: ChatContextDetails }>,
): ChatContextDetails {
  return context.details;
}

function latestUserRequestId(timeline: Chat["timeline"]): string | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1)
    if (timeline[index]?.kind === "user") return timeline[index]?.requestId;
  return undefined;
}

function activeConfirmedContext(
  contexts: readonly ChatContextDetails[],
  conversation: Chat | null,
): ChatContextDetails | null {
  const terminal = new Set<string>();
  let latest: ChatContextDetails | null = null;
  for (const context of [...contexts].reverse()) {
    if (context.kind !== "observed" && context.kind !== "preparing")
      terminal.add(context.effectId);
    if (
      context.kind === "preparing" &&
      !terminal.has(context.effectId) &&
      conversation?.work.kind === "running"
    )
      return context;
    if (context.kind === "preparing") continue;
    if (latest === null) latest = context;
  }
  return latest;
}

function confirmedContextLabel(
  context: ChatContextDetails | null,
  organisationId: string,
  bakery: ChatBakeryContext,
): string {
  if (context === null) return "Workspace";
  switch (context.kind) {
    case "preparing":
      return "Loading Kitchen…";
    case "failed":
      return "Kitchen unavailable";
    case "cancelled":
      return "Kitchen cancelled";
    case "observed":
      return navigationGroupTitle(context.area);
    case "ready": {
      if (bakery === "excluded") return "Kitchen excluded";
      const surface = bakerySurfaceForOrganisation(organisationId);
      return surface !== null &&
        surface.surfaceSessionId() === context.surfaceSessionId &&
        surface.surfaceEpoch() === context.surfaceEpoch
        ? "Kitchen"
        : "Kitchen stale";
    }
    default:
      return assertNever(context);
  }
}

function isSourceObservation(
  context: ChatContextDetails,
): context is Variant<ChatContextDetails, "observed"> {
  return context.kind === "observed";
}

function renderSourceObservation(
  context: Variant<ChatContextDetails, "observed">,
): React.ReactNode {
  const source = context.source;
  const stale =
    source.origin !== "saved" && Date.now() - source.observedAt > 5 * 60_000;
  return (
    <dl key={`${source.id}:${source.digest}`}>
      <dt>
        {navigationGroupTitle(context.area)} · {source.origin}
        {stale ? " · stale" : ""}
      </dt>
      <dd>
        {source.id}
        <br />
        Revision {source.revision}
        <br />
        Digest {source.digest.slice(0, 12)} · observed{" "}
        {new Date(source.observedAt).toLocaleTimeString()}
      </dd>
    </dl>
  );
}

function bakeryContextDescription(context: ChatBakeryContext): string {
  switch (context) {
    case "included":
      return "Kitchen may load on demand for this workspace";
    case "excluded":
      return "Kitchen context excluded from your next message";
    default:
      return assertNever(context, "Unknown Kitchen attachment state");
  }
}

type ProjectContextState = Readonly<{ desired: Project | null }> &
  (
    | Readonly<{
        kind: "next_message" | "preparing" | "failed";
        snapshot: null;
      }>
    | Readonly<{
        kind: "accepted" | "pending";
        snapshot: ProjectSnapshot;
      }>
  );
function projectContextState(
  conversation: Chat | null,
  projects: ProjectDirectory | null,
): ProjectContextState {
  if (conversation === null)
    return { kind: "next_message", desired: null, snapshot: null };
  const placement = conversation.placement;
  const snapshot = conversation.projectContext;
  const applied = snapshot?.layer;
  const desired =
    placement === undefined || placement === null
      ? null
      : (projects?.projects.find(
          projectWithId.bind(null, placement.projectId),
        ) ?? null);
  const active =
    conversation.work.kind === "running" ||
    conversation.work.kind === "cancelling";
  const changed =
    placement !== null &&
    (applied?.membershipRevision !== placement.membershipRevision ||
      (applied?.kind === "project" &&
        applied.contentRevision !== desired?.contentRevision));
  if (changed && snapshot !== null)
    return { kind: "pending", desired, snapshot };
  if (active && snapshot === null)
    return { kind: "preparing", desired, snapshot };
  if (conversation.work.kind === "failed" && snapshot === null)
    return { kind: "failed", desired, snapshot };
  if (snapshot === null) return { kind: "next_message", desired, snapshot };
  return { kind: "accepted", desired, snapshot };
}
function projectStateDescription(state: ProjectContextState): string {
  switch (state.kind) {
    case "pending":
      return "Project context updates with the next message.";
    case "preparing":
      return "Preparing project context…";
    case "failed":
      return "Project context preparation did not finish. Retry the message.";
    case "next_message":
      return state.desired === null
        ? "Your next message will use workspace context."
        : "Your next message will use this project’s brief and references.";
    case "accepted":
      return "Context for the latest message is ready.";
    default:
      return assertNever(state);
  }
}
function renderProjectContext(
  conversation: Chat | null,
  projects: ProjectDirectory | null,
): React.ReactNode {
  if (conversation === null) return null;
  const state = projectContextState(conversation, projects);
  const applied = state.snapshot?.layer;
  return (
    <section className="project-context" aria-label="Project context">
      <strong>Project: {state.desired?.name ?? "Default project"}</strong>
      <p role="status">{projectStateDescription(state)}</p>
      {applied?.kind === "project" &&
      applied.references.some(isUnavailableReference) ? (
        <p role="note">Some project references are unavailable.</p>
      ) : null}
      {state.kind === "pending" ? (
        <p>
          {state.desired === null
            ? "Your next message will stop using the previous project’s brief and references."
            : `Your next message will use ${state.desired.name}’s brief and references in place of the previous project’s context.`}
        </p>
      ) : null}
      <p>
        Messages, attachments, and findings stay with this chat. Linked sources
        are read when needed, with your workspace permissions.
      </p>
    </section>
  );
}
function isUnavailableReference(
  observation: Variant<
    NonNullable<ProjectSnapshot["layer"]>,
    "project"
  >["references"][number],
): boolean {
  return observation.kind !== "available";
}
function projectWithId(id: string, project: { id: string }): boolean {
  return project.id === id;
}
