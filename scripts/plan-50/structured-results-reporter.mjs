import { mkdir, writeFile } from "node:fs/promises";

const output = new URL(
  "../../docs/evidence/plan-50-durable-execution/structured-results.json",
  import.meta.url,
);

export default class StructuredResultsReporter {
  results = [];

  onTestCaseResult(test) {
    const meta = test.meta();
    this.results.push({
      name: test.fullName,
      result: test.result(),
      evidence: meta.piSdkEvidence,
    });
  }

  async onTestRunEnd() {
    await mkdir(new URL(".", output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          repeat:
            "pnpm --filter @seams/platform exec vitest run --config vitest.e2e.config.ts tests/e2e/pi-sdk-effect.test.ts tests/e2e/codex-credit-continuation.test.ts --reporter=default --reporter=../../scripts/plan-50/structured-results-reporter.mjs",
          results: this.results,
        },
        evidenceProjection,
        2,
      ) + "\n",
    );
  }
}

function evidenceProjection(key, value) {
  if (key === "evidence" && value !== undefined) return relevantEvidence(value);
  if (key === "requests" && Array.isArray(value))
    return value.map(requestEvidence);
  return value;
}

function relevantEvidence(value) {
  return {
    scenario: value.scenario,
    fixture: value.fixture,
    inputSizes: value.inputSizes,
    direct: value.direct,
    acceptedHistory: value.acceptedHistory,
    modelUsage: value.modelUsage,
    elapsedMs: value.elapsedMs,
    requests: value.requests,
    provider: value.provider,
    recovered: value.recovered,
    proposalOperationCount: value.proposalOperationCount,
    delivered: value.delivered,
  };
}

function requestEvidence(request) {
  return {
    model: request.model,
    lastMessage: Array.isArray(request.messages)
      ? request.messages.at(-1)
      : null,
  };
}
