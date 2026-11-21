async (page) => {
  // Agents on the canvas (Plan 40B phase 7, slices 1 to 4: acceptance
  // journey 5), against a local Worker with its own D1 and the Plan 81
  // harness's simulated model. The model streams each board edit's
  // arguments in parts, as a real model does: the fields one by one, then
  // the text two letters at a time.
  //
  // The owner opens the Menus page with the chat beside it, makes a free
  // canvas board and asks the chat to change it, one edit for each request:
  // move the heading, resize it, add a note, rewrite the note. A private
  // chat holds each board edit until the owner allows it (Plan 27C): the
  // board shows no agent then. After the Allow the owner asks again, and the
  // owner and a second person who watches the same board see the agent on
  // the canvas while the edit lands: its own colour, a cursor at the real
  // target (an arrow for a move, a crosshair for a resize or a new element,
  // a text cursor for a text), a name tag with an AI mark, the action and
  // the size, an outline around the element and its badge in the layers
  // list. The evidence holds every presence frame that names an agent.
  //
  // Slices 3 and 4: the second person is a viewer. While the model writes
  // a move, the viewer sees a dashed ghost box at the rect that the model
  // wrote, and then the element goes there in one 240 ms motion. While it
  // writes the new note, the viewer sees the ghost box with "Generating …"
  // and its size before the element exists, then the note's text as the
  // model writes it, then the element with the agent's tag; the owner drags
  // another element at the same time, and both views converge. A text
  // change shows its text so far over its element. The viewer's own edit
  // is refused.
  //
  // Run: python3 scripts/plan-81/run-browser.py --journey scripts/plan-40b/browser-board-agent.js \
  //   --entry /menu-chat-preview.html --setup-path /test/setup-menu \
  //   --artifacts output/playwright/plan-40b-agent
  const WORKER = "http://127.0.0.1:8881";
  const PORTAL = "http://127.0.0.1:3181";
  const MOVE = "Move the board heading down a little.";
  const RESIZE = "Make the board heading bigger.";
  const ADD = "Add a note under the board heading.";
  const WRITE = "Change the note to say until 11:00.";
  const STOP = "Add a long welcome note under the board heading.";
  const STOP_TEXT = "Welcome to our café.";
  const AGAIN = "Ask again: I allowed it.";
  const ASKED = "Seams Pantry asked you for approval in this chat. Ask me again after you allow it.";
  const DONE = "I changed the board.";
  const NOTE = "Oat milk is free today";
  const NOTE_AFTER = "Oat milk is free until 11:00";
  const fixtures = JOURNEY_FIXTURES;
  const artifacts = JOURNEY_ARTIFACTS;
  const checks = [];
  const captures = [];
  const marks = [];
  function check(name, passed, detail) {
    checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(detail ?? null)}`);
  }
  async function capture(target, name) {
    await target.screenshot({ path: `${artifacts}/${name}.png` });
    captures.push(`${name}.png`);
  }
  async function csrf() {
    const cookies = await page.context().cookies(WORKER);
    return cookies.find((cookie) => cookie.name === "satyr_control_csrf")?.value;
  }
  async function enableCapability(capabilityId) {
    const base = `${PORTAL}/v1/control/organisations/${fixtures.organisationId}/access-control`;
    const view = (await (await page.request.get(base)).json()).accessControl;
    const capability = view.capabilities.find((candidate) => candidate.definition.capabilityId === capabilityId);
    const response = await page.request.post(`${base}/capabilities/${capabilityId}`, {
      headers: {
        origin: PORTAL,
        "content-type": "application/json",
        "x-satyr-csrf": await csrf(),
        "idempotency-key": crypto.randomUUID(),
      },
      data: {
        expectedRevision: view.revision,
        capabilityRevision: capability.revision,
        capabilityVersion: 1,
        mode: "enabled",
      },
    });
    check(`The owner turned on ${capabilityId}`, response.ok(), response.status());
  }
  async function ask(text) {
    await page.getByRole("button", { name: "Send message", exact: true }).waitFor({ timeout: 60_000 });
    const composer = page.getByPlaceholder(/^Ask anything/u);
    await composer.fill(text);
    await composer.press("Enter");
  }
  async function modelState() {
    return (await page.request.get(`${WORKER}/test/model`)).json();
  }
  /** Waits until a locator matches more elements than before. */
  async function more(locator, before, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while ((await locator.count()) <= before) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${locator}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  /** The agent operations that a page has seen in its presence frames. */
  const operations = (target) => target.evaluate(() =>
    [...new Set(window.__agentFrames.flatMap((frame) => frame.agents.map((agent) => agent.operationId)))]);
  /**
   * One edit: the owner asks, the private chat holds the edit, the owner
   * allows it and asks again. The board shows no new agent action before
   * the Allow: no draft, no ghost box and no label. A frame may still
   * repeat the hold of the edit before.
   */
  async function editWithAllow(request, other, name) {
    const asked = page.getByText(ASKED, { exact: true });
    const askedBefore = await asked.count();
    const before = [await operations(page), await operations(other)];
    await ask(request);
    await more(asked, askedBefore);
    const after = [await operations(page), await operations(other)];
    const added = after.map((seen, index) => seen.filter((operation) => !before[index].includes(operation)));
    check(`No agent action showed on the canvas before the Allow (${name})`,
      added.every((operationIds) => operationIds.length === 0), { added });
    const prompt = page.getByRole("dialog", { name: "Sous Chef wants to do one step" });
    await prompt.waitFor({ timeout: 30_000 });
    if (name === "move") await capture(page, "21-edit-asks");
    // The allowed prompt minimizes into a toast that says so.
    const allowed = page.getByText("Request allowed", { exact: true });
    const allowedBefore = await allowed.count();
    await prompt.getByRole("button", { name: "Allow", exact: true }).click();
    await more(allowed, allowedBefore, 15_000);
    await ask(`${request} ${AGAIN}`);
  }
  async function answered(count) {
    await more(page.getByText(DONE, { exact: true }), count - 1);
  }

  // Every presence frame of the board's room that names an agent, as the
  // browser received it: the JSON timeline of the evidence.
  const recordFrames = () => {
    const frames = [];
    window.__agentFrames = frames;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string" || !event.data.includes("\"agents\"")) return;
          try {
            const message = JSON.parse(event.data);
            if (!Array.isArray(message.agents) || message.agents.length === 0) return;
            frames.push({
              at: Date.now(),
              agents: message.agents.map((activity) => ({
                agent: activity.agent.displayName,
                colorKey: activity.agent.colorKey ?? null,
                kind: activity.action?.kind ?? null,
                state: activity.action?.state ?? null,
                operationId: activity.operationId,
                elementIds: activity.action?.elementIds ?? [],
                rect: activity.action?.rect ?? null,
                field: activity.action?.field ?? null,
                textLength: typeof activity.action?.text === "string" ? [...activity.action.text].length : null,
              })),
            });
          } catch {
            // A frame that is not JSON names no agent.
          }
        });
      }
    };
    // Every motion of a board element: the agent's move is the only one.
    window.__agentMotions = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList?.contains("menu-board-canvas-element"))
        window.__agentMotions.push({
          at: Date.now(),
          elementId: this.getAttribute("data-element-id"),
          duration: typeof options === "object" ? options.duration : options,
          keyframes,
        });
      return animate.call(this, keyframes, options);
    };
  };
  /** The board rect of an element's box, in board units (1600 by 900). */
  async function boardRect(target, locator) {
    const overlay = await target.locator(".menu-canvas-overlay").boundingBox();
    const box = await locator.boundingBox();
    if (overlay === null || box === null) return null;
    const scale = overlay.width / 1600;
    return {
      x: Math.round((box.x - overlay.x) / scale),
      y: Math.round((box.y - overlay.y) / scale),
      width: Math.round(box.width / scale),
      height: Math.round(box.height / scale),
    };
  }
  function near(first, second, tolerance = 2) {
    return first !== null && second !== null &&
      ["x", "y", "width", "height"].every((key) => Math.abs(first[key] - second[key]) <= tolerance);
  }
  /** The arguments of the newest board edit that the model wrote. */
  async function lastEdit() {
    const requests = (await modelState()).modelRequests;
    const edit = requests.filter((request) => request.call === "menu_board_edit").at(-1);
    return { args: edit?.args ?? null, parts: edit?.parts ?? null };
  }
  /** Waits for the draft text to show part of the text, and returns it. */
  async function partialText(target, selector, full) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const texts = await target.locator(selector).allInnerTexts();
      const text = texts[0]?.trim() ?? "";
      if (text.length > 0 && text.length < full.length) return text;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out: part of ${full} in ${selector}`);
  }
  /** The screen rect of an element on the canvas. */
  async function elementBox(target, elementId) {
    return target.locator(`.menu-canvas-hit[data-element-id="${elementId}"]`).boundingBox();
  }
  /**
   * The agent's mark for one edit: its cursor, tag and outline. The cursor
   * stands at the element's real corner, with no travel between targets.
   */
  async function seeMark(target, who, expected, shot) {
    // The cursor's box is a point (zero size) at its target.
    const mark = target.locator(`.menu-canvas-agent[data-kind="${expected.kind}"][data-state="applied"]`);
    await mark.waitFor({ state: "attached", timeout: 15_000 });
    // The mark shows for the room's 5 s hold: the picture comes first.
    if (shot !== undefined) await capture(target, shot);
    check(`${who} sees the agent's tag (${expected.kind})`, await mark.locator(".menu-canvas-agent-tag").isVisible());
    const tag = (await mark.locator(".menu-canvas-agent-tag").innerText()).replace(/\s+/gu, " ").trim();
    check(`${who} sees the agent's name tag with the AI mark (${expected.kind})`, /^AI \S/u.test(tag), tag);
    check(`${who} sees the action label (${expected.kind})`, tag.includes(expected.label), tag);
    if (expected.size !== undefined)
      check(`${who} sees the size badge (${expected.kind})`, tag.includes(expected.size), tag);
    const color = await mark.getAttribute("data-agent-color");
    check(`${who} sees the agent's own colour`, color === "violet", color);
    const pointer = await mark.evaluate((node) => {
      const svg = node.querySelector(".menu-canvas-agent-pointer");
      return { classes: svg?.getAttribute("class") ?? "" };
    });
    check(`${who} sees the ${expected.cursor} cursor`, pointer.classes.includes(`lucide-${expected.cursor}`), pointer.classes);
    const outline = target.locator(`.menu-canvas-agent-outline[data-element-id="${expected.elementId}"]`);
    check(`${who} sees the agent's outline around the element`, await outline.isVisible());
    const element = await elementBox(target, expected.elementId);
    const at = await mark.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y };
    });
    const corner = expected.corner === "end"
      ? { x: element.x + element.width, y: element.y + element.height }
      : expected.corner === "text"
        ? { x: element.x, y: element.y + Math.min(element.height / 2, 40 * (element.width / expected.rectWidth)) }
        : { x: element.x, y: element.y };
    check(`${who} sees the cursor at the element's real corner (${expected.kind})`,
      Math.abs(at.x - corner.x) <= 2 && Math.abs(at.y - corner.y) <= 2,
      { cursor: { x: at.x, y: at.y }, corner });
    return tag;
  }

  async function run() {
    const session = await page.request.post(`${WORKER}/test/session?user=Owner`);
    if (!session.ok()) throw new Error("Session failed for Owner");
    const owner = await session.json();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await enableCapability("commerce.menu_draft.read");
    await enableCapability("commerce.menu_draft.edit");
    await page.addInitScript(recordFrames);
    const url = `${PORTAL}/menu-chat-preview.html?organisation=${fixtures.organisationId}&preferenceUser=${owner.userId}`;
    await page.goto(url);
    const start = page.getByRole("form", { name: "Start a board" });
    await start.waitFor({ timeout: 60_000 });
    await start.locator(`input[value="canvas_landscape:template"]`).check();
    await start.getByLabel("Name", { exact: true }).fill("Spring board");
    await start.getByRole("button", { name: "Create board", exact: true }).click();
    await page.locator(".menu-canvas-hit").first().waitFor({ timeout: 30_000 });
    const boards = (await (await page.request.get(
      `${PORTAL}/v1/control/organisations/${fixtures.organisationId}/menu-boards`,
    )).json());
    const boardId = boards.boards?.[0]?.boardId ?? null;
    await capture(page, "20-board-before");

    // A viewer watches the same board in another browser.
    const otherContext = await page.context().browser().newContext();
    const other = await otherContext.newPage();
    await other.setViewportSize({ width: 1920, height: 1080 });
    const otherSession = await other.request.post(`${WORKER}/test/session?user=Member`);
    if (!otherSession.ok()) throw new Error("Session failed for the viewer");
    const otherUser = await otherSession.json();
    await other.addInitScript(recordFrames);
    await other.goto(`${PORTAL}/menu-chat-preview.html?organisation=${fixtures.organisationId}&preferenceUser=${otherUser.userId}`);
    await other.locator(".menu-canvas-hit").first().waitFor({ timeout: 60_000 });
    const timeline = [];

    // 1. Move. The viewer sees the ghost box at the rect that the model
    // wrote, then the heading goes there in one motion.
    await editWithAllow(MOVE, other, "move");
    const moveGhost = other.locator(`.menu-canvas-agent-ghost[data-kind="move"]`);
    await moveGhost.waitFor({ timeout: 60_000 });
    await capture(other, "30-viewer-sees-move-ghost");
    const moveEdit = await lastEdit();
    const moveRect = await boardRect(other, moveGhost);
    const askedMove = { x: moveEdit.args.x, y: moveEdit.args.y, width: moveEdit.args.width, height: moveEdit.args.height };
    check("The viewer sees the ghost box at the rect that the model wrote (move)", near(moveRect, askedMove), { ghost: moveRect, asked: askedMove });
    check("The model wrote the move in parts", (moveEdit.parts ?? 0) > 5, moveEdit.parts);
    timeline.push({ edit: "move", ghost: moveRect, asked: askedMove, parts: moveEdit.parts });
    await page.locator(`.menu-canvas-agent[data-kind="move"][data-state="applied"]`).waitFor({ state: "attached", timeout: 60_000 });
    const movedId = await page.locator(".menu-canvas-agent-outline").first().getAttribute("data-element-id");
    const expectedMove = { kind: "move", label: "moving Spring board", cursor: "mouse-pointer-2", corner: "start", elementId: movedId };
    marks.push({
      edit: "move",
      owner: await seeMark(page, "The owner", expectedMove, "22-agent-moves-heading"),
      other: await seeMark(other, "The viewer", expectedMove, "22b-viewer-sees-move"),
    });
    const motions = (await other.evaluate(() => window.__agentMotions)).filter((motion) => motion.elementId === movedId);
    check("The viewer saw the heading go to its new rect in one 240 ms motion",
      motions.length === 1 && motions[0].duration === 240 &&
        motions[0].keyframes.at(-1)?.top === `${askedMove.y}px`,
      motions);
    check("The heading stands at the rect that the model wrote",
      near(await boardRect(other, other.locator(`.menu-canvas-hit[data-element-id="${movedId}"]`)), askedMove), askedMove);
    await answered(1);

    // 2. Resize: a crosshair at the far corner of the new size.
    await editWithAllow(RESIZE, other, "resize");
    await other.locator(`.menu-canvas-agent-ghost[data-kind="resize"]`).waitFor({ timeout: 60_000 });
    const resized = { kind: "resize", label: "resizing Spring board", cursor: "crosshair", corner: "end", elementId: movedId };
    marks.push({
      edit: "resize",
      owner: await seeMark(page, "The owner", resized, "23-agent-resizes-heading"),
      other: await seeMark(other, "The viewer", resized),
    });
    await answered(2);

    // 3. A new note. The viewer sees the ghost box with its size before the
    // element exists, then the text as the model writes it. The owner drags
    // another element meanwhile.
    await editWithAllow(ADD, other, "create");
    const ghost = other.locator(`.menu-canvas-agent-ghost[data-kind="create"]`);
    await ghost.waitFor({ timeout: 60_000 });
    const generating = await ghost.locator(".menu-canvas-agent-generating").innerText().catch(() => "");
    await capture(other, "31-viewer-sees-ghost-box");
    check("The ghost box says Generating", generating.includes("Generating"), generating);
    const createEdit = await lastEdit();
    const askedNote = { x: createEdit.args.x, y: createEdit.args.y, width: createEdit.args.width, height: createEdit.args.height };
    const ghostRect = await boardRect(other, ghost);
    check("The viewer sees the ghost box at the rect that the model wrote (create)", near(ghostRect, askedNote), { ghost: ghostRect, asked: askedNote });
    const ghostTag = (await other.locator(`.menu-canvas-agent[data-kind="create"][data-state="pending"] .menu-canvas-agent-tag`).innerText()).replace(/\s+/gu, " ");
    check("The viewer sees the ghost box's size badge", ghostTag.includes("640 × 96"), ghostTag);
    const hitsBefore = await page.locator(".menu-canvas-hit").count();
    check("The note is not on the board yet", (await other.locator(".menu-canvas-hit").count()) === hitsBefore);
    // The owner drags another element while the model writes.
    const ids = await page.locator(".menu-canvas-hit").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-element-id")));
    const draggedId = ids.filter((id) => id !== movedId).at(-1);
    const dragged = page.locator(`.menu-canvas-hit[data-element-id="${draggedId}"]`);
    const box = await dragged.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1)
      await page.mouse.move(box.x + box.width / 2 + step * 6, box.y + box.height / 2 + step * 4);
    // Slice 5: the owner's drag shows its size and the red distance to the
    // nearest element on each side, for the owner and for the viewer, and
    // each actor's selection shows on the rulers in that actor's colour.
    const ownMeasure = page.locator(`.menu-canvas-measure[data-who="You"]`);
    await ownMeasure.locator(".menu-canvas-spacing").first().waitFor({ timeout: 5_000 });
    const draggedRect = await boardRect(page, dragged);
    const sizeShown = (await ownMeasure.locator(".menu-canvas-measure-size").innerText()).trim();
    check("The owner sees the size of the box that the owner drags",
      sizeShown === `${draggedRect.width} × ${draggedRect.height}`, { sizeShown, draggedRect });
    const shownGaps = async (target, who) => Object.fromEntries(await target
      .locator(`.menu-canvas-measure[data-who="${who}"] .menu-canvas-spacing`)
      .evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("data-side"), Number(node.getAttribute("data-distance"))])));
    const ownerGaps = await shownGaps(page, "You");
    // The distance to the nearest element on each side, or to the edge.
    const others = [];
    for (const id of ids.filter((candidate) => candidate !== draggedId))
      others.push(await boardRect(page, page.locator(`.menu-canvas-hit[data-element-id="${id}"]`)));
    const r = draggedRect;
    const overlapsY = (o) => o.y < r.y + r.height && o.y + o.height > r.y;
    const overlapsX = (o) => o.x < r.x + r.width && o.x + o.width > r.x;
    const least = (values, edge) => values.length === 0 ? edge : Math.min(...values);
    const expectedGaps = {
      left: least(others.filter((o) => overlapsY(o) && o.x + o.width <= r.x).map((o) => r.x - o.x - o.width), r.x),
      right: least(others.filter((o) => overlapsY(o) && o.x >= r.x + r.width).map((o) => o.x - r.x - r.width), 1600 - r.x - r.width),
      top: least(others.filter((o) => overlapsX(o) && o.y + o.height <= r.y).map((o) => r.y - o.y - o.height), r.y),
      bottom: least(others.filter((o) => overlapsX(o) && o.y >= r.y + r.height).map((o) => o.y - r.y - r.height), 900 - r.y - r.height),
    };
    check("The owner sees the red distance to the nearest element or edge on each side",
      Object.entries(expectedGaps).every(([side, distance]) => distance <= 0
        ? ownerGaps[side] === undefined
        : Math.abs((ownerGaps[side] ?? -99) - distance) <= 2),
      { shown: ownerGaps, expected: expectedGaps });
    await other.locator(`.menu-canvas-measure[data-who="Owner"] .menu-canvas-spacing`).first().waitFor({ timeout: 5_000 });
    // The viewer's frames of the drag can trail the last mouse step a little.
    let viewerGaps = await shownGaps(other, "Owner");
    const same = (gaps) => Object.keys(ownerGaps).length === Object.keys(gaps).length &&
      Object.keys(ownerGaps).every((side) => Math.abs((gaps[side] ?? -99) - ownerGaps[side]) <= 2);
    for (let wait = 0; wait < 30 && !same(viewerGaps); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      viewerGaps = await shownGaps(other, "Owner");
    }
    check("The viewer sees the owner's drag with the same distances",
      same(viewerGaps), { owner: ownerGaps, viewer: viewerGaps });
    const range = async (target, selector) => target.locator(`.menu-canvas-ruler[data-axis="x"] ${selector}`).first()
      .evaluate((node) => ({ start: Number(node.getAttribute("data-start")), end: Number(node.getAttribute("data-end")) }));
    const ownRange = await range(page, `.menu-canvas-ruler-range[data-who="You"]`);
    check("The owner's selection shows on the ruler", Math.abs(ownRange.start - r.x) <= 2 && Math.abs(ownRange.end - r.x - r.width) <= 2, { ownRange, r });
    const agentRange = await range(other, `.menu-canvas-ruler-range[data-agent-color="violet"]`);
    check("The viewer sees the agent's new box on the ruler in the agent's colour",
      agentRange.start === askedNote.x && agentRange.end === askedNote.x + askedNote.width, agentRange);
    const ownerOnViewerRuler = await other.locator(`.menu-canvas-ruler[data-axis="y"] .menu-canvas-ruler-range[data-who="Owner"]`).count();
    check("The viewer sees the owner's selection on the rulers", ownerOnViewerRuler === 1, ownerOnViewerRuler);
    await capture(page, "35-owner-drags-with-spacing");
    await capture(other, "36-viewer-sees-drag-spacing");
    timeline.push({ edit: "owner drag", rect: draggedRect, gaps: ownerGaps, viewerGaps });
    const written = await partialText(other, ".menu-canvas-agent-ghost .menu-canvas-agent-letters", NOTE);
    await capture(other, "32-viewer-sees-text-as-written");
    await page.mouse.up();
    check("The viewer sees part of the note as the model writes it", NOTE.startsWith(written), written);
    timeline.push({ edit: "create", ghost: ghostRect, asked: askedNote, parts: createEdit.parts, textSeen: written });
    const created = page.locator(`.menu-canvas-agent[data-kind="create"][data-state="applied"]`);
    await created.waitFor({ state: "attached", timeout: 60_000 });
    const noteId = await page.locator(".menu-canvas-agent-outline").first().getAttribute("data-element-id");
    const createdMark = { kind: "create", label: `placing ${NOTE}`, size: "640 × 96", cursor: "crosshair", corner: "end", elementId: noteId };
    marks.push({
      edit: "create",
      owner: await seeMark(page, "The owner", createdMark, "24-agent-adds-note"),
      other: await seeMark(other, "The viewer", createdMark, "33-viewer-sees-note"),
    });
    // Slice 6: the presence bar shows the people and the agent, the number
    // of active agents and the changes of the agent's request.
    const bar = other.locator(".menu-presence-bar");
    const people = await bar.locator(".menu-presence-person").count();
    const barAgent = (await bar.locator(".menu-presence-agent").innerText()).replace(/\s+/gu, " ").trim();
    const counts = (await bar.locator(".menu-presence-count").allInnerTexts()).map((text) => text.trim());
    check("The viewer's presence bar shows both people and the agent", people === 2 && barAgent === "AI · Sous Chef", { people, barAgent });
    check("The viewer's presence bar counts the active agent and its change",
      counts.includes("1 agent active") && counts.includes("Sous Chef: 1 change"), counts);
    check("The viewer sees no Stop and no words of the agent",
      (await bar.locator(".menu-presence-stop").count()) === 0 && (await bar.locator(".menu-presence-words").count()) === 0);
    await capture(other, "37-viewer-presence-bar");
    const layer = await page.locator(".menu-canvas-layer-agent").first().innerText();
    check("The layers list shows the agent on its element", layer.includes("AI"), layer);
    check("The note stands at the rect that the model wrote",
      near(await boardRect(other, other.locator(`.menu-canvas-hit[data-element-id="${noteId}"]`)), askedNote), askedNote);
    // Both views converge: the owner's drag and the agent's note.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const ownerDragged = await boardRect(page, page.locator(`.menu-canvas-hit[data-element-id="${draggedId}"]`));
    const viewerDragged = await boardRect(other, other.locator(`.menu-canvas-hit[data-element-id="${draggedId}"]`));
    check("The owner's drag landed and the viewer sees the same rect", near(ownerDragged, viewerDragged, 1), { owner: ownerDragged, viewer: viewerDragged });
    check("The owner's drag moved the element", box !== null && ownerDragged !== null);
    await answered(3);

    // 4. A text: the rewrite shows over the note as the model writes it.
    await editWithAllow(WRITE, other, "text");
    // Slice 6: Follow is off until the viewer turns it on; then the view
    // keeps the agent's real target in its middle, and the viewer's own
    // input turns it off.
    await other.locator(".menu-canvas-agent-draft").waitFor({ timeout: 60_000 });
    const followButton = other.locator(".menu-presence-follow");
    check("Follow is off at first", (await followButton.getAttribute("aria-pressed")) === "false");
    await followButton.click();
    const viewport = await other.locator(".menu-board-viewport").boundingBox();
    let draftBox = await other.locator(".menu-canvas-agent-draft").boundingBox();
    for (let wait = 0; wait < 20 && draftBox !== null &&
      Math.abs(draftBox.x + draftBox.width / 2 - (viewport.x + viewport.width / 2)) > 3; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      draftBox = await other.locator(".menu-canvas-agent-draft").boundingBox();
    }
    const middle = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
    check("Follow keeps the agent's target in the middle of the view",
      draftBox !== null && Math.abs(draftBox.x + draftBox.width / 2 - middle.x) <= 3 &&
        Math.abs(draftBox.y + draftBox.height / 2 - middle.y) <= 3,
      { draftBox, middle });
    const rewrite = await partialText(other, ".menu-canvas-agent-draft .menu-canvas-agent-letters", NOTE_AFTER);
    await capture(other, "34-viewer-sees-rewrite");
    await other.mouse.move(middle.x, middle.y + 200);
    await other.mouse.wheel(0, 120);
    check("The viewer's own input turned Follow off", (await followButton.getAttribute("aria-pressed")) === "false");
    check("The viewer sees part of the rewrite as the model writes it", NOTE_AFTER.startsWith(rewrite), rewrite);
    timeline.push({ edit: "text", textSeen: rewrite, parts: (await lastEdit()).parts });
    const writtenMark = { kind: "text", label: `writing ${NOTE_AFTER}`, cursor: "text-cursor", corner: "text", elementId: noteId, rectWidth: 640 };
    marks.push({
      edit: "text",
      owner: await seeMark(page, "The owner", writtenMark, "25-agent-writes-note"),
      other: await seeMark(other, "The viewer", writtenMark, "25b-viewer-sees-text"),
    });
    await answered(4);
    // The hold ends, and the agent leaves the canvas.
    await page.locator(".menu-canvas-agent").first().waitFor({ state: "detached", timeout: 15_000 });
    check("The agent left the canvas after its hold", (await page.locator(".menu-canvas-agent").count()) === 0);
    await capture(page, "26-board-after");
    const shown = await page.locator(".menu-board .menu-board-text").allInnerTexts();
    check("The board shows the agent's note", shown.some((text) => text.includes(NOTE_AFTER)), shown);
    const viewerShown = await other.locator(".menu-board .menu-board-text").allInnerTexts();
    check("The viewer's board shows the same note", viewerShown.some((text) => text.includes(NOTE_AFTER)), viewerShown);
    check("The page did not reload", (await page.evaluate(() => performance.getEntriesByType("navigation").length)) === 1);

    // 5. Slice 6: the owner, who asked, sees Stop on the board's presence
    // bar and stops the request there, through the chat's own Cancel. The
    // ghost box goes away, and the note never lands.
    await editWithAllow(STOP, other, "stop");
    const stopGhost = other.locator(`.menu-canvas-agent-ghost[data-kind="create"]`);
    await stopGhost.waitFor({ timeout: 60_000 });
    const ownerBar = page.locator(".menu-presence-bar");
    const stopButton = ownerBar.locator(".menu-presence-stop");
    await stopButton.waitFor({ timeout: 10_000 });
    const ownerWords = await ownerBar.locator(".menu-presence-words").allInnerTexts();
    check("The viewer sees no Stop on the agent that the owner asked",
      (await other.locator(".menu-presence-stop").count()) === 0 && (await other.locator(".menu-presence-words").count()) === 0);
    await capture(page, "38-owner-sees-stop");
    const hitsBeforeStop = await other.locator(".menu-canvas-hit").count();
    await stopButton.click();
    await page.getByRole("button", { name: "Send message", exact: true }).waitFor({ timeout: 30_000 });
    check("Stop on the board ended the owner's chat request",
      (await page.getByRole("button", { name: "Stop response", exact: true }).count()) === 0);
    await stopGhost.waitFor({ state: "detached", timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const afterStop = await other.locator(".menu-board .menu-board-text").allInnerTexts();
    check("The stopped note never landed",
      (await other.locator(".menu-canvas-hit").count()) === hitsBeforeStop && !afterStop.some((text) => text.includes(STOP_TEXT)),
      { before: hitsBeforeStop, after: await other.locator(".menu-canvas-hit").count() });
    timeline.push({ edit: "stop", ownerWords });

    // The viewer's own edit is refused.
    const viewerCookies = await other.context().cookies(WORKER);
    const refused = await other.request.post(
      `${PORTAL}/v1/control/organisations/${fixtures.organisationId}/menu-boards/${boardId}/versions`,
      {
        headers: {
          origin: PORTAL,
          "content-type": "application/json",
          "x-satyr-csrf": viewerCookies.find((cookie) => cookie.name === "satyr_control_csrf")?.value ?? "",
          "idempotency-key": crypto.randomUUID(),
        },
        data: { label: "Viewer version" },
      },
    );
    const refusedBody = await refused.text();
    check("The board refused the viewer's own edit",
      refused.status() === 404 && refusedBody.includes("organisation_role_insufficient"),
      { status: refused.status(), body: refusedBody.slice(0, 300) });

    const ownerFrames = await page.evaluate(() => window.__agentFrames);
    const otherFrames = await other.evaluate(() => window.__agentFrames);
    const kinds = (frames) => [...new Set(frames.flatMap((frame) => frame.agents.map((agent) => `${agent.kind}:${agent.state}`)))];
    check("The viewer received the agent's actions",
      ["move:pending", "move:applied", "resize:applied", "create:pending", "create:applied", "text:pending", "text:applied"]
        .every((kind) => kinds(otherFrames).includes(kind)),
      kinds(otherFrames));
    check("Every frame names an action at a real target",
      otherFrames.every((frame) => frame.agents.every((agent) =>
        agent.kind !== null && (agent.elementIds.length > 0 || agent.rect !== null))));
    const lengths = otherFrames.flatMap((frame) => frame.agents.filter((agent) => agent.kind === "create" && agent.textLength !== null).map((agent) => agent.textLength));
    check("The viewer received the note's text in several growing parts",
      lengths.length >= 3 && lengths.every((length, index) => index === 0 || length >= lengths[index - 1]) && lengths.at(-1) === NOTE.length,
      lengths);
    await otherContext.close();
    const model = await modelState();
    return {
      result: "passed",
      boardId,
      layer,
      marks,
      timeline,
      frames: { owner: ownerFrames, viewer: otherFrames },
      viewerFrameCount: otherFrames.length,
      modelRequests: model.modelRequests.length,
      checks,
      captures,
    };
  }
  try {
    return await run();
  } catch (error) {
    await capture(page, "failure").catch(() => undefined);
    return {
      result: "failed",
      error: String(error),
      pageText: (await page.locator("body").innerText().catch(() => "")).slice(-3_000),
      frames: await page.evaluate(() => window.__agentFrames ?? null).catch(() => null),
      checks,
      captures,
    };
  }
};
