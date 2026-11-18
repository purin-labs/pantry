import type { ConversationId, ProjectId } from "@seams/control-api";
declare const fixtureProject: ProjectId;
declare const fixtureConversation: ConversationId;
import type {
  ChatPlacement,
  ChatDestination,
  ChatInsertion,
} from "@seams/control-api";
// @ts-expect-error A chat placement names its Project.
const missingProject: ChatPlacement = { membershipRevision: 1, position: 0 };
// @ts-expect-error No placement stands outside a Project.
const ungrouped: ChatPlacement = { kind: "ungrouped", position: 0 };
// @ts-expect-error A destination names a Project.
const nowhere: ChatDestination = {};
// @ts-expect-error End insertion cannot also name an anchor.
const anchor: ChatInsertion = { kind: "end", conversationId: fixtureConversation };
void missingProject;
void ungrouped;
void nowhere;
void anchor;
void fixtureProject;

import type {
  ProjectLayer,
  ProjectReferenceObservation,
} from "@seams/control-api";
// @ts-expect-error A project layer requires its content and membership revisions.
const missingLayer: ProjectLayer = { kind: "project", projectId: fixtureProject };
const inherited = {
  kind: "project",
  projectId: fixtureProject,
  membershipRevision: 1,
  contentRevision: 1,
  name: "Bakery",
  brief: "Capacity",
  references: [],
} as const;
// @ts-expect-error A broad spread cannot keep inherited content in a withheld layer.
const staleLayer: ProjectLayer = { ...inherited, kind: "withheld" };
// @ts-expect-error A withheld layer still names the Project.
const unplacedLayer: ProjectLayer = { kind: "withheld", membershipRevision: 1 };
// @ts-expect-error An unavailable observation cannot claim a source revision.
const unavailableRevision: ProjectReferenceObservation = {
  kind: "unavailable",
  reference: { kind: "bakery_run", id: "a".repeat(64), label: "Run" },
  observedAt: 1,
  reason: "Revoked",
  revision: "1",
};
void missingLayer;
void staleLayer;
void unplacedLayer;
void unavailableRevision;
