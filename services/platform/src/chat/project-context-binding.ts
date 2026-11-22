import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { ProjectSnapshot } from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import {
  prepareProjectSnapshot,
  type ProjectSnapshotPlacement,
} from "../projects/context";
import { readDefaultProjectId } from "../projects/case-project";
import type { ConversationScope, StoredConversation } from "./store";
import type { Conversation } from "./conversation";
import { chatOriginField } from "./origin";
import type {
  ChatInputPart,
  ChatTimelineEvent,
  PendingChatInput,
} from "./timeline";

export function bindConversationProjectSnapshot(
  conversation: Conversation,
  requestId: string,
  snapshot: ProjectSnapshot,
): Conversation {
  const timeline = conversation.timeline.map(
    bindTimelineInput.bind(null, requestId, snapshot),
  );
  const prior = previousProjectSnapshot(conversation, requestId);
  if (
    hasNewTimelineBinding(conversation, requestId) &&
    projectInheritanceChanged(prior, snapshot)
  ) {
    const sequence = conversation.latestSequence + 1;
    timeline.push({
      kind: "activity",
      eventId: `project_context_${requestId}`,
      requestId,
      sequence,
      createdAt: snapshot.observedAt,
      text: projectTransitionText(prior, snapshot),
    });
  }
  return {
    lineage: conversation.lineage,
    historyBindings: conversation.historyBindings,
    id: conversation.id,
    title: conversation.title,
    modelRoute: conversation.modelRoute,
    documents: conversation.documents,
    work: conversation.work,
    completedRequests: conversation.completedRequests,
    timeline,
    pendingInputs: conversation.pendingInputs.map(
      bindPendingInput.bind(null, requestId, snapshot),
    ),
    latestSequence: timeline.at(-1)?.sequence ?? conversation.latestSequence,
    lastReadSequence: conversation.lastReadSequence,
    surfaceEventCursor: conversation.surfaceEventCursor,
    draftText: conversation.draftText,
    draftUpdatedAt: conversation.draftUpdatedAt,
    effort: conversation.effort,
    ...chatOriginField(conversation.origin),
  };
}
function bindTimelineInput(
  requestId: string,
  snapshot: ProjectSnapshot,
  event: ChatTimelineEvent,
): ChatTimelineEvent {
  if (
    event.kind !== "user" ||
    event.requestId !== requestId ||
    projectSnapshotFromParts(event.parts) !== null
  )
    return event;
  return {
    kind: "user",
    eventId: event.eventId,
    requestId: event.requestId,
    sequence: event.sequence,
    createdAt: event.createdAt,
    text: event.text,
    parts: [...event.parts, { kind: "project_context", snapshot }],
  };
}
function bindPendingInput(
  requestId: string,
  snapshot: ProjectSnapshot,
  input: PendingChatInput,
): PendingChatInput {
  if (
    input.requestId !== requestId ||
    projectSnapshotFromParts(input.parts) !== null
  )
    return input;
  return {
    inputId: input.inputId,
    requestId: input.requestId,
    mode: input.mode,
    parts: [...input.parts, { kind: "project_context", snapshot }],
    acceptedAt: input.acceptedAt,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  };
}
export function projectSnapshotFromParts(
  parts: readonly ChatInputPart[],
): ProjectSnapshot | null {
  for (const part of parts)
    if (part.kind === "project_context") return part.snapshot;
  return null;
}
export function currentProjectSnapshot(
  conversation: Conversation,
): ProjectSnapshot | null {
  for (let index = conversation.timeline.length - 1; index >= 0; index -= 1) {
    const event = conversation.timeline[index];
    if (
      event?.kind === "user" &&
      (conversation.work.kind === "ready" ||
        conversation.work.kind === "failed" ||
        event.requestId === conversation.work.requestId)
    )
      return projectSnapshotFromParts(event.parts);
  }
  return null;
}
export function conversationProjectSnapshots(
  conversation: Conversation,
): readonly ProjectSnapshot[] {
  const snapshots: ProjectSnapshot[] = [];
  for (const event of conversation.timeline)
    if (event.kind === "user") appendSnapshot(snapshots, event.parts);
  for (const input of conversation.pendingInputs)
    appendSnapshot(snapshots, input.parts);
  return snapshots;
}
function appendSnapshot(
  snapshots: ProjectSnapshot[],
  parts: readonly ChatInputPart[],
): void {
  const snapshot = projectSnapshotFromParts(parts);
  if (snapshot !== null) snapshots.push(snapshot);
}

