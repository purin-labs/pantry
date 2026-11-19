async function verifyFloorPlanGeometry(page) {
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  const evidence = "output/playwright/floor-plan-geometry";

  /** Footprints in metres, measured from pixels against the room frame. */
  function measure(map) {
    function box(element) {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }
    const boundary = map.querySelector(".spatial-room-boundary");
    // "Assumed room: 11 by 7 metres. …"
    const size = /Assumed room: ([\d.]+) by ([\d.]+) metres/u.exec(
      boundary.getAttribute("aria-label"),
    );
    const metres = { width: Number(size[1]), depth: Number(size[2]) };
    const room = box(boundary);
    const pixelsPerMetre = room.width / metres.width;
    const items = {};
    for (const shape of map.querySelectorAll("g.spatial-footprint")) {
      const id = shape.dataset.footprint;
      const marker = map.querySelector(`button[data-resource="${id}"]`);
      const fill = box(shape.querySelector(".spatial-footprint-fill"));
      const envelope = /: ([\d.]+) × ([\d.]+) m envelope$/.exec(marker.title);
      const markerBox = box(marker);
      items[id] = {
        width: fill.width / pixelsPerMetre,
        depth: fill.height / pixelsPerMetre,
        envelope:
          envelope === null ? null : [Number(envelope[1]), Number(envelope[2])],
        marker: {
          x: markerBox.x + markerBox.width / 2,
          y: markerBox.y + markerBox.height / 2,
          width: markerBox.width,
          height: markerBox.height,
        },
        fill,
        pressed: marker.getAttribute("aria-pressed") === "true",
        context: shape.dataset.context === "true",
      };
    }
    return { room, metres, pixelsPerMetre, items };
  }

  function assertTrueScale(sample, label) {
    const { width, depth } = sample.metres;
    if (
      Math.abs(sample.room.width / sample.room.height - width / depth) > 0.005
    )
      throw new Error(
        `${label}: the room lost its ${width} × ${depth} m proportions.`,
      );
    for (const [id, item] of Object.entries(sample.items)) {
      if (item.envelope === null)
        throw new Error(`${label}: ${id} has no size.`);
      // Envelopes are printed to the centimetre.
      if (
        Math.abs(item.width - item.envelope[0]) > 0.011 ||
        Math.abs(item.depth - item.envelope[1]) > 0.011
      )
        throw new Error(
          `${label}: ${id} is drawn ${item.width.toFixed(3)} × ${item.depth.toFixed(3)} m, model ${item.envelope.join(" × ")} m.`,
        );
      if (item.marker.width > 32 || item.marker.height > 32)
        throw new Error(`${label}: ${id}'s marker grew beyond a fixed target.`);
    }
  }

  // The drawing refits a few frames after a keyboard resize. Measure once the
  // pane has the requested width and the room has held still for three frames.
  let settles = 0;
  function settledWidth(width) {
    settles += 1;
    return page.waitForFunction(
      function settled([expected, key]) {
        const divider = document.querySelector(
          '.workflow-scene [aria-label="Resize floor plan"]',
        );
        const room = document
          .querySelector(".workflow-scene .spatial-room-boundary")
          .getBoundingClientRect();
        const outline = [room.x, room.y, room.width, room.height].join();
        const frames =
          window[key]?.outline === outline ? window[key].frames : -1;
        window[key] = { outline, frames: frames + 1 };
        return (
          divider?.getAttribute("aria-valuenow") === String(expected) &&
          window[key].frames >= 3
        );
      },
      [width, `floorPlanSettle${settles}`],
      { polling: "raf" },
    );
  }

  const inspector = page.getByRole("button", {
    name: "Close Inspector",
    exact: true,
  });
  if (await inspector.isVisible()) await inspector.click();
  const plan = page.locator(".workflow-scene .spatial-floor-plan");
  if (!(await plan.isVisible()))
    await page.locator("#workflow-toggle-floorPlan").click();
  const map = plan.locator(".spatial-floor-map");
  await map.locator('button[data-resource="cool"]').waitFor();
  await page.waitForFunction(
    'document.querySelectorAll(".workflow-scene .spatial-floor-map g.spatial-footprint").length === 5',
  );
  await page.getByRole("button", { name: "Top view", exact: true }).click();
  const fitted = await map.evaluate(measure);
  assertTrueScale(fitted, "Fitted plan");
  const production = fitted.items;
  await page.screenshot({ path: `${evidence}/production-fitted.png` });

  // Start from the minimum width so earlier runs' stored widths do not matter.
  const divider = page.getByRole("separator", { name: "Resize floor plan" });
  const minimum = Number(await divider.getAttribute("aria-valuemin"));
  await divider.focus();
  await page.keyboard.press("Home");
  await settledWidth(minimum);
  const narrow = await map.evaluate(measure);
  assertTrueScale(narrow, "Narrow pane");
  for (let step = 0; step < 12; step++) await page.keyboard.press("ArrowRight");
  await settledWidth(
    Math.min(
      minimum + 12 * 24,
      Number(await divider.getAttribute("aria-valuemax")),
    ),
  );
  const resized = await map.evaluate(measure);
  assertTrueScale(resized, "Resized pane");
  if (resized.room.width <= narrow.room.width)
    throw new Error("Widening the pane must enlarge the room.");

  const cooling = resized.items.cool.marker;
  await page.mouse.move(cooling.x, cooling.y);
  await page.mouse.wheel(0, -400);
  const zoomed = await map.evaluate(measure);
  assertTrueScale(zoomed, "Zoomed plan");
  if (zoomed.pixelsPerMetre < resized.pixelsPerMetre * 1.5)
    throw new Error("Scrolling over the plan must zoom it.");
  if (
    Math.abs(zoomed.items.cool.marker.x - cooling.x) > 1 ||
    Math.abs(zoomed.items.cool.marker.y - cooling.y) > 1
  )
    throw new Error("Zoom must stay centred on the pointer.");
  if (
    (await plan.evaluate(function scrolled(panel) {
      return panel.scrollTop;
    })) !== 0
  )
    throw new Error("Zooming must not scroll the plan panel.");

  // Dragging the empty floor pans the plan. A drag that starts on an
  // appliance moves the appliance instead (store-layout-browser).
  const start = await map.evaluate(function emptyFloorPoint(element) {
    const rect = element.getBoundingClientRect();
    for (let y = rect.top + 40; y < rect.bottom - 40; y += 12)
      for (let x = rect.left + 40; x < rect.right - 40; x += 12) {
        const hit = document.elementFromPoint(x, y);
        if (
          hit !== null &&
          element.contains(hit) &&
          hit.closest("button, g.spatial-footprint") === null
        )
          return { x, y };
      }
    return null;
  });
  if (start === null) throw new Error("No empty floor in view.");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 70, start.y + 30, { steps: 6 });
  await page.mouse.up();
  const panned = await map.evaluate(measure);
  assertTrueScale(panned, "Panned plan");
  for (const id of Object.keys(zoomed.items)) {
    const dx = panned.items[id].marker.x - zoomed.items[id].marker.x;
    const dy = panned.items[id].marker.y - zoomed.items[id].marker.y;
    if (Math.abs(dx + 70) > 1 || Math.abs(dy - 30) > 1)
      throw new Error(
        `Panning moved ${id} by ${dx}, ${dy} instead of -70, 30.`,
      );
  }
  for (const [id, item] of Object.entries(panned.items))
    if (item.pressed !== zoomed.items[id].pressed)
      throw new Error(`Panning changed the selection of ${id}.`);
  await page.screenshot({ path: `${evidence}/production-zoomed.png` });

  const packing = panned.items.pack.fill;
  await plan.getByRole("button", { name: "Fit room", exact: true }).click();
  const refitted = await map.evaluate(measure);
  if (Math.abs(refitted.pixelsPerMetre - resized.pixelsPerMetre) > 0.01)
    throw new Error("Fit room must restore the fitted scale.");
  const pack = refitted.items.pack.fill;
  await page.mouse.click(pack.x + pack.width - 3, pack.y + pack.height - 3);
  if (!(await map.evaluate(measure)).items.pack.pressed)
    throw new Error("Clicking a footprint must select it.");
  if (packing.width === pack.width)
    throw new Error("The zoomed and fitted plans must differ in scale.");
  await plan
    .getByRole("button", { name: "Fit selection", exact: true })
    .click();
  const framed = await map.evaluate(measure);
  assertTrueScale(framed, "Fit selection");
  const mapBox = await map.boundingBox();
  const controlsBox = await plan.locator(".spatial-plan-stack").boundingBox();
  const framedPack = framed.items.pack.marker;
  // Framing centres the selection between the 10 px inset and the view
  // controls, keeping an 8 px gap from them.
  if (
    mapBox === null ||
    controlsBox === null ||
    Math.abs(framedPack.x - (mapBox.x + 10 + controlsBox.x - 8) / 2) > 3 ||
    framed.pixelsPerMetre <= refitted.pixelsPerMetre * 2
  )
    throw new Error("Fit selection must frame the selected equipment.");
  if (framed.items.pack.fill.x + framed.items.pack.fill.width > controlsBox.x)
    throw new Error("Framed equipment must stay clear of the view controls.");
  await page.screenshot({ path: `${evidence}/production-selection.png` });

  await map.locator('button[data-resource="pack"]').focus();
  await page.keyboard.press("-");
  const keyboardOut = await map.evaluate(measure);
  if (keyboardOut.pixelsPerMetre >= framed.pixelsPerMetre)
    throw new Error("The minus key must zoom out.");
  await page.keyboard.press("0");
  if (
    Math.abs(
      (await map.evaluate(measure)).pixelsPerMetre - resized.pixelsPerMetre,
    ) > 0.01
  )
    throw new Error("The 0 key must fit the room.");

  await page.locator("#workflow-toggle-floorPlan").click();
  // The corner overview is opt-in beside the 3D view's camera controls.
  const overviewToggle = page.getByRole("button", {
    name: "Floor plan overview",
    exact: true,
  });
  if ((await overviewToggle.getAttribute("aria-pressed")) !== "true")
    await overviewToggle.click();
  const overview = page.locator(".workflow-scene .spatial-minimap");
  await overview.waitFor();
  const minimap = overview.locator(".spatial-floor-map");
  const small = await minimap.evaluate(measure);
  assertTrueScale(small, "Overview");
  const smallBox = await minimap.boundingBox();
  if (smallBox === null) throw new Error("Missing floor plan overview.");
  await page.mouse.move(
    smallBox.x + smallBox.width / 2,
    smallBox.y + smallBox.height / 2,
  );
  await page.mouse.wheel(0, -400);
  if (
    Math.abs(
      (await minimap.evaluate(measure)).pixelsPerMetre - small.pixelsPerMetre,
    ) > 0.001
  )
    throw new Error("The overview must stay fitted to the room.");
  await page.screenshot({ path: `${evidence}/production-overview.png` });

  // Native inspection: the same stations, and an oven door that swings.
  await openRecordingViewer(page);
  const setup = page.getByRole("button", {
    name: "Setup & files",
    exact: true,
  });
  const filesTab = page.getByRole("tab", {
    name: "Compare & files",
    exact: true,
  });
  if (!(await filesTab.isVisible())) await setup.click();
  await filesTab.click();
  await page
    .getByLabel("Recording file (.json)")
    .setInputFiles(
      "assets/bakery-mujoco/fr10-workcell/recordings/oven-loading.json",
    );
  await setup.click();
  const rehearsal = page.locator(".physics-replay");
  const nativePlan = rehearsal.locator(".spatial-floor-plan");
  if (!(await nativePlan.isVisible()))
    await rehearsal
      .getByRole("button", { name: "Floor plan", exact: true })
      .click();
  const nativeMap = nativePlan.locator(".spatial-floor-map");
  await page.waitForFunction(
    'document.querySelectorAll(".physics-replay g.spatial-footprint[data-context=true]").length === 5',
  );
  await page.waitForFunction(
    'document.querySelector(".physics-replay .spatial-room-boundary")?.getBoundingClientRect().width > 200',
  );
  const native = await nativeMap.evaluate(measure);
  assertTrueScale(native, "Native plan");
  for (const id of ["stage", "portion", "bake", "cool", "pack"]) {
    const context = native.items[`context:${id}`];
    if (
      context === undefined ||
      !context.context ||
      context.envelope.join() !== production[id].envelope.join()
    )
      throw new Error(`Native plan must show the 3D view's ${id} station.`);
  }
  await nativeMap.locator('button[data-resource="maruzen-shelf-3"]').click();
  await nativePlan
    .getByRole("button", { name: "Fit selection", exact: true })
    .click();
  const details = rehearsal.locator(".spatial-selection-inspector");
  await details.getByText("Inspect oven door", { exact: true }).click();
  await nativePlan.locator(".spatial-opening-envelope:not([hidden])").waitFor();
  const angle = details.getByRole("slider", {
    name: "Preview door angle (degrees)",
  });
  await angle.focus();
  await page.keyboard.press("Home");
  await details
    .getByText("Door preview · 0° · Playback paused", { exact: true })
    .waitFor();
  const closed = await nativeMap.evaluate(measure);
  assertTrueScale(closed, "Closed door");
  await page.keyboard.press("End");
  await details
    .getByText("Door preview · 110° · Playback paused", { exact: true })
    .waitFor();
  const open = await nativeMap.evaluate(measure);
  assertTrueScale(open, "Open door");
  const closedOven = closed.items["maruzen-shelf-3"];
  const openOven = open.items["maruzen-shelf-3"];
  if (
    openOven.width * openOven.depth <
    closedOven.width * closedOven.depth + 0.05
  )
    throw new Error("Opening the door must extend the oven's outline.");
  if (
    !(await nativeMap
      .locator('rect[data-envelope="maruzen-shelf-3"]')
      .isVisible())
  )
    throw new Error(
      "An open door leaves floor inside the envelope; show the envelope.",
    );
  await page.screenshot({ path: `${evidence}/native-door-open.png` });
  await details
    .getByRole("button", { name: "Return to recorded door pose" })
    .click();

  // scene-lighting-browser proves the orthographic Top view of this scene.
  await page
    .getByRole("button", { name: "Back to production", exact: true })
    .click();
  return {
    result: "passed",
    fittedPixelsPerMetre: fitted.pixelsPerMetre,
    resizedPixelsPerMetre: resized.pixelsPerMetre,
    zoomedPixelsPerMetre: zoomed.pixelsPerMetre,
    stationsAtModelScale: Object.keys(production).length,
    nativeContextStations: 5,
    ovenOutlineClosed: [closedOven.width, closedOven.depth],
    ovenOutlineOpen: [openOven.width, openOven.depth],
  };
}
