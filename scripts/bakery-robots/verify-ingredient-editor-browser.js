// Shared scheduler → Wasm loading/retrieval/racking → saved run → Three.js playback.
const rackEvidence = "output/playwright/ingredient-editor";
const rackPlan =
  "output/playwright/ur5e-ingredients-workflow-verified/completed.json";

async function verifyIngredientEditor(page) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openRobotRehearsal(page);
  await editInputs(page);
  const assignments = await page
    .getByLabel("Workcell robot assignments", { exact: true })
    .innerText();
  if (!assignments.includes("FANUC") || !assignments.includes("FAIRINO FR10"))
    throw new Error(
      "The two-tray preset must retain both arms in separate cells",
    );
  await openRackRun(page, rackPlan);
  await saveRackRun(page, rackEvidence, "before-edit");
  await editInputs(page);
  let form = page.getByRole("form", {
    name: "Tray A ingredients",
    exact: true,
  });
  await form
    .getByRole("button", { name: "Apply ingredients to tray A", exact: true })
    .click();
  await page
    .getByText("Ingredient load unchanged. Accepted results are kept.", {
      exact: true,
    })
    .waitFor();
  await saveRackRun(page, rackEvidence, "unchanged");
  await editInputs(page);
  form = page.getByRole("form", { name: "Tray A ingredients", exact: true });
  await form.getByLabel("Lateral offset (mm)", { exact: true }).fill("61");
  await form
    .getByRole("button", { name: "Apply ingredients to tray A", exact: true })
    .click();
  const invalid = await form
    .getByLabel("Lateral offset (mm)", { exact: true })
    .evaluate(checkInvalidIngredient);
  if (!invalid) throw new Error("Out-of-range load was accepted by the form");
  await saveRackRun(page, rackEvidence, "invalid-kept");
  await editInputs(page);
  form = page.getByRole("form", { name: "Tray A ingredients", exact: true });
  await form.getByLabel("Ingredient mass (kg)", { exact: true }).fill("0.5");
  await form.getByLabel("Forward offset (mm)", { exact: true }).fill("100");
  await form.getByLabel("Lateral offset (mm)", { exact: true }).fill("-60");
  await form
    .getByRole("button", { name: "Apply ingredients to tray A", exact: true })
    .click();
  await page
    .getByText(
      "Tray A ingredient load changed. Its results were cleared; run the tray again.",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({ path: `${rackEvidence}/ingredient-editor.png` });
  await saveRackRun(page, rackEvidence, "edited");

  await page
    .getByRole("button", { name: "Run in browser", exact: true })
    .click();
  await page
    .locator(".production-browser-run p")
    .filter({ hasText: "Browser run complete." })
    .waitFor({ timeout: 300000 });
  await saveRackRun(page, rackEvidence, "completed");
  await openRackRun(page, `${rackEvidence}/completed.json`);
  await saveRackRun(page, rackEvidence, "restored");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await page.getByRole("slider", { name: "Production time" }).press("End");
  await page.screenshot({ path: `${rackEvidence}/completed-workflow.png` });
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.screenshot({ path: `${rackEvidence}/completed-timeline.png` });
  return {
    status: "passed",
    checks: [
      "ingredient editing clears previous results and handoffs",
      "unchanged and invalid loads preserve accepted results",
      "UR5e full chain executes the edited load in browser Wasm",
      "completed run reopens",
      "workflow and timeline show completed run",
    ],
  };
}

function checkInvalidIngredient(input) {
  return input.validity.rangeOverflow;
}
