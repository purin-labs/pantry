// Run through browser-acceptance.mjs. The browser takes the WebGL context of
// the shift scene (WEBGL_lose_context, as a GPU reset or a memory limit
// does). The simulator then marks its 3D view unavailable, so the camera
// controls that need the scene turn off and no stopped view reads as ready.
async function verifyShiftSceneContextLoss(page) {
  page.setDefaultTimeout(30000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.reload();
  await page.getByRole("button", { name: "Top view", exact: true }).waitFor();
  await page
    .waitForFunction(function sceneReady() {
      return (
        document.querySelector('button[aria-label="Top view"]')?.disabled ===
        false
      );
    })
    .catch(function notReady() {
      throw new Error("The shift scene never became ready");
    });
  await page.evaluate(function loseContext() {
    const canvas = document.querySelector("canvas.workflow-scene-canvas");
    if (canvas === null) throw new Error("The shift scene has no canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const extension = context?.getExtension("WEBGL_lose_context") ?? null;
    if (extension === null) throw new Error("WEBGL_lose_context is missing");
    extension.loseContext();
  });
  await page
    .waitForFunction(function sceneUnavailable() {
      return (
        document.querySelector('button[aria-label="Top view"]')?.disabled ===
        true
      );
    })
    .catch(function keptReady() {
      throw new Error("The page kept the lost shift scene as ready");
    });
  await page.screenshot({
    path: "output/playwright/shift-scene-context-loss.png",
  });
  return { result: "passed", topViewDisabledAfterContextLoss: true };
}
