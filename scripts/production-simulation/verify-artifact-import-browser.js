async function verifyArtifactImportBrowser(page) {
  const params = new URL(page.url()).searchParams;
  const evidence = params.get("evidence");
  const expected = await (
    await page.request.get(new URL(`${evidence}/report.json`, page.url()).href)
  ).json();
  if (expected.result !== "passed")
    throw new Error("Run the complete live storage journey first");
  const directory = decodeURIComponent(
    new URL(evidence, page.url()).pathname,
  ).replace(/^\/@fs\/+/u, "/");
  await page.addScriptTag({ content: readImportedArtifact.toString() });
  await page.evaluate(addArchiveInput);
  const connection = await page.context().newCDPSession(page);
  await page
    .locator("#archive-input")
    .setInputFiles(`${directory}/recurring-run.json`);
  const current = await page.evaluate(
    importStoredRun,
    expected.checks.completed.snapshot,
  );
  await connection.send("HeapProfiler.collectGarbage");
  const heap = await connection.send("Runtime.getHeapUsage");
  await connection.detach();
  if (heap.usedSize > 128 * 1024 * 1024)
    throw new Error("Import retained more than 128 MiB of JavaScript data");
  const original = await page.evaluate(stageArtifactLifetime, "create");
  const other = await page.context().newPage();
  await other.goto(page.url());
  const sibling = await other.evaluate(stageArtifactLifetime, "create");
  await page.evaluate(stageArtifactLifetime, "read");
  await page.reload();
  const replaced = await page.evaluate(stageArtifactLifetime, "create");
  for (const name of original.directories)
    if (replaced.directories.includes(name))
      throw new Error("A replacement page retained abandoned staging");
  for (const name of sibling.directories)
    if (
      !original.directories.includes(name) &&
      !replaced.directories.includes(name)
    )
      throw new Error("Cleanup removed an active tab's staging");
  await other.evaluate(stageArtifactLifetime, "read");
  await other.close();
  return {
    result: "passed",
    current,
    heap,
    activeTabPreserved: true,
    abandonedStagingRemoved: true,
  };
}

async function stageArtifactLifetime(mode) {
  const { sourceUrl } = await import("/source-url.js");
  const content =
    'A checkpoint with Unicode 水 and escaped framing: "{}[]\\\n\u0000';
  if (mode === "create") {
    const { RunArtifactStore } = await import(
      sourceUrl(
        "areas/kitchen/ui/features/production-run/run-artifact-store.ts",
      )
    );
    const { sha256Hex } = await import("/@id/@purin-labs/std");
    const store = await RunArtifactStore.create();
    const digest = await sha256Hex(new TextEncoder().encode(content));
    await store.retain(digest, new Blob([JSON.stringify({ digest, content })]));
    window.lifetimeArtifact = store.files.get(digest);
  }
  if ((await window.lifetimeArtifact.read()) !== content)
    throw new Error("Another page removed a live artifact");
  const root = await navigator.storage.getDirectory();
  const runs = await root.getDirectoryHandle("pantry-production-runs");
  const directories = [];
  for await (const name of runs.keys()) directories.push(name);
  return { directories };
}

function addArchiveInput() {
  const input = document.createElement("input");
  input.type = "file";
  input.id = "archive-input";
  document.body.append(input);
}

async function importStoredRun(snapshot) {
  const { sourceUrl } = await import("/source-url.js");
  const { readSavedRunFile } =
    await import("/@id/@purin-labs/production-simulation/runs/run-file-reader");
  const { RunArtifactStore } = await import(
    sourceUrl("areas/kitchen/ui/features/production-run/run-artifact-store.ts")
  );
  const { OvenRecordings } =
    await import("/@id/@purin-labs/production-simulation/runs/oven-recordings");
  const { openResumable } =
    await import("/@id/@purin-labs/production-simulation");
  const input = document.querySelector("#archive-input");
  const file = input.files[0];
  // At twice the 128 MiB heap ceiling below, an import that read the file as
  // one string could not pass.
  if (file.size < 256 * 1024 * 1024)
    throw new Error(
      `The import fixture must exceed 256 MiB: received ${file.size} bytes`,
    );
  const started = performance.now();
  const imported = await readSavedRunFile(file);
  const opened = await openResumable(imported.raw.document, "browser", [
    imported.raw.document.bundle,
  ]);
  if (!opened.ok || opened.value.snapshot !== snapshot)
    throw new Error("The exported snapshot changed during import");
  for (const entry of opened.value.artifacts)
    if (imported.artifacts.get(entry.digest)?.byteLength !== entry.byteLength)
      throw new Error("An imported artifact differs");
  const reader = new OvenRecordings();
  const archive = {
    document: opened.value,
    readArtifact: readImportedArtifact.bind(null, imported.artifacts),
  };
  const observations = [];
  for (const cell of opened.value.state.cells) {
    const observed = await reader.observation(
      archive,
      cell.id,
      opened.value.state.position.time,
    );
    observations.push({ cell: cell.id, kind: observed.kind });
  }
  // A new page can remove abandoned staging while imported files remain readable.
  const store = await RunArtifactStore.create();
  const refused = [];
  for (const [name, damaged] of [
    ["truncated", file.slice(0, file.size - 2)],
    [
      "duplicate-field",
      new Blob([
        '{"kind":"saved","kind":"saved","document":{},"artifacts":[]}',
      ]),
    ],
    [
      "changed-artifact",
      new Blob([
        '{"kind":"saved","document":{},"artifacts":[{"digest":"' +
          "0".repeat(64) +
          '","content":"changed"}]}',
      ]),
    ],
  ]) {
    try {
      await readSavedRunFile(damaged);
    } catch {
      refused.push(name);
    }
  }
  if (refused.length !== 3) throw new Error("An invalid archive was admitted");
  window.importedRun = { imported, reader, store };
  return {
    snapshot: opened.value.snapshot,
    fileBytes: file.size,
    artifacts: imported.artifacts.size,
    importAndInspectionMs: performance.now() - started,
    observations,
    inspection: reader.stats(),
    refused,
  };
}

async function readImportedArtifact(artifacts, digest) {
  const file = artifacts.get(digest);
  if (file === undefined) throw new Error("The archive is missing a recording");
  return file.read();
}
