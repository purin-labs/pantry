import { mkdir, writeFile } from "node:fs/promises";
const directory = new URL(
  "../../output/playwright/canvas-acceptance/",
  import.meta.url,
);
export default class CanvasResultsReporter {
  results = [];
  onTestCaseResult(test) {
    this.results.push({
      name: test.fullName,
      result: test.result(),
      evidence: test.meta(),
    });
  }
  async onTestRunEnd() {
    await mkdir(directory, { recursive: true });
    const name =
      process.env.SATYR_REGIONAL_E2E === "1"
        ? "regional-results.json"
        : "canvas-results.json";
    await writeFile(
      new URL(name, directory),
      JSON.stringify(
        { recordedAt: new Date().toISOString(), results: this.results },
        null,
        2,
      ) + "\n",
    );
  }
}
