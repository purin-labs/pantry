/**
 * Plan 84 Journey J1, browser part: the Workflow view of each of the eight recipe
 * simulations shows the recipe's real steps and prerequisites. The compilers
 * produce the graph, so the expected edges below are recipe facts that a wrong
 * importer or binding would break. Each step follows its stage through a real
 * run, and its drawer moves the simulation.
 *
 * pnpm bakery:browser --journey scripts/production-simulation/verify-workflow-graph-browser.js \
 *   --url http://127.0.0.1:3114/factory-acceptance.html --output <directory> --timeout 900000
 */
async function verifyWorkflowGraphBrowser(page) {
  const recipes = [
    {
      id: "siphon",
      card: /^Siphon coffee physics/,
      form: "Siphon coffee recipe",
      prepare: "Prepare siphon coffee",
      edges: [
        ["preheat-seal", "upflow"],
        ["steep", "whirlpool"],
      ],
      absent: [],
      roles: { upflow: "process", "fold-in": "work" },
      first: "preheat-seal",
      later: "drawdown",
    },
    {
      id: "latte",
      card: /^Caffe Latte/,
      form: "Caffe latte recipe",
      prepare: "Prepare caffe latte",
      edges: [
        ["transfer-cup", "pour-latte"],
        ["steam-whirlpool", "pour-latte"],
        ["espresso-shot", "transfer-cup"],
      ],
      absent: [["espresso-shot", "steam-stretch"]],
      roles: { "espresso-shot": "process", "pour-latte": "work" },
      first: "place-cup",
      later: "return-pitcher",
    },
    {
      id: "black-sesame",
      card: /^Black Sesame Milk/,
      form: "Black sesame milk Cobot recipe",
      prepare: "Prepare Black Sesame Milk 3D station",
      edges: [
        ["wash-and-fill-bottle-a", "clean-batch-vessels"],
        ["wash-and-fill-bottle-b", "clean-batch-vessels"],
        ["stage-cold-carrier", "transfer-cold-carrier"],
      ],
      absent: [],
      roles: { "transfer-cold-carrier": "robot", "cool-in-bath": "process" },
      first: "weigh-sesame",
      later: "return-jug",
    },
    {
      id: "ginger-tea",
      card: /^Ginger Black Tea/,
      form: "Ginger tea 3D MuJoCo pan-staging recipe",
      prepare: "Prepare Ginger Tea 3D station",
      edges: [["stage-both-pans", "stage-pan-b"]],
      branches: { "discard-extract": "reject" },
      absent: [],
      roles: {
        "stage-pan-b": "robot",
        "inspect-strained-tea": "check",
        "discard-extract": "reject",
        "serve-milk-tea": "accept",
      },
      first: "wash-initial-pan",
      later: "return-clean-pan-b-and-strainer",
    },
    {
      id: "financier-batter",
      card: /^Financier Batter/,
      form: "Financier batter Cobot recipe",
      prepare: "Prepare Financier batter station",
      edges: [
        ["brown-butter", "return-pan"],
        ["return-pan", "mix"],
      ],
      absent: [],
      roles: { mix: "work" },
      first: "weigh-butter",
      later: "put-away",
    },
    {
      id: "financier-bake",
      card: /^Financier Bake/,
      form: "Financier bake Cobot recipe",
      prepare: "Prepare Financier bake station",
      edges: [
        ["preheat", "load-oven"],
        ["fill-cavity-8", "load-oven"],
        ["examine-bake", "inspect-bake"],
      ],
      absent: [],
      roles: { bake: "process", "inspect-bake": "check" },
      first: "prepare-mould",
      later: "cool-in-mould",
    },
    {
      id: "financier-pack",
      card: /^Financier Pack/,
      form: "Financier pack Cobot recipe",
      prepare: "Prepare Financier pack station",
      edges: [
        ["demould", "clean-mould"],
        ["demould", "crumb-wait"],
        ["demould", "pack-ready"],
        ["crumb-check", "stage-cold-carrier"],
        ["pack-ready", "stage-cold-carrier"],
        ["handoff-cold-carrier", "release-for-packing"],
      ],
      absent: [],
      roles: {
        "transfer-cold-carrier": "robot",
        "release-for-packing": "check",
      },
      first: "demould",
      later: "return-grid",
    },
    {
      id: "cafe-shift",
      card: /^Combined Café Shift/,
      form: "Combined café shift recipe",
      prepare: "Prepare combined café shift",
      edges: [
        ["store-batter", "prepare-mould"],
        ["preheat", "load-oven"],
      ],
      absent: [],
      roles: { "prepare-espresso": "robot", "inspect-bake": "check" },
      first: "weigh-butter",
      later: "return-grid",
    },
  ];
  const fixture = new URL(page.url()).href;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const report = [];

  function fail(recipe, message, detail) {
    throw new Error(`${recipe.id}: ${message}: ${JSON.stringify(detail)}`);
  }
  async function clock(workspace) {
    return Number(
      await workspace
        .getByLabel("Simulation seconds", { exact: true })
        .textContent(),
    );
  }
  function nodes(graph) {
    return graph.locator(".recipe-graph-node").evaluateAll((items) =>
      items.map((item) => ({
        key: item.dataset.graphNode,
        state: item.dataset.state,
        role: item.dataset.role,
        box: {
          x: item.parentElement.offsetLeft,
          y: item.parentElement.offsetTop,
          width: item.offsetWidth,
          height: item.offsetHeight,
        },
        clipped: item.scrollHeight > item.clientHeight + 1,
      })),
    );
  }

  for (const recipe of recipes) {
    await page.goto(fixture);
    await page.getByRole("button", { name: "Recipes", exact: true }).click();
    const form = page.getByRole("form", { name: recipe.form, exact: true });
    await page
      .getByRole("button", { name: "← Back", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: recipe.card }).click();
    await form.waitFor({ timeout: 30000 });
    await form
      .getByRole("button", { name: recipe.prepare, exact: true })
      .click();
    const workspace = page.getByRole("region", {
      name: "Persistent production",
    });
    await workspace
      .getByRole("group", { name: "Surface view" })
      .getByRole("button", { name: "Workflow", exact: true })
      .click();
    const graph = workspace.getByRole("group", {
      name: "Recipe prerequisites",
    });
    await graph.waitFor({ timeout: 30000 });
    await page
      .locator(
        '.recipe-graph[data-graph="ready"], .recipe-graph[data-graph="failed"]',
      )
      .waitFor({ timeout: 120000 });
    if ((await graph.getAttribute("data-graph")) !== "ready")
      fail(recipe, "the graph failed", await graph.textContent());

    const edges = await graph
      .locator("g[data-prerequisite]")
      .evaluateAll((items) =>
        items.map((item) => ({
          from: item.dataset.prerequisite.split("/").at(-1),
          to: item.dataset.dependent.split("/").at(-1),
          branch: item.dataset.branch ?? null,
        })),
      );
    function hasEdge(from, to) {
      return edges.some((edge) => edge.from === from && edge.to === to);
    }
    for (const [from, to] of recipe.edges)
      if (!hasEdge(from, to))
        fail(recipe, "a prerequisite is missing", [from, to]);
    for (const [from, to] of recipe.absent)
      if (hasEdge(from, to))
        fail(recipe, "an arrow is not a prerequisite", [from, to]);
    for (const [key, outcome] of Object.entries(recipe.branches ?? {}))
      if (!edges.some((edge) => edge.to === key && edge.branch === outcome))
        fail(recipe, "a branch arrow is missing", { key, outcome, edges });

    const prepared = await nodes(graph);
    for (const [key, role] of Object.entries(recipe.roles))
      if (prepared.find((node) => node.key === key)?.role !== role)
        fail(recipe, "a step has the wrong role", { key, role, prepared });
    if (prepared.some((node) => node.state !== "not-started"))
      fail(recipe, "a step started before the run", prepared);
    // The café shift computes its whole timeline, so each of its stages can seek.
    const details = page.getByRole("complementary", { name: "Step details" });
    const go = details.getByRole("button", { name: "Go to this step" });
    await graph.locator(`[data-graph-node="${recipe.later}"]`).first().click();
    if (recipe.id !== "cafe-shift" && !(await go.isDisabled()))
      fail(recipe, "a step that has not run accepts a seek", recipe.later);
    await details.getByRole("button", { name: "Close step details" }).click();
    for (const node of prepared) {
      if (node.clipped) fail(recipe, "a step label is clipped", node);
      for (const other of prepared) {
        if (other === node) continue;
        const apart =
          node.box.x + node.box.width <= other.box.x ||
          other.box.x + other.box.width <= node.box.x ||
          node.box.y + node.box.height <= other.box.y ||
          other.box.y + other.box.height <= node.box.y;
        if (!apart) fail(recipe, "two steps overlap", [node, other]);
      }
    }
    await page.screenshot({ path: `workflow-graph-${recipe.id}-prepared.png` });

    // Record which steps run from inside the page, so no change is missed.
    await page.evaluate(() => {
      window.__stepLog = new Set();
      window.__stepTimer = window.setInterval(() => {
        for (const node of document.querySelectorAll(
          '.recipe-graph-node[data-state="current"]',
        ))
          window.__stepLog.add(node.dataset.graphNode);
      }, 16);
    });
    await workspace
      .getByRole("button", { name: "Start production", exact: true })
      .click();
    await workspace
      .getByRole("button", { name: "Run again", exact: true })
      .waitFor({ timeout: 300000 });
    const ran = await page.evaluate(() => {
      window.clearInterval(window.__stepTimer);
      return [...window.__stepLog];
    });
    if (!ran.includes(recipe.first) || !ran.includes(recipe.later))
      fail(recipe, "a step never showed as current", ran);
    const finished = await nodes(graph);
    const status = await workspace
      .getByLabel("Execution status", { exact: true })
      .textContent();
    if (status !== "completed")
      fail(recipe, "the run did not complete", status);
    if (finished.some((node) => node.state !== "done"))
      fail(recipe, "a step is not done after the run", finished);

    // A step moves the simulation back to the start of its stage.
    const before = await clock(workspace);
    await graph.locator(`[data-graph-node="${recipe.first}"]`).first().click();
    await go.click();
    await page.waitForFunction(
      (limit) =>
        Number(
          document.querySelector('[aria-label="Simulation seconds"]')
            ?.textContent,
        ) < limit,
      before / 2,
      { timeout: 5000 },
    );
    const after = await clock(workspace);
    await details.getByRole("button", { name: "Close step details" }).click();
    await page.screenshot({ path: `workflow-graph-${recipe.id}-done.png` });
    report.push({
      recipe: recipe.id,
      steps: prepared.length,
      arrows: edges.length,
      branchArrows: edges.filter((edge) => edge.branch !== null).length,
      stepsSeenCurrent: ran.length,
      seek: { before, after },
    });
  }
  return { result: "passed", recipes: report };
}
