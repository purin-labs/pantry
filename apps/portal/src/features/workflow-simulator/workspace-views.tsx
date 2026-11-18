import React from "react";

/**
 * The recipe views and scenes of the production workspace, each loaded when
 * its view first opens (Refactor 16, step 11). Each module brings Three.js
 * and its scene code, so the workspace's first paint does not wait for them.
 * Each view shows `fallback` while its module loads.
 */
function lazyView<Props extends object>(
  load: () => Promise<React.ComponentType<Props>>,
  fallback: React.ReactNode = <p role="status">Loading the recipe view…</p>,
): React.FunctionComponent<Props> {
  const Loaded = React.lazy(async () => ({ default: await load() }));
  function View(props: Props): React.ReactNode {
    const loaded = React.createElement(Loaded, props);
    return <React.Suspense fallback={fallback}>{loaded}</React.Suspense>;
  }
  return View;
}

export const SiphonWorkspace = lazyView(
  async () =>
    (await import("../production-run/siphon/siphon-physics-view"))
      .SiphonWorkspace,
);
export const LatteWorkspace = lazyView(
  async () =>
    (await import("../production-run/latte/latte-physics-view")).LatteWorkspace,
);
export const BlackSesameWorkspace = lazyView(
  async () =>
    (await import("../production-run/black-sesame/black-sesame-physics-view"))
      .BlackSesameWorkspace,
);
export const GingerTeaWorkspace = lazyView(
  async () =>
    (await import("../production-run/ginger-tea/ginger-tea-physics-view"))
      .GingerTeaWorkspace,
);
export const FinancierBatterWorkspace = lazyView(
  async () =>
    (
      await import("../production-run/financier-batter/financier-batter-physics-view")
    ).FinancierBatterWorkspace,
);
export const FinancierBakeWorkspace = lazyView(
  async () =>
    (
      await import("../production-run/financier-bake/financier-bake-physics-view")
    ).FinancierBakeWorkspace,
);
export const FinancierPackWorkspace = lazyView(
  async () =>
    (
      await import("../production-run/financier-pack/financier-pack-physics-view")
    ).FinancierPackWorkspace,
);
export const PastryBenchWorkspace = lazyView(
  async () =>
    (await import("../production-run/pastry-bench/pastry-bench-physics-view"))
      .PastryBenchWorkspace,
);
export const CafeShiftWorkspace = lazyView(
  async () =>
    (await import("../production-run/cafe-shift/cafe-shift-physics-view"))
      .CafeShiftWorkspace,
);
export const OvenWorkspace = lazyView(
  async () => (await import("../production-run/oven-workspace")).OvenWorkspace,
);
export const ProductionNativeScene = lazyView(
  async () => (await import("./production-native-scene")).ProductionNativeScene,
  null,
);
