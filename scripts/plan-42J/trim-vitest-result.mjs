// Keeps one record of each journey from a Vitest JSON result.
//
// A journey may attach more than one record to its result. Some hold every
// provider request and are too large to keep as evidence. This writes the
// result again with each journey's title, status, duration, and the one
// record named.
//
// usage: node trim-vitest-result.mjs <result.json> <record> [<out.json>]
import { readFileSync, writeFileSync } from "node:fs";

const [input, record, output = input] = process.argv.slice(2);
if (input === undefined || record === undefined)
  throw new Error(
    "usage: trim-vitest-result.mjs <result.json> <record> [<out.json>]",
  );
const result = JSON.parse(readFileSync(input, "utf8"));
const trimmed = {
  numTotalTests: result.numTotalTests,
  numPassedTests: result.numPassedTests,
  numFailedTests: result.numFailedTests,
  success: result.success,
  startTime: result.startTime,
  kept: record,
  testResults: result.testResults.map((file) => ({
    name: String(file.name).replace(
      /^.*\/services\/platform\//u,
      "services/platform/",
    ),
    status: file.status,
    assertionResults: file.assertionResults.map((assertion) => ({
      fullName: assertion.fullName,
      status: assertion.status,
      duration: assertion.duration,
      failureMessages: assertion.failureMessages,
      meta: { [record]: assertion.meta?.[record] },
    })),
  })),
};
writeFileSync(output, `${JSON.stringify(trimmed)}\n`);
