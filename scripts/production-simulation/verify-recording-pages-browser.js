async function verifyRecordingPagesBrowser(page) {
  const evidence = new URL(page.url()).searchParams.get("evidence");
  const expected = await (
    await page.request.get(
      new URL(`${evidence}/expected.json`, page.url()).href,
    )
  ).json();
  globalThis.recordingArtifactDirectory = `${expected.source}/artifacts/`;
  await page.route("**/artifacts/*", serveRecordingArtifact);
  await page.addScriptTag({ content: fetchRecordingArtifact.toString() });
  const connection = await page.context().newCDPSession(page);
  await connection.send("HeapProfiler.collectGarbage");
  const before = await connection.send("Runtime.getHeapUsage");
  const report = await page.evaluate(inspectRecordingPages);
  await connection.send("HeapProfiler.collectGarbage");
  const after = await connection.send("Runtime.getHeapUsage");
  await page.screenshot({ path: "recording-pages.png", fullPage: true });
  await connection.detach();
  return { ...report, heapBefore: before, heapAfter: after };
}

// Vite transforms extensionless files. Serve the immutable fixture bytes directly.
async function serveRecordingArtifact(route) {
  const path = decodeURIComponent(
    new URL(route.request().url()).pathname,
  ).replace(/^\/@fs\/+/u, "/");
  const digest = path.slice(globalThis.recordingArtifactDirectory.length);
  if (
    !path.startsWith(globalThis.recordingArtifactDirectory) ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    throw new Error("The journey requested an unexpected artifact path");
  await route.fulfill({
    status: 200,
    contentType: "application/octet-stream",
    path,
  });
}

async function fetchRecordingArtifact(source, digest) {
  if (source.failure === "missing")
    throw new Error("Injected unavailable artifact");
  const response = await fetch(`/@fs/${source.path}/artifacts/${digest}`);
  if (!response.ok)
    throw new Error(`Artifact request failed: ${response.status}`);
  const content = await response.text();
  source.reads++;
  source.maxBytes = Math.max(source.maxBytes, content.length);
  return source.failure === "changed" ? `${content} ` : content;
}

async function inspectRecordingPages() {
  const base = new URL(location.href).searchParams.get("evidence");
  if (base === null)
    throw new Error("Provide the prepared recording-page evidence URL");
  const expected = await (await fetch(`${base}/expected.json`)).json();
  const { OvenRecordings, MAX_OVEN_RECORDING_INDEX_ENTRIES } =
    await import("/src/features/production-run/oven-recordings.ts");
  const { openResumable } = await import("/@id/@seams/production-simulation");
  const { sha256Hex } = await import("/@id/@seams/std");
  const raw = await (await fetch(`/@fs/${expected.source}/save-1.json`)).json();
  const opened = await openResumable(raw, "browser", [raw.bundle]);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const source = {
    path: expected.source,
    reads: 0,
    maxBytes: 0,
    failure: "none",
  };
  const archive = {
    document: opened.value,
    readArtifact: fetchRecordingArtifact.bind(null, source),
  };
  const reader = new OvenRecordings();
  const times = [];
  const started = performance.now();
  for (const probe of expected.probes) {
    const since = performance.now();
    const observed = await reader.observation(
      archive,
      probe.cell,
      probe.through,
    );
    times.push(performance.now() - since);
    if (probe.expected === null) {
      if (observed !== null)
        throw new Error("A pose appeared before its recording");
    } else if (
      observed === null ||
      observed.at !== probe.expected.at ||
      observed.kind !== probe.expected.kind ||
      observed.digest !== probe.expected.digest ||
      (await sha256Hex(observed.content)) !== probe.expected.digest
    ) {
      throw new Error(
        `Exact observation differs for ${probe.cell} at ${probe.through}`,
      );
    }
    const stats = reader.stats();
    if (
      stats.indexedRecords > MAX_OVEN_RECORDING_INDEX_ENTRIES ||
      stats.decodedBytes > 16 * 1024 * 1024
    )
      throw new Error("The resident recording page exceeded its bound");
    document.body.dataset.recordingProbe = `${probe.cell}/${probe.through}`;
  }
  const indexed = reader.stats();
  if (
    indexed.scannedRecords !== expected.records ||
    indexed.scannedPacks !== expected.packs
  )
    throw new Error("The archive summary missed accepted records");
  const operation = expected.operation;
  const records = await reader.operationRecords(
    archive,
    operation.cell,
    operation.task,
  );
  const digests = [];
  for (const record of records) {
    if ((await sha256Hex(record.content)) !== record.digest)
      throw new Error("An operation record changed");
    digests.push(record.digest);
  }
  if (
    records.length !== operation.records ||
    (await sha256Hex(digests.join("\n"))) !== operation.digest
  )
    throw new Error(
      "The selected operation lost records or changed their order",
    );
  const afterOperation = reader.stats();
  if (
    afterOperation.scannedPacks !== indexed.scannedPacks ||
    afterOperation.scannedRecords !== indexed.scannedRecords
  )
    throw new Error("Operation inspection rebuilt the archive summaries");
  let futureRefused = false;
  try {
    await reader.observation(
      archive,
      operation.cell,
      archive.document.state.position.time + 2000,
    );
  } catch {
    futureRefused = true;
  }
  let wrongCellRefused = false;
  try {
    await reader.operationRecords(archive, "not-a-cell", operation.task);
  } catch {
    wrongCellRefused = true;
  }
  const failed = new OvenRecordings();
  let unavailableRefused = false;
  source.failure = "missing";
  try {
    await failed.observation(archive, operation.cell, 700_000_000);
  } catch {
    unavailableRefused = true;
  }
  if (failed.stats().indexedPacks !== 0 || failed.stats().indexedRecords !== 0)
    throw new Error("A failed read published a partial index");
  let corruptionRefused = false;
  source.failure = "changed";
  try {
    await failed.observation(archive, operation.cell, 700_000_000);
  } catch {
    corruptionRefused = true;
  }
  if (failed.stats().indexedPacks !== 0 || failed.stats().indexedRecords !== 0)
    throw new Error("A corrupt page published a partial index");
  source.failure = "none";
  if (
    !futureRefused ||
    !wrongCellRefused ||
    !unavailableRefused ||
    !corruptionRefused
  )
    throw new Error("An invalid inspection request was accepted");
  // Retain the real inspection session for post-GC heap measurement.
  window.recordingPagesSession = { reader, archive };
  const report = {
    result: "passed",
    snapshot: expected.snapshot,
    records: expected.records,
    archiveBytes: expected.bytes,
    probes: expected.probes.length,
    operation,
    stats: afterOperation,
    artifactReads: source.reads,
    largestArtifactBytes: source.maxBytes,
    seekMilliseconds: times,
    elapsedMs: performance.now() - started,
    futureRefused,
    wrongCellRefused,
    unavailableRefused,
    corruptionRefused,
  };
  const summary = document.createElement("pre");
  summary.textContent = `${expected.records} exact records inspected across both cells.\n${expected.probes.length} cursor checks match the native archive.\n${afterOperation.indexedRecords} resident record entries; ${afterOperation.summaryEntries} summary entries.\nOne complete operation verified across ${operation.packs} packs.\nUnavailable and changed artifacts refused.`;
  document.body.prepend(summary);
  return report;
}
