import { createRoot } from "react-dom/client";

import { startPortalReads } from "@purin-labs/surface-portal/ui/early-reads";
import {
  installStaleReleaseRecovery,
  isModuleLoadError,
  reloadForNewRelease,
} from "@purin-labs/surface-portal/ui/stale-release";

const root = document.getElementById("root");
if (root === null) throw new Error("Portal root is missing");

const portalRoot = createRoot(root);
installStaleReleaseRecovery();
renderApplication(window.location.pathname).catch(reloadAfterRelease);

function reloadAfterRelease(error: unknown): void {
  if (!isModuleLoadError(error) || !reloadForNewRelease()) throw error;
}

async function renderApplication(pathname: string): Promise<void> {
  // The Square Point of Sale app returns here; the page goes straight back
  // to the Register that opened the app, with the app's answer.
  if (pathname === "/portal/square-pos-return") {
    const { squarePosReturnAddress } =
      await import("@purin-labs/area-cafe/ui/features/register/square-pos-handoff");
    window.location.replace(
      squarePosReturnAddress(window.location.search) ?? "/portal",
    );
    return;
  }
  const searchParams = new URLSearchParams(window.location.search);
  if (
    /^\/(workflow-simulator|bakery|floor-plans)\/?$/u.test(pathname) ||
    searchParams.get("demo") === "1"
  ) {
    const { showRequestedPhysicsEvidence, WorkflowDemoApp } =
      await import("@purin-labs/surface-portal/ui/workflow-demo");
    // In development the demo's chat answers from the chat preview data, as
    // at /workflow-preview.html; a production build drops this import.
    if (import.meta.env.DEV)
      (await import("./dev/chat-preview-data")).installChatPreviewFetch();
    showRequestedPhysicsEvidence(window.location.search);
    document.title = "Production · Purin Pantry";
    portalRoot.render(<WorkflowDemoApp />);
    return;
  }
  await import("@purin-labs/surface-portal/ui/styles.css");
  if (/^\/docs\/(privacy|terms|deletion|contact)\/?$/u.test(pathname)) {
    const { PublicDocumentsApp } =
      await import("@purin-labs/surface-portal/ui/public-docs");
    portalRoot.render(<PublicDocumentsApp pathname={pathname} />);
    return;
  }
  if (pathname === "/identity/link") {
    const { IdentityApp } = await import("@purin-labs/surface-portal/ui/main");
    portalRoot.render(<IdentityApp />);
    return;
  }
  // The page's reads start now and run beside the load of the Portal's code.
  startPortalReads(pathname);
  const { ControlPortalRouter } =
    await import("@purin-labs/surface-portal/ui/portal");
  portalRoot.render(<ControlPortalRouter />);
}
