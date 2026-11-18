import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function record(input, name) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${name} must be an object.`);
  }
  return input;
}

function text(input, name) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`${name} must be text.`);
  }
  return input;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeEvidence(input) {
  const serialized = JSON.stringify(input);
  if (
    /[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}/u.test(
      serialized,
    )
  ) {
    throw new Error("The evidence contains a compact signed token.");
  }
  for (const forbidden of [
    "Bearer ",
    "googleIdTokens",
    "ownerAssertion",
    "PRIVATE KEY",
    "Restricted account supplier.pdf",
    "Shared account turn accepted.",
  ]) {
    if (serialized.includes(forbidden))
      throw new Error(
        "The evidence contains a credential or private source content.",
      );
  }
}

function readJourney(report) {
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    !Array.isArray(report.testResults)
  ) {
    throw new Error("Artifacts require a complete passing Vitest run.");
  }
  for (const file of report.testResults) {
    const result = record(file, "Test file");
    if (!Array.isArray(result.assertionResults)) continue;
    for (const assertion of result.assertionResults) {
      const test = record(assertion, "Test result");
      if (test.status !== "passed") continue;
      const meta = record(test.meta, "Test metadata");
      if (!Object.hasOwn(meta, "sharedAccountPlatform")) continue;
      const journey = record(
        meta.sharedAccountPlatform,
        "Shared account journey",
      );
      if (journey.stage !== "complete-financial-journey")
        throw new Error("The financial journey is incomplete.");
      safeEvidence(journey);
      return journey;
    }
  }
  throw new Error("The passing shared account journey is missing.");
}

function json(input) {
  return `${JSON.stringify(input, null, 2)}\n`;
}

function nativeEvidence(journey) {
  return {
    version: 1,
    provision: journey.provision,
    policySupersession: journey.policySupersession,
    paidTurn: journey.paidTurn,
    unpricedTurn: journey.unpricedTurn,
    restoredPaidTurn: journey.restoredPaidTurn,
    idempotence: journey.idempotence,
    customerFunding: journey.customerFunding,
    removedInitiator: journey.removedInitiator,
    uncertainty: journey.uncertainty,
    cancellationProof: journey.cancellationProof,
    feePolicyFailure: journey.feePolicyFailure,
    serviceDisable: journey.serviceDisable,
  };
}

function accessEvidence(journey) {
  return {
    version: 1,
    access: journey.access,
    sourceAccess: journey.sourceAccess,
    serviceAuthentication: journey.serviceAuthentication,
    eligibilityOutage: journey.eligibilityOutage,
    priorProjectGrant: journey.priorProjectGrant,
    rejoin: journey.rejoin,
    rejoinDiagnostics: journey.rejoinDiagnostics,
    nativeInvitationReplay: journey.nativeInvitationReplay,
  };
}

function reportMarkdown(summary, artifacts) {
  return `# Shared account native acceptance\n\nThe composed native journey passed.\n\nPosted usage is ${summary.postedUsageMinor} USD cents. Available credit is ${summary.availableBalanceMinor} USD cents.\nThe ledger has ${summary.balancedLedgerEntryCount} balanced entries.\nThe ${summary.settledReservations} charged reservations settled. The cancelled reservation released. No active hold remains.\n\nThe journey uses the built real account Worker and native Satyr Worker and Actor.\nIt covers both provider funding routes, unpriced execution, lost replies, restart, uncertainty, native cancellation, removed-user settlement, invitation replay, source denial, and independent service disable.\n\n## Repeat\n\nFrom the Satyr checkout:\n\n\`\`\`sh\nSATYR_ACCOUNT_WORKER_ARTIFACT=${summary.accountWorkerPath} pnpm --filter @seams/platform exec vitest run --config vitest.e2e.config.ts tests/e2e/shared-account-platform.test.ts --reporter=default --reporter=json --outputFile=../../output/shared-account-platform.json\nnode services/platform/tests/e2e/shared-account-platform-report.mjs output/shared-account-platform.json ${summary.artifactDirectory} ${summary.accountWorkerPath}\n\`\`\`\n\nThe account Worker SHA-256 is \`${summary.accountWorkerSha256}\`.\n\n## Artifacts\n\n${artifacts.map(artifactLine).join("\n")}\n`;
}

function artifactLine(artifact) {
  return `- ${artifact.name}: SHA-256 \`${artifact.sha256}\``;
}

async function main() {
  const [reportArgument, outputArgument, workerArgument, extra] =
    process.argv.slice(2);
  if (
    !reportArgument ||
    !outputArgument ||
    !workerArgument ||
    extra !== undefined
  ) {
    throw new Error(
      "Usage: node shared-account-platform-report.mjs <Vitest JSON> <artifact directory> <built account Worker>",
    );
  }
  const reportPath = resolve(reportArgument);
  const artifactDirectory = resolve(outputArgument);
  const accountWorkerPath = resolve(workerArgument);
  const reportBytes = await readFile(reportPath);
  const report = record(
    JSON.parse(reportBytes.toString("utf8")),
    "Vitest report",
  );
  const journey = readJourney(report);
  const financial = record(
    journey.finalFinancialSnapshot,
    "Financial evidence",
  );
  const overview = record(financial.overview, "Account overview");
  const reconciliation = record(journey.reconciliation, "Reconciliation");
  const pdfEnvelope = record(journey.statementPdf, "Statement PDF");
  const encodedPdf = text(pdfEnvelope.base64, "PDF content");
  const pdf = Buffer.from(encodedPdf, "base64");
  if (
    pdf.toString("base64") !== encodedPdf ||
    pdf.subarray(0, 5).toString("ascii") !== "%PDF-" ||
    pdf.byteLength !== pdfEnvelope.bytes
  ) {
    throw new Error("The statement PDF is invalid.");
  }
  const accountWorker = await readFile(accountWorkerPath);
  if (
    text(journey.accountWorkerSha256, "Tested account Worker SHA-256") !==
    hash(accountWorker)
  ) {
    throw new Error(
      "The current account Worker differs from the tested artifact.",
    );
  }
  const summary = {
    version: 1,
    passed: true,
    postedUsageMinor: reconciliation.postedUsageMinor,
    availableBalanceMinor: overview.availableBalanceMinor,
    settledReservations: reconciliation.settledReservations,
    releasedReservations: reconciliation.releasedReservations,
    activeReservations: reconciliation.activeReservations,
    balancedLedgerEntryCount: reconciliation.balancedLedgerEntryCount,
    accountWorkerPath,
    accountWorkerSha256: hash(accountWorker),
    artifactDirectory,
  };
  const files = [
    { name: "vitest.json", bytes: reportBytes },
    { name: "native.json", bytes: Buffer.from(json(nativeEvidence(journey))) },
    { name: "financial.json", bytes: Buffer.from(json(financial)) },
    { name: "access.json", bytes: Buffer.from(json(accessEvidence(journey))) },
    { name: "statement.json", bytes: Buffer.from(json(journey.statement)) },
    { name: "statement.pdf", bytes: pdf },
    { name: "summary.json", bytes: Buffer.from(json(summary)) },
  ];
  await mkdir(artifactDirectory, { recursive: true });
  const artifacts = [];
  for (const file of files) {
    await writeFile(join(artifactDirectory, file.name), file.bytes);
    artifacts.push({ name: file.name, sha256: hash(file.bytes) });
  }
  await writeFile(
    join(artifactDirectory, "report.md"),
    reportMarkdown(summary, artifacts),
  );
  process.stdout.write(`${json(summary)}`);
}

await main();
