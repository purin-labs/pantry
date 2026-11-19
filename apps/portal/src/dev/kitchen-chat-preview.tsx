import { isUserId } from "@seams/control-api";
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { UserPreferencesProvider } from "../preferences/context";
import "../styles.css";
import { PortalFrame } from "../shell";
import { PageHeader } from "../page-components";
import { workspacePageDescriptor } from "../route";
import { controlMutation, type ControlMutationIntent } from "../control-client";
import { ConnectedChatPage as ChatPage } from "../features/chat/route";
import { BakerySurfaceEffectBridge } from "../features/bakery-surface-effect-bridge";
import WorkflowSimulatorRoute from "../features/workflow-simulator/route";
import { UNAVAILABLE_ACCESS } from "./unavailable-access";

// Kitchen with the chat beside it, as the Portal shows them, for one
// Organisation of the Worker behind this server (`?organisation=<id>`) under
// the browser's own session. The agent's browser commands reach the page
// through the same bridge as in the Portal. A browser journey drives it.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Kitchen chat preview is development-only.");
const search = new URL(window.location.href).searchParams;
const organisationId = search.get("organisation");
if (organisationId === null)
  throw new Error("Open the preview with ?organisation=<id>.");
const userId = search.get("preferenceUser");
const descriptor = workspacePageDescriptor("workflow-simulator");

function previewLogout(): Promise<void> {
  return Promise.resolve();
}
function closePreviewChat(): void {}
function revealKitchen(): Promise<void> {
  return Promise.resolve();
}
function mutate(
  path: string,
  body: unknown,
  intent: ControlMutationIntent,
): Promise<unknown> {
  return controlMutation(path, "POST", body, undefined, intent);
}

function KitchenChatPreview(props: {
  organisationId: string;
}): React.ReactNode {
  return (
    <>
      <BakerySurfaceEffectBridge
        organisationId={props.organisationId}
        active={true}
        reveal={revealKitchen}
      />
      <PortalFrame
        identity={{
          kind: "ready",
          displayName: "Owner",
          logout: previewLogout,
        }}
        organisation={{
          organisationHandle: "kitchen",
          name: "Kitchen acceptance",
          choices: [],
        }}
        workspace={{
          organisationHandle: "kitchen",
          workspaceHandle: "cafe",
          name: "Cafe operations",
          choices: [],
        }}
        sidebar={{
          activePage: "workflow-simulator",
          chatOpen: true,
          footer: null,
        }}
        chat={{
          close: closePreviewChat,
          content: (
            <ChatPage
              context={{
                organisation: "Kitchen acceptance",
                workspace: "Cafe operations",
                area: descriptor.group,
                view: descriptor.navigationLabel,
              }}
              close={closePreviewChat}
              organisationId={props.organisationId}
              basePath="/kitchen-chat-preview.html"
              integrationsPath="/integrations-preview.html"
              accessPath="/access-preview.html"
              access={UNAVAILABLE_ACCESS}
              signedInAs={null}
              canManage={true}
            />
          ),
        }}
      >
        <PageHeader
          title={descriptor.title}
          description={descriptor.description}
        />
        <WorkflowSimulatorRoute
          connection={{
            kind: "workspace",
            organisationId: props.organisationId,
            canManage: true,
            mutate,
          }}
        />
      </PortalFrame>
    </>
  );
}

const content = <KitchenChatPreview organisationId={organisationId} />;
createRoot(root).render(
  <MemoryRouter initialEntries={["/portal/kitchen/cafe/workflow-simulator"]}>
    {isUserId(userId) ? (
      <UserPreferencesProvider key={userId} userId={userId}>
        {content}
      </UserPreferencesProvider>
    ) : (
      content
    )}
  </MemoryRouter>,
);