export async function bindAdmittedProjectContext(
  env: Env,
  execution: OrganisationExecutionScope,
  scope: ConversationScope,
  stored: StoredConversation | null,
  conversation: Conversation,
  requestId: string,
): Promise<Conversation> {
  for (const event of conversation.timeline)
    if (
      event.kind === "user" &&
      event.requestId === requestId &&
      projectSnapshotFromParts(event.parts) !== null
    )
      return conversation;
  for (const input of conversation.pendingInputs)
    if (
      input.requestId === requestId &&
      projectSnapshotFromParts(input.parts) !== null
    )
      return conversation;
  return bindConversationProjectSnapshot(
    conversation,
    requestId,
    await prepareProjectSnapshot(
      env,
      execution,
      scope,
      stored === null
        ? await newConversationPlacement(execution)
        : storedProjectPlacement(stored),
    ),
  );
}

export function storedProjectPlacement(
  stored: Pick<StoredConversation, "placement" | "inheritsProject">,
): ProjectSnapshotPlacement {
  return {
    projectId: stored.placement.projectId,
    membershipRevision: stored.placement.membershipRevision,
    inherits: stored.inheritsProject,
  };
}

// A chat created by this input joins the Organisation's default Project, and
// saving pins it to the Project named here.
async function newConversationPlacement(
  execution: OrganisationExecutionScope,
): Promise<ProjectSnapshotPlacement> {
  const projectId = await readDefaultProjectId(
    execution.database,
    execution.organisationId,
  );
  if (projectId === null) throw new Error("default_project_unavailable");
  return { projectId, membershipRevision: 1, inherits: true };
}

function hasNewTimelineBinding(
  conversation: Conversation,
  requestId: string,
): boolean {
  for (const event of conversation.timeline)
    if (event.kind === "user" && event.requestId === requestId)
      return projectSnapshotFromParts(event.parts) === null;
  return false;
}
function projectInheritanceChanged(
  previous: ProjectSnapshot | null,
  current: ProjectSnapshot,
): boolean {
  const before = previous?.layer;
  const after = current.layer;
  if (before === undefined) return after.kind === "project";
  // Moving between Projects the member reads nothing from changes no inheritance.
  if (before.kind === "withheld" && after.kind === "withheld") return false;
  if (
    before.kind !== after.kind ||
    before.membershipRevision !== after.membershipRevision
  )
    return true;
  return (
    before.kind === "project" &&
    after.kind === "project" &&
    before.contentRevision !== after.contentRevision
  );
}
function projectTransitionText(
  previous: ProjectSnapshot | null,
  current: ProjectSnapshot,
): string {
  const before = previous?.layer;
  const after = current.layer;
  const changes: string[] = [];
  if (after.kind === "project")
    changes.push(
      `Accepted ${after.name} brief and reference index (revision ${after.contentRevision}).`,
    );
  if (
    before?.kind === "project" &&
    (after.kind === "withheld" || after.projectId !== before.projectId)
  )
    changes.push(`Removed ${before.name} inheritance.`);
  changes.push("Chat requests, attachments, and accepted findings retained.");
  return changes.join(" ");
}

function previousProjectSnapshot(
  conversation: Conversation,
  requestId: string,
): ProjectSnapshot | null {
  for (let index = conversation.timeline.length - 1; index >= 0; index -= 1) {
    const event = conversation.timeline[index];
    if (event?.kind !== "user" || event.requestId === requestId) continue;
    const snapshot = projectSnapshotFromParts(event.parts);
    if (snapshot !== null) return snapshot;
  }
  return null;
}
