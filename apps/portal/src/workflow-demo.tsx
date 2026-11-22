import { isUserId } from "@purin-labs/control-api";
import { UserPreferencesProvider } from "@purin-labs/ui/preferences/context";
import React from "react";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import { CircleQuestionMark } from "lucide-react";
import { PortalFrame } from "./shell";
import { PageHeader } from "@purin-labs/ui/page-components";
import { readPortalRoute, workspacePageDescriptor } from "@purin-labs/ui/route";
import WorkflowSimulatorRoute from "@purin-labs/area-kitchen/ui/features/workflow-simulator/route";
import { ConnectedChatPage as ChatPage } from "./features/chat/route";
import { UNAVAILABLE_ACCESS } from "@purin-labs/area-organisation/ui/features/access/unavailable-access";
import { showPhysicsEvidence } from "@purin-labs/production-simulation/runs/physics-evidence";
import "./styles.css";
import "./workflow-demo.css";

// The public workflow simulator: the Kitchen page in a sample Portal frame,
// with no sign-in and no account data. The Worker serves it at
// /workflow-simulator, /bakery, /floor-plans and ?demo=1 (bootstrap.tsx), and
// the development fixture dev/workflow-preview.tsx mounts it at
// /workflow-preview.html. Its chat pane links to /workflow-preview.html.

/** Shows the physics diagnostics when the address asks for them (?evidence). */
export function showRequestedPhysicsEvidence(search: string): void {
  if (new URLSearchParams(search).has("evidence")) showPhysicsEvidence();
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

function demoLogout(): Promise<void> {
  return Promise.resolve();
}

function WorkflowDemoWithPreferences(): React.ReactNode {
  const userId = new URL(window.location.href).searchParams.get(
    "preferenceUser",
  );
  const content = <WorkflowDemo />;
  return isUserId(userId) ? (
    <UserPreferencesProvider key={userId} userId={userId}>
      {content}
    </UserPreferencesProvider>
  ) : (
    content
  );
}
function WorkflowDemo(): React.ReactNode {
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
              close: closeWorkflowDemoChat.bind(null, navigate),
              content: (
                <ChatPage
                  context={{
                    organisation: "Nuki Inc.",
                    workspace: "Cafe operations",
                    area: "kitchen",
                    view: "Production",
                  }}
                  close={closeWorkflowDemoChat.bind(null, navigate)}
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
      identity={{ kind: "ready", displayName: "Pta", logout: demoLogout }}
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

function closeWorkflowDemoChat(navigate: NavigateFunction): void {
  navigate("/portal/preview/bakery/workflow-simulator", { replace: true });
}

export function WorkflowDemoApp(): React.ReactNode {
  return (
    <MemoryRouter
      initialEntries={["/portal/preview/bakery/workflow-simulator"]}
    >
      <WorkflowDemoWithPreferences />
    </MemoryRouter>
  );
}
