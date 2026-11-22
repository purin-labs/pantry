import { createRoot } from "react-dom/client";
import {
  controlMutation,
  type ControlMutationIntent,
} from "@purin-labs/control/portal/control-client";
import { LatteWorkspace } from "@purin-labs/area-kitchen/ui/features/production-run/latte/latte-physics-view";
import { RecipeWorkspaceContext } from "@purin-labs/area-kitchen/ui/features/production-run/recipe-workspace";
import "../styles.css";

// One recipe view against a Worker's control routes, for the Plan 84 browser
// journey. `?organisation=<id>` picks the Organisation, and the browser's own
// session cookie signs each request.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("The workflow draft preview is development-only.");
const search = new URL(window.location.href).searchParams;
const organisationId = search.get("organisation") ?? "organisation_preview";
function ignore(): void {}
function mutate(
  path: string,
  body: unknown,
  intent: ControlMutationIntent,
): Promise<unknown> {
  return controlMutation(path, "POST", body, undefined, intent);
}
createRoot(root).render(
  <RecipeWorkspaceContext.Provider
    value={{
      organisationId,
      canManage: search.get("role") !== "viewer",
      mutate,
      chatPath: search.get("chat") ?? undefined,
    }}
  >
    <LatteWorkspace
      recipe={{
        revision: 1,
        appliance: "linea",
        milkG: 180,
        targetMilkC: 63,
        check: "none",
      }}
      close={ignore}
    />
  </RecipeWorkspaceContext.Provider>,
);
