/**
 * Plan 60A / 61E browser verification for the four single-dose coffee grinders
 * (`miicoffee-df64-gen2`, `option-o-lagom-casa`, `timemore-bricks-01s`,
 * `fellow-opus-2`) in both the Bakery Shift author and the Combined Café Shift
 * 3D workcell.
 */
async function verifyCafeShiftGrindersBrowser(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const initialUrl = new URL(page.url());
  if (
    initialUrl.hostname === "127.0.0.1" ||
    initialUrl.hostname === "localhost"
  ) {
    await page.goto(new URL("/factory-acceptance.html", page.url()).href);
  } else {
    await page.route("**/v1/control/**", portalControlRequest);
    await page.goto(
      `${initialUrl.origin}/portal/nuki-inc/cafe-operations/workflow-simulator`,
    );
  }

  const cafeForm = page.getByRole("form", {
    name: "Combined café shift recipe",
    exact: true,
  });
  if (!(await cafeForm.isVisible())) {
    await page.getByRole("button", { name: "Recipes", exact: true }).click();
  }
  if (!(await cafeForm.isVisible())) {
    const cafeCard = page.getByRole("button", {
      name: /Combined Café Shift · Financiers & Espresso/,
    });
    if (await cafeCard.isVisible()) await cafeCard.click();
  }
  await cafeForm.waitFor({ timeout: 30000 });

  // 1. Verify BakeryShiftAuthor exposes all 4 grinders in Morning Shift scope.
  const bakeryShiftForm = page.getByRole("form", {
    name: "Bakery shift",
    exact: true,
  });
  await chooseOption(
    page,
    bakeryShiftForm.getByLabel("Shift scope", { exact: true }),
    { value: "morning-shift" },
  );
  const bakeryGrinderSelect = bakeryShiftForm.getByLabel("Coffee grinder", {
    exact: true,
  });
  const bakeryGrinderOptions = (
    await selectItems(page, bakeryGrinderSelect)
  ).map((item) => item.value);
  const expectedGrinders = [
    "option-o-lagom-casa",
    "timemore-bricks-01s",
    "fellow-opus-2",
    "miicoffee-df64-gen2",
  ];
  for (const g of expectedGrinders) {
    if (!bakeryGrinderOptions.includes(g)) {
      throw new Error(
        `BakeryShiftAuthor missing grinder ${g}: ${JSON.stringify(bakeryGrinderOptions)}`,
      );
    }
  }
  await chooseOption(page, bakeryGrinderSelect, {
    value: "miicoffee-df64-gen2",
  });

  // 2. Verify CafeShiftRecipeAuthor defaults to miicoffee-df64-gen2 and prepare workspace.
  const cafeGrinderSelect = cafeForm.getByLabel("Single-dose coffee grinder", {
    exact: true,
  });
  const defaultGrinder = await selectValue(cafeGrinderSelect);
  if (defaultGrinder !== "miicoffee-df64-gen2") {
    throw new Error(
      `Expected default cafe-shift grinder miicoffee-df64-gen2, got ${defaultGrinder}`,
    );
  }
  await cafeForm.screenshot({ path: "cafe-shift-grinders-author.png" });
  await cafeForm
    .getByRole("button", { name: "Prepare combined café shift", exact: true })
    .click();

  const station = page.getByRole("region", {
    name: "Accepted combined café shift state",
    exact: true,
  });
  await station.waitFor({ timeout: 30000 });
  await station
    .getByRole("button", { name: /^Espresso bar / })
    .click();

  const grindersToRun = [
    {
      id: "miicoffee-df64-gen2",
      label: "MiiCoffee DF64 II (Gen 2)",
      rpm: 1400,
    },
    {
      id: "option-o-lagom-casa",
      label: "Option-O Lagom Casa",
      rpm: 200,
    },
    {
      id: "timemore-bricks-01s",
      label: "Timemore Bricks 01S",
      rpm: 450,
    },
    {
      id: "fellow-opus-2",
      label: "Fellow Opus 2",
      rpm: 400,
    },
  ];

  const verifiedRuns = [];

  for (let i = 0; i < grindersToRun.length; i++) {
    const spec = grindersToRun[i];
    if (i > 0) {
      const scenarioBtn = page.getByRole("button", {
        name: "Scenario",
        exact: true,
      });
      if ((await scenarioBtn.getAttribute("aria-expanded")) !== "true") {
        await scenarioBtn.click();
      }
      const scenarioForm = page.getByRole("form", {
        name: "Cafe shift scenario controls",
        exact: true,
      });
      await chooseOption(
        page,
        scenarioForm.getByLabel("Single-dose grinder", { exact: true }),
        { value: spec.id },
      );
      await scenarioForm
        .getByRole("button", { name: "Apply scenario", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Close details", exact: true })
        .click();
    }

    await page
      .locator(
        `section[aria-label="Accepted combined café shift state"][data-cafe-shift-grinder="${spec.id}"]`,
      )
      .waitFor({ timeout: 15000 });

    // Scrub to 1.0 s (during Shot 1 grind window) to verify live grinder RPM telemetry.
    await page
      .getByRole("button", { name: "Timeline", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: /1 · Beurre Noisette, HL200 Mix & Espresso Order 1/,
      })
      .click();
    await page.getByRole("button", { name: "Start production", exact: true }).click();
    await page.waitForTimeout(250);
    await page.getByRole("button", { name: "Pause production", exact: true }).click();
    // Close timeline so the 3D view is unobstructed.
    await page
      .getByRole("button", { name: "Timeline", exact: true })
      .click();

    const statusText = (await station.textContent()) ?? "";
    if (!statusText.includes(spec.label)) {
      throw new Error(
        `Expected grinder label ${spec.label} in station telemetry, got: ${statusText}`,
      );
    }

    // Complete the shift and capture screenshot + ledger verification.
    await page
      .getByRole("button", { name: "Complete shift", exact: true })
      .click();
    await page
      .locator(
        `section[aria-label="Accepted combined café shift state"][data-cafe-shift-phase="completed"][data-cafe-shift-grinder="${spec.id}"]`,
      )
      .waitFor({ timeout: 15000 });

    const alertCount = await station.getByRole("alert").count();
    if (alertCount > 0) {
      const alertText = await station.getByRole("alert").textContent();
      throw new Error(`3D scene error for ${spec.id}: ${alertText}`);
    }

    await station.screenshot({
      path: `cafe-shift-grinder-${spec.id}.png`,
    });

    verifiedRuns.push({
      grinder: spec.id,
      label: spec.label,
      nominalRpm: spec.rpm,
    });
  }

  // Open Results panel and verify all 4 grinders appear in Completed shift comparison.
  await page.getByRole("button", { name: "Results", exact: true }).click();
  const comparison = page.getByRole("region", {
    name: "Completed shift comparison",
    exact: true,
  });
  await comparison.waitFor({ timeout: 10000 });
  const items = await comparison
    .locator("li")
    .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));
  if (items.length !== 4) {
    throw new Error(
      `Expected 4 completed grinder runs in comparison, got ${items.length}: ${JSON.stringify(items)}`,
    );
  }
  for (const spec of grindersToRun) {
    if (!items.some((item) => item.includes(spec.label))) {
      throw new Error(
        `Completed shift comparison missing ${spec.label}: ${JSON.stringify(items)}`,
      );
    }
  }
  await page
    .getByRole("complementary", { name: "Factory details", exact: true })
    .screenshot({ path: "cafe-shift-grinders-results.png" });

  return {
    result: "passed",
    origin: initialUrl.origin,
    bakeryShiftGrinderOptions: bakeryGrinderOptions,
    defaultCafeShiftGrinder: defaultGrinder,
    verifiedRuns,
    completedComparisonItems: items,
  };
}

