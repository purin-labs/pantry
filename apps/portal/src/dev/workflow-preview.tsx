import { isUserId } from "@purin-labs/control-api";
import { UserPreferencesProvider } from "../preferences/context";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import { CircleQuestionMark } from "lucide-react";
import { PortalFrame } from "../shell";
import { PageHeader } from "../page-components";
import { readPortalRoute, workspacePageDescriptor } from "../route";
import WorkflowSimulatorRoute from "../features/workflow-simulator/route";
import { ConnectedChatPage as ChatPage } from "../features/chat/route";
import { UNAVAILABLE_ACCESS } from "./unavailable-access";
import { installChatPreviewFetch } from "./chat-preview-data";
import { showPhysicsEvidence } from "@purin-labs/production-simulation/runs/physics-evidence";
import "../styles.css";
import "./workflow-preview.css";

if (import.meta.env.DEV) installChatPreviewFetch();
if (new URLSearchParams(window.location.search).has("evidence")) {
  showPhysicsEvidence();
}

function DevelopmentFixtureNotice(): React.ReactNode {
  return (
    <div
      className="development-fixture-notice"
      aria-label="Development fixture · No account data"
      title="Development fixture · No account data"
    >
      <CircleQuestionMark size={16} strokeWidth={1.5} aria-hidden="true" />
      <span className="development-fixture-copy" aria-hidden="true">
        <span>Development fixture</span>
        <span>No account data</span>
      </span>
    </div>
  );
}

function previewLogout(): Promise<void> {
  return Promise.resolve();
}

function AuthenticatedWorkflowPreview(): React.ReactNode {
  const userId = new URL(window.location.href).searchParams.get("preferenceUser");
  const content = <WorkflowPreview />;
  return isUserId(userId) ? <UserPreferencesProvider key={userId} userId={userId}>{content}</UserPreferencesProvider> : content;
}
function WorkflowPreview(): React.ReactNode {
  const navigate = useNavigate();
  const location = useLocation(),
    route = readPortalRoute(location.pathname);
  const selectedPage =
    route.kind === "workspace" ? route.destination.page : "overview";
  const chatOpen = selectedPage === "chat";
  const page = chatOpen ? "workflow-simulator" : selectedPage;
  const descriptor = workspacePageDescriptor(page);
  return (
    <PortalFrame
      chat={
        chatOpen
          ? {
              close: closeWorkflowPreviewChat.bind(null, navigate),
              content: (
                <ChatPage
                  context={{
                    organisation: "Nuki Inc.",
                    workspace: "Cafe operations",
                    area: "BakeryOS",
                    view: "Production",
                  }}
                  close={closeWorkflowPreviewChat.bind(null, navigate)}
                  organisationId="organisation_chat_preview"
                  basePath="/workflow-preview.html"
                  integrationsPath="/integrations-preview.html"
                  accessPath="/access-preview.html"
                  access={UNAVAILABLE_ACCESS}
                  signedInAs={null}
                  canManage={true}
                />
              ),
            }
          : null
      }
      identity={{ kind: "ready", displayName: "Pta", logout: previewLogout }}
      organisation={{
        organisationHandle: "preview",
        name: "Local preview",
        choices: [],
      }}
      workspace={{
        organisationHandle: "preview",
        workspaceHandle: "bakery",
        name: "Sample bakery",
        choices: [],
      }}
      sidebar={{
        activePage: page,
        chatOpen,
        footer: <DevelopmentFixtureNotice />,
      }}
    >
      <PageHeader
        title={descriptor.title}
        description={descriptor.description}
      />
      {page === "workflow-simulator" ? (
        <WorkflowSimulatorRoute connection={{ kind: "preview" }} />
      ) : (
        <p>
          This fixture only implements Workflow simulator. Use Automation →
          Workflow simulator to return.
        </p>
      )}
    </PortalFrame>
  );
}

function closeWorkflowPreviewChat(navigate: NavigateFunction): void {
  navigate("/portal/preview/bakery/workflow-simulator", { replace: true });
}

export function WorkflowPreviewApp(): React.ReactNode {
  return (
    <MemoryRouter
      initialEntries={["/portal/preview/bakery/workflow-simulator"]}
    >
      <AuthenticatedWorkflowPreview />
    </MemoryRouter>
  );
}

const root = document.getElementById("root");
if (
  import.meta.env.DEV &&
  root &&
  window.location.pathname.endsWith("/workflow-preview.html")
)
  createRoot(root).render(
    <React.StrictMode>
      <WorkflowPreviewApp />
    </React.StrictMode>,
  );
