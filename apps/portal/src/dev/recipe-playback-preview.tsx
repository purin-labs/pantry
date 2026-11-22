import React from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_BLACK_SESAME_COBOT_RECIPE } from "@purin-labs/production-simulation/recipes/black-sesame/model";
import { DEFAULT_FINANCIER_BAKE_RECIPE } from "@purin-labs/production-simulation/recipes/financier-bake/model";
import { DEFAULT_FINANCIER_BATTER_RECIPE } from "@purin-labs/production-simulation/recipes/financier-batter/model";
import { DEFAULT_FINANCIER_PACK_RECIPE } from "@purin-labs/production-simulation/recipes/financier-pack/model";
import { DEFAULT_GINGER_TEA_COBOT_RECIPE } from "@purin-labs/production-simulation/recipes/ginger-tea/model";
import { BlackSesameWorkspace } from "@purin-labs/area-kitchen/ui/features/production-run/black-sesame/black-sesame-physics-view";
import { FinancierBakeWorkspace } from "@purin-labs/area-kitchen/ui/features/production-run/financier-bake/financier-bake-physics-view";
import { FinancierBatterWorkspace } from "@purin-labs/area-kitchen/ui/features/production-run/financier-batter/financier-batter-physics-view";
import { FinancierPackWorkspace } from "@purin-labs/area-kitchen/ui/features/production-run/financier-pack/financier-pack-physics-view";
import { GingerTeaWorkspace } from "@purin-labs/area-kitchen/ui/features/production-run/ginger-tea/ginger-tea-physics-view";
import { LatteWorkspace } from "@purin-labs/area-kitchen/ui/features/production-run/latte/latte-physics-view";
import "../styles.css";

// One recipe view with its default recipe and no workspace, as in the local
// fixture: `?recipe=<name>`. The Refactor 10 playback journey runs each view
// here. No production build names this page.
const root = document.getElementById("root");
if (root === null) throw new Error("The page has no root.");
function ignore(): void {}
const VIEWS: Readonly<Record<string, () => React.ReactNode>> = {
  "black-sesame": () => (
    <BlackSesameWorkspace
      recipe={DEFAULT_BLACK_SESAME_COBOT_RECIPE}
      close={ignore}
    />
  ),
  "financier-bake": () => (
    <FinancierBakeWorkspace
      recipe={DEFAULT_FINANCIER_BAKE_RECIPE}
      close={ignore}
    />
  ),
  "financier-batter": () => (
    <FinancierBatterWorkspace
      recipe={DEFAULT_FINANCIER_BATTER_RECIPE}
      close={ignore}
    />
  ),
  "financier-pack": () => (
    <FinancierPackWorkspace
      recipe={DEFAULT_FINANCIER_PACK_RECIPE}
      close={ignore}
    />
  ),
  "ginger-tea": () => (
    <GingerTeaWorkspace
      recipe={DEFAULT_GINGER_TEA_COBOT_RECIPE}
      close={ignore}
    />
  ),
  latte: () => (
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
  ),
};
const view =
  VIEWS[new URL(window.location.href).searchParams.get("recipe") ?? ""];
if (view === undefined)
  throw new Error(`Name one recipe: ${Object.keys(VIEWS).join(", ")}.`);
createRoot(root).render(view());