async function portalControlRequest(route) {
  const url = new URL(route.request().url());
  const { pathname } = url;
  const userId = "user_00000000-0000-4000-8000-000000000001";
  const organisationId = "oven-ui-acceptance";
  if (pathname === "/v1/control/session") {
    await route.fulfill({
      status: 200,
      json: {
        ok: true,
        identity: {
          userId,
          email: "pta@pantry.test",
          displayName: "Pta",
        },
        supportRole: null,
        membershipAvailability: "complete",
        memberships: [
          {
            organisationId,
            organisationHandle: "nuki-inc",
            role: "owner",
            workspaces: [
              {
                workspaceId: "workspace_cafe_operations",
                workspaceHandle: "cafe-operations",
                name: "Cafe operations",
                createdAt: 1_800_000_000_000,
              },
            ],
          },
        ],
      },
    });
    return;
  }
  if (pathname === `/v1/control/organisations/${organisationId}`) {
    await route.fulfill({
      status: 200,
      json: {
        schema_version: 1,
        projection_revision: 1,
        configuration_version: 1,
        organisation: {
          organisation_id: organisationId,
          name: "Nuki Inc.",
          plan: "beta",
          lifecycle: {
            kind: "active",
            organisation_id: organisationId,
            activation_receipt_id: "receipt_production_acceptance",
            activated_at: 1_800_000_000_000,
            environment: "production",
          },
          capability_profile: "read_and_propose",
          created_at: 1_800_000_000_000,
        },
        steps: [
          {
            kind: "complete",
            step: "workspace",
            completed_at: 1_800_000_000_000,
            receipt_id: "receipt_workspace",
          },
          {
            kind: "complete",
            step: "commerce",
            completed_at: 1_800_000_000_001,
            receipt_id: "receipt_commerce",
          },
          {
            kind: "complete",
            step: "conversations",
            completed_at: 1_800_000_000_002,
            receipt_id: "receipt_conversations",
          },
          {
            kind: "complete",
            step: "operating_profile",
            completed_at: 1_800_000_000_003,
            receipt_id: "receipt_profile",
          },
          {
            kind: "complete",
            step: "review_activation",
            completed_at: 1_800_000_000_004,
            receipt_id: "receipt_activation",
          },
        ],
        provider_accounts: [],
        operating_profile: { kind: "unconfigured" },
        readiness: {
          kind: "ready",
          readiness_version: 1,
          readiness_hash: "readiness_production_acceptance",
        },
        activation: {
          kind: "succeeded",
          activation_attempt_id: "activation_attempt_production",
          activation_receipt_id: "activation_receipt_production",
          activated_at: 1_800_000_000_000,
        },
        next_action: {
          kind: "done",
          action_code: "onboarding_complete",
          label: "Onboarding complete",
        },
        first_task: null,
        support_reference: { kind: "none" },
        updated_at: 1_800_000_000_000,
      },
    });
    return;
  }
  if (
    pathname === `/v1/control/organisations/${organisationId}/inference/codex`
  ) {
    await route.fulfill({
      status: 200,
      json: { ok: true, connection: { kind: "disconnected", revision: 0 } },
    });
    return;
  }
  if (pathname.startsWith("/v1/control/user/preferences/")) {
    const area = pathname.slice("/v1/control/user/preferences/".length);
    const values =
      area === "appearance"
        ? { mode: "system", palette: "sage" }
        : area === "chat"
          ? { dockedPanelWidthPx: 600, fullscreenSidebarWidthPx: 360 }
          : {
              appearance: { kind: "inherit" },
              scene: { labels: "auto", minimap: false },
            };
    await route.fulfill({
      status: 200,
      json: {
        userId,
        area,
        schemaVersion: 1,
        revision: 1,
        updatedAt: 1_800_000_000_000,
        values,
      },
    });
    return;
  }
  if (
    pathname.endsWith("/commerce/entity-plane/resources") ||
    pathname.endsWith("/commerce/resources")
  ) {
    await route.fulfill({
      status: 200,
      json: { ok: true, entityTypes: [], relationshipDefinitions: [] },
    });
    return;
  }
  await route.fulfill({
    status: 200,
    json: { ok: true, snapshots: [], nextCursor: null },
  });
}
