// Browser acceptance uses the production worker host and its pinned Wasm asset.
import { EngineJobs } from "/src/features/production-run/engine-jobs.ts";
import { freshApplianceRequest } from "../../../packages/bakery-model/src/bakery-appliance-protocol.ts";

const applianceNames = [
  "aicoh-ms-30",
  "hobart-hl200",
  "vitamix-quiet-one",
  "waring-wsg60",
  "severin-sm-3587",
  "maruzen-mih-02c",
  "vollrath-59500p",
  "maruzen-mbco-5e",
  "hoshizaki-rt-120snj",
  "ohaus-ranger-3000",
  "winterhalter-uc-l",
];
export const recordings = [];
const results = [];
const job = new EngineJobs();
let status;

function prepared() {
  return Promise.resolve(true);
}
function progress(progress) {
  status.textContent = `${results.length}/11 appliances checked. Worker ${progress.stage}.`;
}
function rejectJob(reject, message) {
  reject(new Error(message));
}
function startJob(request, resolve, reject) {
  job.beginAppliance(request, {
    prepared,
    progress,
    completed: resolve,
    failed: rejectJob.bind(null, reject),
  });
}
function execute(request) {
  return new Promise(startJob.bind(null, request));
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
// The caller supplies the repository path because Vite serves this acceptance
// module from a workspace file, while the portal remains its normal root.
export async function run(root) {
  document.title = "Appliance browser acceptance";
  const heading = document.createElement("h1");
  heading.textContent = "Appliance browser acceptance";
  status = document.createElement("pre");
  document.body.replaceChildren(heading, status);
  try {
    for (const name of applianceNames) {
      const response = await fetch(
        `/@fs${root}/assets/bakery-mujoco/combined-bakery/rust-evidence/${name}.request.json`,
      );
      const source = await response.json();
      const request = freshApplianceRequest(
        name,
        "browser-appliance-acceptance",
        name,
        source.initial.contents,
        source.actions,
      );
      const first = await execute(request);
      check(
        first.outcome.kind === "completed",
        `${name}: initial actions rejected.`,
      );
      const resumed = await execute(
        first.continuation.request(request.runId, `${name}-resumed`, [
          { kind: "advance", seconds: 3 },
        ]),
      );
      const continuousRequest = freshApplianceRequest(
        name,
        request.runId,
        `${name}-continuous`,
        source.initial.contents,
        [...source.actions, { kind: "advance", seconds: 3 }],
      );
      const continuous = await execute(continuousRequest);
      const saved = JSON.parse(resumed.file);
      const uninterrupted = JSON.parse(continuous.file);
      check(
        JSON.stringify(saved.continuation) ===
          JSON.stringify(uninterrupted.continuation),
        `${name}: fresh worker continuation differs.`,
      );
      const referenceResponse = await fetch(
        `/@fs${root}/assets/bakery-mujoco/combined-bakery/rust-evidence/${name}-resumed.json`,
      );
      const reference = await referenceResponse.json();
      check(
        reference.execution.controllerSourceHash ===
          saved.execution.controllerSourceHash,
        `${name}: native and browser source differ.`,
      );
      check(
        saved.continuation.payload.contents.batch.mass_kg === 0.3,
        `${name}: load mass changed.`,
      );
      const thermalError = Math.abs(
        reference.continuation.payload.contents.batch.temperature_c -
          saved.continuation.payload.contents.batch.temperature_c,
      );
      check(
        thermalError < 0.01,
        `${name}: native/browser thermal difference is too large.`,
      );
      recordings.push(saved);
      let maximumStateError = 0;
      let maximumStateIndex = 0;
      for (
        let index = 0;
        index < reference.continuation.payload.state.length;
        index++
      ) {
        const error = Math.abs(
          reference.continuation.payload.state[index] -
            saved.continuation.payload.state[index],
        );
        if (error > maximumStateError) {
          maximumStateError = error;
          maximumStateIndex = index;
        }
      }
      let positionError = 0;
      let orientationError = 0;
      const nativeBodies = reference.samples.at(-1).bodies;
      const browserBodies = saved.samples.at(-1).bodies;
      for (const [body, pose] of Object.entries(nativeBodies)) {
        const other = browserBodies[body];
        for (let axis = 0; axis < 3; axis++)
          positionError = Math.max(
            positionError,
            Math.abs(pose[axis] - other[axis]),
          );
        let dot = 0;
        for (let axis = 3; axis < 7; axis++) dot += pose[axis] * other[axis];
        orientationError = Math.max(
          orientationError,
          2 * Math.acos(Math.min(1, Math.abs(dot))),
        );
      }
      console.info(name, {
        maximumStateError,
        maximumStateIndex,
        positionError,
        orientationError,
        thermalError,
      });
      check(
        positionError < 0.001 && orientationError < 0.01,
        `${name}: native/browser pose difference is too large (${positionError} m, ${orientationError} rad).`,
      );
      results.push({
        appliance: name,
        passed: true,
        freshWorkerExact: true,
        thermalError,
        maximumStateError,
        maximumStateIndex,
        positionError,
        orientationError,
      });
      status.textContent = JSON.stringify(results, null, 2);
    }
    const attachments = await planetaryJourneys(root);
    const report = {
      passed: true,
      runtime: "production EngineJobs / Rust + MuJoCo Wasm",
      results,
      attachments,
    };
    const download = document.createElement("a");
    download.href = URL.createObjectURL(
      new Blob([JSON.stringify({ report, recordings })], {
        type: "application/json",
      }),
    );
    download.download = "appliance-browser-evidence.json";
    download.textContent = "Download browser evidence";
    document.body.append(download);
    status.textContent = JSON.stringify(report, null, 2);
    return report;
  } catch (error) {
    status.textContent = `FAILED: ${error.message}\n${JSON.stringify(results, null, 2)}`;
    throw error;
  }
}

async function planetaryJourneys(root) {
  const report = [];
  for (const name of ["aicoh-ms-30", "hobart-hl200"]) {
    let previous = null;
    const stages = [];
    for (const stage of [
      "open",
      "removed",
      "rejected",
      "selected",
      "swapped",
    ]) {
      const response = await fetch(
        `/@fs${root}/assets/bakery-mujoco/combined-bakery/rust-evidence/${name}-attachments-${stage}.request.json`,
      );
      const source = await response.json();
      const request =
        previous === null
          ? freshApplianceRequest(
              name,
              "browser-attachment-exchange",
              `${name}-${stage}`,
              source.initial.contents,
              source.actions,
            )
          : previous.continuation.request(
              "browser-attachment-exchange",
              `${name}-${stage}`,
              source.actions,
            );
      const result = await execute(request);
      check(
        result.outcome.kind ===
          (stage === "rejected" ? "rejected" : "completed"),
        `${name}: ${stage} failed: ${JSON.stringify(result.outcome)}`,
      );
      previous = result;
      stages.push(JSON.parse(result.file));
    }
    report.push({ appliance: name, passed: true, stages });
  }
  return report;
}
