async function verifyLargeSharedArchiveBrowser(page) {
  const setup = await page.request.get("http://127.0.0.1:8840/fixture/setup");
  if (!setup.ok())
    throw new Error("Start the isolated archive acceptance runtime.");
  const fixture = await setup.json();
  const connection = await page.context().newCDPSession(page);
  const memory = {
    active: true,
    peakUsedSize: 0,
    peakBackingStorageSize: 0,
    samples: 0,
  };
  const measuring = measureArchiveMemory(connection, memory);
  try {
    await page.addScriptTag({
      content: `${largeArchiveRead.toString()}\n${largeArchiveWrite.toString()}`,
    });
    const published = await page.evaluate(publishLargeArchive, fixture);
    await connection.send("HeapProfiler.collectGarbage");
    const publishedHeap = await connection.send("Runtime.getHeapUsage");
    await page.reload();
    await page.addScriptTag({
      content: `${largeArchiveRead.toString()}\n${largeArchiveWrite.toString()}`,
    });
    const reopened = await page.evaluate(reopenLargeArchive, {
      fixture,
      published,
    });
    await connection.send("HeapProfiler.collectGarbage");
    const reopenedHeap = await connection.send("Runtime.getHeapUsage");
    await page.screenshot({ path: "large-shared-archive.png", fullPage: true });
    if (
      publishedHeap.usedSize > 128 * 1024 * 1024 ||
      reopenedHeap.usedSize > 128 * 1024 * 1024
    )
      throw new Error(
        "The shared archive retains more than 128 MiB on the main-page heap.",
      );
    return {
      result: "passed",
      published,
      reopened,
      publishedHeap,
      reopenedHeap,
      sampledPeak: {
        usedSize: memory.peakUsedSize,
        backingStorageSize: memory.peakBackingStorageSize,
        samples: memory.samples,
      },
      memoryScope:
        "Main-page heap with 50 ms sampling and collection endpoints; worker/process peaks remain separate gates",
      environment:
        "local Chromium and Workerd with real D1/R2 and production authorization",
    };
  } finally {
    memory.active = false;
    await measuring;
    await connection.detach();
  }
}

async function measureArchiveMemory(connection, memory) {
  while (memory.active) {
    const sample = await connection.send("Runtime.getHeapUsage");
    memory.peakUsedSize = Math.max(memory.peakUsedSize, sample.usedSize);
    memory.peakBackingStorageSize = Math.max(
      memory.peakBackingStorageSize,
      sample.backingStorageSize,
    );
    memory.samples++;
    await new Promise(archiveMemoryDelay);
  }
}
function archiveMemoryDelay(resolve) {
  setTimeout(resolve, 50);
}
async function largeArchiveRead(path) {
  const { responseJson } = await import("/src/control-client.ts");
  return responseJson(await fetch(path, { credentials: "same-origin" }));
}
async function largeArchiveWrite(path, body) {
  const { responseJson } = await import("/src/control-client.ts");
  return responseJson(
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-satyr-csrf": window.archiveCsrf,
      },
      body: JSON.stringify(body),
    }),
  );
}
async function publishLargeArchive(fixture) {
  document.cookie = `satyr_control_session=${fixture.sessions[0].token}; Path=/; SameSite=Lax`;
  document.cookie = `satyr_control_csrf=${fixture.sessions[0].csrfToken}; Path=/; SameSite=Lax`;
  window.archiveCsrf = fixture.sessions[0].csrfToken;
  const { readOvenRunFile } =
    await import("/src/features/production-run/oven-recipe-file.ts");
  const { preparePersistentWorkspaceRun, savePreparedWorkspaceRun } =
    await import("/src/features/workflow-simulator/workspace-runs-api.ts");
  const source = new URL(location.href).searchParams.get("archive");
  if (source === null)
    throw new Error("Provide the full recurring-run archive URL.");
  const file = await (await fetch(source)).blob();
  const importStarted = performance.now();
  const opened = await readOvenRunFile(new File([file], "recurring-run.json"));
  if (!opened.ok || opened.value.kind !== "snapshot")
    throw new Error("Cannot import the recurring archive.");
  const importedMs = performance.now() - importStarted;
  const prepared = await preparePersistentWorkspaceRun(
    "Complete 24-order native stress archive",
    opened.value.save,
  );
  const started = performance.now();
  const saved = await savePreparedWorkspaceRun(
    fixture.organisationId,
    largeArchiveWrite,
    prepared,
    largeArchiveRead,
  );
  if (saved.kind !== "verified") throw new Error(JSON.stringify(saved));
  let artifactBytes = 0;
  for (const artifact of opened.value.save.document.artifacts)
    artifactBytes += artifact.byteLength;
  return {
    id: prepared.id,
    archiveBytes: file.size,
    documentBytes: prepared.bytes,
    artifacts: opened.value.save.artifacts.length,
    artifactBytes,
    time: opened.value.save.document.state.position.time,
    events: opened.value.save.document.state.events.length,
    importedMs,
    publishedAndReadBackMs: performance.now() - started,
  };
}
async function reopenLargeArchive({ fixture, published }) {
  document.cookie = `satyr_control_session=${fixture.sessions[1].token}; Path=/; SameSite=Lax`;
  document.cookie = `satyr_control_csrf=${fixture.sessions[1].csrfToken}; Path=/; SameSite=Lax`;
  window.archiveCsrf = fixture.sessions[1].csrfToken;
  const { openPersistentWorkspaceRun } =
    await import("/src/features/workflow-simulator/shared-production-run.ts");
  const started = performance.now();
  const opened = await openPersistentWorkspaceRun(
    fixture.organisationId,
    published.id,
    largeArchiveRead,
  );
  if (
    opened.save.document.state.position.time !== published.time ||
    opened.save.document.state.events.length !== published.events ||
    opened.save.artifacts.length !== published.artifacts
  )
    throw new Error("A fresh reader did not recover the exact saved factory.");
  const milliseconds = performance.now() - started;
  document.getElementById("root").textContent =
    `Shared archive verified: ${published.artifacts} files, ${published.artifactBytes} bytes. Fresh reader: ${Math.round(milliseconds)} ms.`;
  return {
    milliseconds,
    time: published.time,
    events: published.events,
    artifacts: opened.save.artifacts.length,
  };
}
