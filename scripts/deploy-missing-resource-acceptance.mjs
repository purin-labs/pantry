import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readWorkerEnvironment,
  workerDeployArguments,
} from "./worker-environment.mjs";

// A deployment must fail when its profile names a bucket that the account
// lacks. This acceptance deploys a disposable Worker with the arguments of a
// production deployment. It never deploys a Pantry Worker. It creates one
// Worker and at most two buckets with a random name, and deletes them. Each
// Wrangler call runs in a temporary directory, away from the Pantry profiles.
const [outputPath, ...extra] = process.argv.slice(2);
if (outputPath === undefined || extra.length > 0) {
  throw new Error(
    "Usage: node scripts/deploy-missing-resource-acceptance.mjs <result.json>",
  );
}

const root = resolve(import.meta.dirname, "..");
const platform = resolve(root, "services/platform");
const require = createRequire(resolve(platform, "package.json"));
const wranglerPath = resolve(platform, "node_modules/.bin/wrangler");
const deployArguments = workerDeployArguments("production");

// Each production profile names every resource that Wrangler can create.
const profiles = [];
for (const service of ["platform", "underclerk"]) {
  const config = readWorkerEnvironment(service, "production");
  const incomplete = [
    ...config.kv_namespaces.filter((binding) => !binding.id),
    ...config.d1_databases.filter((binding) => !binding.database_id),
    ...config.r2_buckets.filter((binding) => !binding.bucket_name),
  ].map((binding) => binding.binding);
  assert.deepEqual(incomplete, [], `${service}: a binding names no resource`);
  profiles.push({
    service,
    buckets: config.r2_buckets.map((binding) => binding.bucket_name),
    databases: config.d1_databases.length,
    namespaces: config.kv_namespaces.length,
  });
}

// The wrapper refuses an option that turns the creation on again. Each
// attempt is a dry run, so an accepted option cannot reach production.
const refusedOptions = [];
for (const option of [
  "--experimental-provision",
  "--x-provision=true",
  "--x-auto-create",
]) {
  const refused = spawnSync(
    process.execPath,
    [
      "scripts/run-worker.mjs",
      "platform",
      "deploy",
      "production",
      "--dry-run",
      option,
    ],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(refused.status, 1, `The option was accepted: ${option}`);
  assert.match(refused.stderr, /Automatic resource creation is forbidden/u);
  assert.doesNotMatch(refused.stdout, /deploy: /u);
  refusedOptions.push({ option, exitCode: refused.status });
}

const suffix = randomBytes(4).toString("hex");
const worker = `satyr-deploy-guard-${suffix}`;
const missingBucket = `${worker}-missing`;
const presentBucket = `${worker}-present`;
const directory = await mkdtemp(join(tmpdir(), "satyr-deploy-guard-"));
const cases = [];
const cleanup = [];
try {
  try {
    await writeFile(
      join(directory, "worker.js"),
      'export default { fetch() { return new Response("ok"); } };\n',
    );
    assert.equal(bucketExists(missingBucket), false);

    // With the arguments of a production deployment, a missing bucket fails
    // the deployment and nothing is created.
    const refused = await deploy(missingBucket, deployArguments);
    assert.notEqual(refused.status, 0, "A missing bucket was accepted");
    assert.match(refused.output, /code: 10085/u);
    assert.equal(bucketExists(missingBucket), false);
    cases.push({
      case: "missing bucket, production arguments",
      exitCode: refused.status,
      cloudflareErrorCode: 10085,
      bucketCreated: false,
    });

    // The same arguments deploy a Worker whose bucket exists.
    const created = wrangler([
      "r2",
      "bucket",
      "create",
      presentBucket,
      "--update-config=false",
    ]);
    assert.equal(created.status, 0, "The test bucket was not created");
    const accepted = await deploy(presentBucket, deployArguments);
    assert.equal(accepted.status, 0, "An existing bucket was refused");
    assert.match(accepted.output, /Uploaded /u);
    cases.push({
      case: "existing bucket, production arguments",
      exitCode: accepted.status,
      uploaded: true,
    });

    // An observation, not a requirement: what this Wrangler version does
    // without the option. When it stops creating the bucket, the option is no
    // longer needed.
    const unguarded = await deploy(missingBucket, [
      "deploy",
      "--env",
      "production",
    ]);
    cases.push({
      case: "missing bucket, without the option",
      exitCode: unguarded.status,
      bucketCreated: bucketExists(missingBucket),
    });
  } finally {
    cleanup.push({
      resource: "worker",
      deleted: wrangler(["delete", "--name", worker, "--force"]).status === 0,
    });
    for (const bucket of [missingBucket, presentBucket]) {
      if (!bucketExists(bucket)) continue;
      cleanup.push({
        resource: "bucket",
        deleted: wrangler(["r2", "bucket", "delete", bucket]).status === 0,
      });
    }
  }
  assert.equal(cleanup[0].deleted, true, "The test Worker remains");
  for (const bucket of [missingBucket, presentBucket]) {
    assert.equal(bucketExists(bucket), false, "A test bucket remains");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

const result = {
  observedAt: new Date().toISOString(),
  wranglerVersion: require("wrangler/package.json").version,
  deployArguments,
  profiles,
  refusedOptions,
  cases,
  cleanup,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

async function deploy(bucket, args) {
  const configPath = join(directory, `${bucket}.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      name: worker,
      main: "worker.js",
      compatibility_date: "2026-07-07",
      env: {
        production: {
          name: worker,
          workers_dev: false,
          r2_buckets: [{ binding: "ARCHIVE", bucket_name: bucket }],
        },
      },
    }),
  );
  return wrangler([...args, "--config", configPath]);
}

function bucketExists(bucket) {
  return wrangler(["r2", "bucket", "info", bucket]).status === 0;
}

function wrangler(args) {
  const result = spawnSync(wranglerPath, args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      CI: "true",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}
