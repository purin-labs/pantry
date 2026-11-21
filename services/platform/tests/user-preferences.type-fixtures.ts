import type {
  UserId,
  ConversationId,
  ProjectId,
  UserPreferenceDocument,
  UserPreferenceEdit,
  AppearanceOverride,
} from "@purin-labs/control-api";
import type {
  OrganisationId,
  WorkspaceId,
  PersonId,
  ControlSessionId,
} from "../src/ids";

declare const organisation: OrganisationId;
declare const workspace: WorkspaceId;
declare const person: PersonId;
declare const session: ControlSessionId;
declare const conversation: ConversationId;
declare const user: UserId;
// @ts-expect-error Organisation identities cannot own user preferences.
const organisationUser: UserId = organisation;
// @ts-expect-error Workspace identities cannot own user preferences.
const workspaceUser: UserId = workspace;
// @ts-expect-error Person identities are scoped to a workspace.
const personUser: UserId = person;
// @ts-expect-error Session identities cannot identify account owners.
const sessionUser: UserId = session;
// @ts-expect-error Conversation identities cannot identify projects.
const wrongProject: ProjectId = conversation;
// @ts-expect-error Raw JSON strings require a boundary parser.
const rawUser: UserId = "user_00000000-0000-0000-0000-000000000001";
const envelope = {
  userId: user,
  schemaVersion: 1,
  revision: 1,
  updatedAt: 0,
} as const;
const invalidDocument: UserPreferenceDocument = {
  ...envelope,
  area: "appearance",
  // @ts-expect-error A broad spread cannot pair appearance with chat values.
  values: { dockedPanelWidthPx: 600, fullscreenSidebarWidthPx: 360 },
};
// @ts-expect-error A chat command cannot address Kitchen.
const invalidCommand: UserPreferenceEdit = {
  area: "bakeryos",
  command: { kind: "set_docked_chat_width", widthPx: 800 },
};
const invalidOwner: UserPreferenceDocument = {
  area: "appearance",
  // @ts-expect-error Direct construction cannot accept an unparsed account owner.
  userId: "user_00000000-0000-0000-0000-000000000001",
  schemaVersion: 1,
  revision: 1,
  updatedAt: 0,
  values: { mode: "light", palette: "slate-coral" },
};
const customAppearance = { mode: "dark", palette: "slate-coral" } as const;
// @ts-expect-error Inheritance cannot also carry a custom appearance.
const invalidInheritance: AppearanceOverride = {
  kind: "inherit",
  value: customAppearance,
};
void [
  invalidOwner,
  invalidInheritance,
  organisationUser,
  workspaceUser,
  personUser,
  sessionUser,
  wrongProject,
  rawUser,
  invalidDocument,
  invalidCommand,
];
