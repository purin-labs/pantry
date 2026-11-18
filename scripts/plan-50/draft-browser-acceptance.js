async (page) => {
  const origin = "http://127.0.0.1:8836";
  const context = await page.context().browser().newContext({
    recordVideo: { dir: "output/playwright", size: { width: 1000, height: 800 } },
  });
  const other = await context.newPage();
  const editor = page.getByRole("textbox", { name: "Shared description" });
  const otherEditor = other.getByRole("textbox", { name: "Shared description" });
  const path = `${origin}/v1/control/organisations/organisation_plan50_seams/commerce/products/product_financier/description-draft`;
  const checks = [];
  try {
    await other.goto(`${origin}/fixture/user/2`);
    await other.getByText("Synced", { exact: true }).waitFor();
    if (await editor.inputValue() !== "Almond financier." ||
        await otherEditor.inputValue() !== "Almond financier.") throw new Error("Initial drafts differ");
    const initial = await (await page.request.get(path)).json();
    await page.getByRole("button", { name: "Start agent assignment" }).click();
    let status = {};
    let deadline = Date.now() + 30_000;
    while (!status.readComplete && Date.now() < deadline) {
      status = await (await page.request.get(`${origin}/fixture/draft`)).json();
      if (!status.readComplete) await page.waitForTimeout(100);
    }
    if (!status.readComplete) throw new Error("Agent did not finish the initial read");
    await page.getByRole("button", { name: "Observe agent execution" }).click();
    await other.getByRole("button", { name: "Observe agent execution" }).click();
    const execution = page.getByRole("status", { name: "Agent execution" });
    const otherExecution = other.getByRole("status", { name: "Agent execution" });
    deadline = Date.now() + 10_000;
    while (!(await execution.textContent()).includes("Using codemode.") && Date.now() < deadline)
      await page.waitForTimeout(100);
    deadline = Date.now() + 10_000;
    while (!(await otherExecution.textContent()).includes("Using codemode.") && Date.now() < deadline)
      await page.waitForTimeout(100);
    const initialExecution = JSON.parse(await execution.textContent());
    if (!JSON.stringify(initialExecution).includes("Using codemode.") ||
        JSON.stringify(initialExecution) !== await otherExecution.textContent())
      throw new Error("Shared accepted execution views differ");
    checks.push("both authenticated operators observe the same accepted tool progress");
    await page.getByRole("button", { name: "Inspect active tasks", exact: true }).click();
    await other.getByRole("button", { name: "Inspect active tasks", exact: true }).click();
    const taskList = page.getByRole("list", { name: "Agent tasks", exact: true });
    const otherTaskList = other.getByRole("list", { name: "Agent tasks", exact: true });
    await taskList.waitFor();
    await otherTaskList.waitFor();
    const activeTasks = await taskList.innerText();
    if (!activeTasks.includes("Working") || activeTasks !== await otherTaskList.innerText())
      throw new Error("Active Portal task views differ");
    checks.push("both authenticated operators inspect matching native work through the existing Portal TaskList");
    await otherEditor.fill("Toasted almond financier.");
    await other.getByText("Synced", { exact: true }).waitFor();
    deadline = Date.now() + 10_000;
    while (await editor.inputValue() !== "Toasted almond financier." && Date.now() < deadline)
      await page.waitForTimeout(100);
    if (await editor.inputValue() !== "Toasted almond financier.") throw new Error("Human edit did not converge");
    await page.request.post(`${origin}/fixture/draft`, { data: { stage: "human" } });
    deadline = Date.now() + 30_000;
    while (await editor.inputValue() !== "Golden toasted almond financier." && Date.now() < deadline)
      await page.waitForTimeout(100);
    if (await editor.inputValue() !== "Golden toasted almond financier.") throw new Error("Agent edit was not accepted");
    checks.push("human target change converges before the stale agent attempt; fresh bounded edit preserves human wording");
    await other.getByRole("button", { name: "Queue draft follow-up" }).click();
    const queuedInput = other.getByRole("status", { name: "Queued input" });
    deadline = Date.now() + 10_000;
    while (await queuedInput.textContent() === "No queued input" && Date.now() < deadline)
      await page.waitForTimeout(100);
    const queued = JSON.parse(await queuedInput.textContent());
    if (queued.status !== "queued") throw new Error("Follow-up was not durably queued");
    await page.getByRole("button", { name: "Inspect active tasks", exact: true }).click();
    await other.getByRole("button", { name: "Inspect active tasks", exact: true }).click();
    const pendingMessages = page.getByRole("list", { name: "Queued messages", exact: true });
    const otherPendingMessages = other.getByRole("list", { name: "Queued messages", exact: true });
    await pendingMessages.getByRole("listitem").waitFor();
    await otherPendingMessages.getByRole("listitem").waitFor();
    const pendingText = await pendingMessages.innerText();
    if (!pendingText.includes("Read the saved draft again after recovery.") ||
        pendingText !== await otherPendingMessages.innerText()) throw new Error("Shared pending input differs");
    await other.reload();
    await other.getByText("Synced", { exact: true }).waitFor();
    await other.getByRole("button", { name: "Inspect active tasks", exact: true }).click();
    await otherPendingMessages.getByRole("listitem").waitFor();
    if (pendingText !== await otherPendingMessages.innerText()) throw new Error("Reconnect lost the pending input");
    checks.push("both operators read the same native queued input through the Portal parser; reconnect preserves it");
    await otherEditor.fill("Golden toasted almond financier. Serve with tea.");
    await other.getByText("Synced", { exact: true }).waitFor();
    deadline = Date.now() + 10_000;
    while (await editor.inputValue() !== "Golden toasted almond financier. Serve with tea." && Date.now() < deadline)
      await page.waitForTimeout(100);
    if (await editor.inputValue() !== "Golden toasted almond financier. Serve with tea.") throw new Error("Later human edit did not converge");
    await context.setOffline(true);
    await page.request.post(`${origin}/fixture/draft`, { data: { stage: "override" } });
    deadline = Date.now() + 30_000;
    while (!status.recovered && Date.now() < deadline) {
      try {
        status = await (await page.request.get(`${origin}/fixture/draft`)).json();
      } catch {}
      if (!status.recovered) await page.waitForTimeout(100);
    }
    if (!status.recovered) throw new Error("Agent did not recover its accepted edit");
    await context.setOffline(false);
    await page.reload();
    await other.reload();
    await page.getByText("Synced", { exact: true }).waitFor();
    await other.getByText("Synced", { exact: true }).waitFor();
    const recovered = await (await page.request.get(path)).json();
    const otherRecovered = await (await other.request.get(path)).json();
    if (JSON.stringify(recovered) !== JSON.stringify(otherRecovered)) throw new Error("Recovered draft snapshots differ");
    if (await editor.inputValue() !== "Golden toasted almond financier. Serve with tea." ||
        await otherEditor.inputValue() !== "Golden toasted almond financier. Serve with tea.") throw new Error("Recovery lost the human edit");
    checks.push("both editors reload the same persisted draft after process loss and receipt recovery");
    await page.getByRole("button", { name: "Observe agent execution" }).click();
    await other.getByRole("button", { name: "Observe agent execution" }).click();
    deadline = Date.now() + 10_000;
    while (!(await execution.textContent()).includes("Review it before publication.") && Date.now() < deadline)
      await page.waitForTimeout(100);
    deadline = Date.now() + 10_000;
    while (!(await otherExecution.textContent()).includes("Review it before publication.") && Date.now() < deadline)
      await page.waitForTimeout(100);
    const recoveredExecution = JSON.parse(await execution.textContent());
    if (!JSON.stringify(recoveredExecution).includes("Review it before publication.") ||
        JSON.stringify(recoveredExecution) !== await otherExecution.textContent())
      throw new Error("Recovered execution views differ");
    checks.push("both operators recover the same accepted execution and reply after restart");
    await other.getByRole("button", { name: "Steer draft follow-up" }).click();
    deadline = Date.now() + 30_000;
    while (!status.complete && Date.now() < deadline) {
      status = await (await page.request.get(`${origin}/fixture/draft`)).json();
      if (!status.complete) await page.waitForTimeout(100);
    }
    if (!status.complete) throw new Error("Steered draft did not complete");
    const steering = JSON.parse(await other.getByRole("status", { name: "Steering input" }).textContent());
    if (!steering.accepted) throw new Error("Steering was not accepted");
    await page.getByRole("button", { name: "Observe queued follow-up" }).click();
    await other.getByRole("button", { name: "Observe queued follow-up" }).click();
    const queuedExecution = page.getByRole("status", { name: "Queued execution" });
    const otherQueuedExecution = other.getByRole("status", { name: "Queued execution" });
    // The steer joined this turn, so each view holds the whole turn once its
    // replay reaches the answer.
    deadline = Date.now() + 10_000;
    while (!(await queuedExecution.textContent()).includes("The draft is ready for review.") && Date.now() < deadline)
      await page.waitForTimeout(100);
    deadline = Date.now() + 10_000;
    while (!(await otherQueuedExecution.textContent()).includes("The draft is ready for review.") && Date.now() < deadline)
      await page.waitForTimeout(100);
    const recoveredQueuedExecution = JSON.parse(await queuedExecution.textContent());
    if (!JSON.stringify(recoveredQueuedExecution).includes("Using product_description_draft_read.") ||
        JSON.stringify(recoveredQueuedExecution) !== await otherQueuedExecution.textContent())
      throw new Error("Recovered queued execution views differ");
    checks.push("an authorized contributor queues a follow-up before restart and steers its running turn after recovery; both observers see the same accepted progress");
    await page.getByRole("button", { name: "Observe steered execution" }).click();
    await other.getByRole("button", { name: "Observe steered execution" }).click();
    const steeredExecution = page.getByRole("status", { name: "Steered execution" });
    const otherSteeredExecution = other.getByRole("status", { name: "Steered execution" });
    deadline = Date.now() + 10_000;
    while (!(await steeredExecution.textContent()).includes("The draft is ready for review.") && Date.now() < deadline)
      await page.waitForTimeout(100);
    deadline = Date.now() + 10_000;
    while (!(await otherSteeredExecution.textContent()).includes("The draft is ready for review.") && Date.now() < deadline)
      await page.waitForTimeout(100);
    const acceptedSteeredExecution = JSON.parse(await steeredExecution.textContent());
    if (!JSON.stringify(acceptedSteeredExecution).includes("The draft is ready for review.") ||
        JSON.stringify(acceptedSteeredExecution) !== await otherSteeredExecution.textContent())
      throw new Error("Steered execution views differ");
    checks.push("the steer joins the running turn: both operators observe its answer in that turn without another draft edit");
    await page.getByRole("button", { name: "Review draft", exact: true }).click();
    await otherEditor.fill("Golden toasted almond financier. Serve with tea. Enjoy fresh.");
    await other.getByText("Synced", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Send for approval", exact: true }).click();
    deadline = Date.now() + 15_000;
    const submitted = page.getByRole("status", { name: "Submitted proposal" });
    while (await submitted.textContent() === "No proposal" && Date.now() < deadline)
      await page.waitForTimeout(100);
    const proposal = JSON.parse(await submitted.textContent());
    if (proposal.details.description !== recovered.draft.description) throw new Error("Proposal changed the reviewed snapshot");
    checks.push("review freezes the exact saved snapshot while later human edits continue");
    await page.screenshot({ path: "output/playwright/r50-draft-first.png", fullPage: true });
    await other.screenshot({ path: "output/playwright/r50-draft-second.png", fullPage: true });
    const evidence = { checks, initial, recovered, otherRecovered, initialExecution, recoveredExecution, queued, recoveredQueuedExecution, steering, acceptedSteeredExecution, proposal };
    await page.request.post(`${origin}/fixture/draft`, { data: { stage: "observed", evidence } });
    await page.getByRole("button", { name: "Read publication result", exact: true }).click();
    await other.getByRole("button", { name: "Read publication result", exact: true }).click();
    const pendingAction = page.getByRole("status", { name: "Publication result" });
    const otherPendingAction = other.getByRole("status", { name: "Publication result" });
    deadline = Date.now() + 10_000;
    while ((await pendingAction.textContent() === "No publication result" ||
            await otherPendingAction.textContent() === "No publication result") && Date.now() < deadline)
      await page.waitForTimeout(100);
    const approvalAction = JSON.parse(await pendingAction.textContent());
    if (approvalAction.state !== "proposed" || approvalAction.receipt !== null ||
        JSON.stringify(approvalAction) !== await otherPendingAction.textContent())
      throw new Error("Operators do not share the same pending approval action");
    await other.reload();
    await other.getByRole("button", { name: "Read publication result", exact: true }).click();
    deadline = Date.now() + 10_000;
    while (await otherPendingAction.textContent() === "No publication result" && Date.now() < deadline)
      await page.waitForTimeout(100);
    if (JSON.stringify(approvalAction) !== await otherPendingAction.textContent())
      throw new Error("Pending approval changed after observer reconnect");
    checks.push("both operators observe the same pending governed action; reconnect preserves its approval identity and no receipt appears before approval");
    await page.request.post(`${origin}/fixture/draft`, { data: { stage: "approval_observed", evidence: { action: approvalAction, reconnect: true } } });
    deadline = Date.now() + 60_000;
    status = {};
    while (!status.publicationNonce && Date.now() < deadline) {
      try {
        status = await (await page.request.get(`${origin}/fixture/draft`)).json();
      } catch {
        // The provider response loss replaces the local runtime.
      }
      if (!status.publicationNonce) await page.waitForTimeout(100);
    }
    if (status.publicationNonce !== proposal.nonce) throw new Error("Publication did not settle");
    await page.reload();
    await other.reload();
    await page.getByRole("button", { name: "Read publication result", exact: true }).click();
    await other.getByRole("button", { name: "Read publication result", exact: true }).click();
    const publicationOutput = page.getByRole("status", { name: "Publication result" });
    const otherPublicationOutput = other.getByRole("status", { name: "Publication result" });
    deadline = Date.now() + 10_000;
    while ((await publicationOutput.textContent() === "No publication result" ||
            await otherPublicationOutput.textContent() === "No publication result") && Date.now() < deadline)
      await page.waitForTimeout(100);
    const publication = JSON.parse(await publicationOutput.textContent());
    if (publication.state !== "confirmed" || publication.receipt === null ||
        JSON.stringify(publication) !== await otherPublicationOutput.textContent())
      throw new Error("Operators did not receive the same confirmed publication receipt");
    checks.push("both authenticated operators recover the same confirmed publication result after provider response loss");
    await page.getByRole("button", { name: "Inspect completed tasks", exact: true }).click();
    await other.getByRole("button", { name: "Inspect completed tasks", exact: true }).click();
    await taskList.waitFor();
    await otherTaskList.waitFor();
    const completedTasks = await taskList.innerText();
    if (completedTasks.includes("Working") || completedTasks.includes("Pending") ||
        completedTasks.includes("Cancelled") || !completedTasks.includes("Completed") ||
        completedTasks !== await otherTaskList.innerText()) throw new Error("Recovered Portal task views differ");
    checks.push("after queue, native steering and process loss, both task views hold completed work and nothing cancelled");
    if (await pendingMessages.getByRole("listitem").count() !== 0 ||
        await otherPendingMessages.getByRole("listitem").count() !== 0) throw new Error("Completed inputs remain queued");
    checks.push("the answered queued and steering inputs leave both pending-input views empty");
    await page.screenshot({ path: "output/playwright/r50-draft-publication-first.png", fullPage: true });
    await other.screenshot({ path: "output/playwright/r50-draft-publication-second.png", fullPage: true });
    await page.request.post(`${origin}/fixture/draft`, { data: { stage: "delivered", evidence: { publication, checks } } });
    evidence.publication = publication;
    return evidence;
  } finally {
    await context.setOffline(false);
    await context.close();
    await other.video().saveAs("output/playwright/r50-draft-operator.webm");
  }
}
