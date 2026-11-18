import { createRoot } from "react-dom/client";

import { startPortalReads } from "./early-reads";
import {
  installStaleReleaseRecovery,
  isModuleLoadError,
  reloadForNewRelease,
} from "./stale-release";

const root = document.getElementById("root");
if (root === null) throw new Error("Portal root is missing");

const portalRoot = createRoot(root);
installStaleReleaseRecovery();
renderApplication(window.location.pathname).catch(reloadAfterRelease);

function reloadAfterRelease(error: unknown): void {
  if (!isModuleLoadError(error) || !reloadForNewRelease()) throw error;
}

async function renderApplication(pathname: string): Promise<void> {
  if (pathname === "/ecommerce" || pathname === "/ecommerce/") {
    const { EcommercePage } = await import("./features/ecommerce/page");
    document.title = "Ecommerce Agents · Seams";
    portalRoot.render(<EcommercePage />);
    return;
  }
  const searchParams = new URLSearchParams(window.location.search);
  if (
    /^\/(workflow-simulator|bakery|floor-plans)\/?$/u.test(pathname) ||
    searchParams.get("demo") === "1"
  ) {
    const { WorkflowPreviewApp } = await import("./dev/workflow-preview");
    document.title = "Workflow simulator · Seams Pantry";
    portalRoot.render(<WorkflowPreviewApp />);
    return;
  }
  await import("./styles.css");
  if (/^\/docs\/(privacy|terms|deletion|contact)\/?$/u.test(pathname)) {
    const { PublicDocumentsApp } = await import("./public-docs");
    portalRoot.render(<PublicDocumentsApp pathname={pathname} />);
    return;
  }
  if (pathname === "/identity/link") {
    const { IdentityApp } = await import("./main");
    portalRoot.render(<IdentityApp />);
    return;
  }
  // The page's reads start now and run beside the load of the Portal's code.
  startPortalReads(pathname);
  const [, { ControlPortalRouter }] = await Promise.all([
    initializePortalValidators(),
    import("./portal"),
  ]);
  portalRoot.render(<ControlPortalRouter />);
}

async function initializePortalValidators(): Promise<void> {
  // Pantry's validator core also carries Commerce's commerce validators.
  const { initializeBrowserValidators } =
    await import("@seams/contracts/browser-validators");
  await initializeBrowserValidators();
}
