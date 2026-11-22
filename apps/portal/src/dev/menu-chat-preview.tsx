import { isUserId } from "@purin-labs/control-api";
import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createMemoryRouter } from "react-router";
import { UserPreferencesProvider } from "@purin-labs/ui/preferences/context";
import "../styles.css";
import { PortalFrame } from "../shell";
import { PageHeader } from "@purin-labs/ui/page-components";
import { workspacePageDescriptor } from "@purin-labs/ui/route";
import { ConnectedChatPage as ChatPage } from "../features/chat/route";
import { MenuDraftRoute } from "../features/content-studio/route";
import { registerPortalBoardChat } from "../portal-board-chat";
import PermissionRequestsDrawer from "../features/access/permission-requests-drawer";
import { UNAVAILABLE_ACCESS } from "../features/access/unavailable-access";
import { createAccessRouteTransport } from "../features/access/api";
import { controlMutation, controlRead } from "@purin-labs/control/portal/control-client";

// The Menus page with the chat beside it, as the Portal shows them, for one
// Organisation of the Worker behind this server (`?organisation=<id>`) under
// the browser's own session. An agent's edit reaches the page through the
// room that people edit. A browser journey drives it.
registerPortalBoardChat();
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Menu chat preview is development-only.");
const search = new URL(window.location.href).searchParams;
const organisationId = search.get("organisation");
if (organisationId === null)
  throw new Error("Open the preview with ?organisation=<id>.");
const userId = search.get("preferenceUser");
const descriptor = workspacePageDescriptor("menus");
// `?access=live` lets an owner allow a permission prompt through the Worker's
// Access routes; otherwise the prompts explain who must allow them.
const access =
  search.get("access") === "live"
    ? createAccessRouteTransport(controlRead, controlMutation, () =>
        Promise.resolve(null),
      )
    : UNAVAILABLE_ACCESS;

function previewLogout(): Promise<void> {
  return Promise.resolve();
}
function closePreviewChat(): void {}
function MenuChatPreview(props: {
  organisationId: string;
}): React.ReactNode {
  const [requestsOpen, setRequestsOpen] = React.useState(false);
  return (
      <PortalFrame
        identity={{
          kind: "ready",
          displayName: "Owner",
          logout: previewLogout,
          permissionRequests: {
            open: setRequestsOpen.bind(null, true),
            count: null,
          },
        }}
        organisation={{
          organisationHandle: "kitchen",
          name: "Menu acceptance",
          choices: [],
        }}
        workspace={{
          organisationHandle: "kitchen",
          workspaceHandle: "cafe",
          name: "Cafe operations",
          choices: [],
        }}
        sidebar={{
          activePage: "menus",
          chatOpen: true,
          footer: null,
        }}
        chat={{
          close: closePreviewChat,
          content: (
            <ChatPage
              context={{
                organisation: "Menu acceptance",
                workspace: "Cafe operations",
                area: descriptor.group,
                view: descriptor.navigationLabel,
              }}
              close={closePreviewChat}
              organisationId={props.organisationId}
              basePath="/menu-chat-preview.html"
              integrationsPath="/integrations-preview.html"
              accessPath="/access-preview.html"
              access={access}
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
        <MenuDraftRoute organisationId={props.organisationId} />
        {requestsOpen ? (
          <PermissionRequestsDrawer
            organisationId={props.organisationId}
            workspaceName="Menu acceptance"
            access={access}
            onClose={setRequestsOpen.bind(null, false)}
          />
        ) : null}
      </PortalFrame>
  );
}

const content = <MenuChatPreview organisationId={organisationId} />;
// The Menus page blocks a leave with unsynced edits, so it needs a data router.
const router = createMemoryRouter(
  [
    {
      path: "*",
      element: isUserId(userId) ? (
        <UserPreferencesProvider key={userId} userId={userId}>
          {content}
        </UserPreferencesProvider>
      ) : (
        content
      ),
    },
  ],
  // `?tab=items` or `?tab=screens` opens that sheet over the canvas.
  { initialEntries: [search.get("tab") === null ? "/portal/kitchen/cafe/menus" : `/portal/kitchen/cafe/menus?tab=${encodeURIComponent(search.get("tab") ?? "")}`] },
);
createRoot(root).render(<RouterProvider router={router} />);
