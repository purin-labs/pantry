import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { requirePublicOrigin } from "../foundation/kernel/public-origin.ts";
import { CODE_MODE_SANDBOX_INTERRUPT_BUDGET } from "../foundation/agent/code-mode-sandbox/limits.ts";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "services/platform/package.json"));
const { unstable_readConfig } = require("wrangler");

/**
 * The Workers of the Pantry stack (Plan 93), by service and profile. Every
 * profile check below reads its name here, and a deployment refuses a name
 * that is not here: no release can reach a Worker of the old stack, or make
 * a new, empty Worker by mistake.
 */
export const WORKER_NAMES = {
  platform: { local: "pantry", production: "pantry" },
  commerce: { local: "pantry-commerce", production: "pantry-commerce" },
  "slack-ingress": { production: "pantry-slack-ingress" },
  "code-mode-sandbox": {
    local: "pantry-code-sandbox-local",
    production: "pantry-code-sandbox",
  },
  "model-exit": {
    local: "pantry-model-exit-local",
    production: "pantry-model-exit",
  },
  "chatgpt-exit": {
    local: "pantry-chatgpt-exit-local",
    production: "pantry-chatgpt-exit",
  },
  "vault-onepassword": {
    local: "pantry-vault-onepassword-local",
    production: "pantry-vault-onepassword",
  },
  docs: { production: "pantry-docs" },
  shop: { production: "purin-shop" },
};

/**
 * The one address of each public Worker: a custom domain on purin.io. A
 * production Worker has no workers.dev address and no preview address.
 */
export const WORKER_DOMAINS = {
  pantry: "pantry.purin.io",
  "pantry-commerce": "commerce.pantry.purin.io",
  "pantry-slack-ingress": "slack.pantry.purin.io",
  "pantry-docs": "docs.pantry.purin.io",
  "purin-shop": "shop.purin.io",
};

const PRODUCTION_WORKER_NAMES = new Set(
  Object.values(WORKER_NAMES).map((names) => names.production),
);

/** Each reason why a resolved production profile may not be deployed. */
export function releaseTargetProblems(config) {
  const problems = [];
  if (!PRODUCTION_WORKER_NAMES.has(config.name))
    problems.push(`the Worker name ${config.name} is not a Pantry Worker`);
  if (config.workers_dev !== false) problems.push("a workers.dev address");
  if (config.preview_urls === true) problems.push("preview addresses");
  const domain = WORKER_DOMAINS[config.name];
  const routes = (config.routes ?? []).map(routeTarget);
  const expected = domain === undefined ? [] : [`${domain} (custom domain)`];
  if (!sameValue(routes, expected))
    problems.push(
      `routes other than ${expected.length === 0 ? "none" : expected[0]}`,
    );
  return problems;
}

/** Refuses a deployment of a production profile that is not a Pantry Worker. */
export function requireReleaseTarget(config) {
  const problems = releaseTargetProblems(config);
  if (problems.length > 0)
    throw new Error(
      `${config.name}: the release guard refuses this deployment: ${problems.join("; ")}`,
    );
}

function routeTarget(route) {
  if (typeof route === "string") return route;
  return route.custom_domain === true
    ? `${route.pattern} (custom domain)`
    : route.pattern;
}

/** The source folder of a Worker service. */
export function workerDirectory(service) {
  if (service === "platform") return resolve(root, "services/platform");
  if (service === "commerce") return resolve(root, "services/commerce");
  throw new Error("Unknown Worker service");
}

export function readWorkerEnvironment(service, environment) {
  const directory = workerDirectory(service);
  if (environment !== "local" && environment !== "production") {
    throw new Error("Select local or production");
  }
  const config = unstable_readConfig({
    config: resolve(directory, "wrangler.jsonc"),
    env: environment,
  });
  if (
    config.name !== WORKER_NAMES[service][environment] ||
    config.vars.PANTRY_DEPLOYMENT_PROFILE !== environment
  ) {
    throw new Error(
      `${service}: resolved Worker name or profile does not match ${environment}`,
    );
  }
  return config;
}

const SLACK_INGRESS_CONFIG = "services/platform/wrangler.slack-ingress.jsonc";
const SLACK_INGRESS_VARS = [
  "PANTRY_DEPLOYMENT_PROFILE",
  "PANTRY_ORGANISATION_PLACEMENT_PROFILE",
  "PANTRY_VAULT_ACTIVE_KEY_VERSION",
  "SLACK_APP_ID",
];

/**
 * The production profile of the Slack ingress Worker.
 *
 * The ingress Worker reads the databases and the vault roots of the platform
 * Worker and calls its Connector class. Its profile repeats those values. A
 * value that differs would decide a Slack message against other records, so
 * the read fails on a difference.
 */
export function readSlackIngressEnvironment(environment) {
  if (environment !== "production")
    throw new Error("The Slack ingress Worker has a production profile only");
  const platform = readWorkerEnvironment("platform", environment);
  const ingress = unstable_readConfig({
    config: resolve(root, SLACK_INGRESS_CONFIG),
    env: environment,
  });
  const differences = slackIngressProfileDifferences(platform, ingress);
  if (differences.length > 0)
    throw new Error(
      `slack-ingress: the profile differs from the platform profile: ${differences.join("; ")}`,
    );
  return ingress;
}

function slackIngressProfileDifferences(platform, ingress) {
  const differences = [];
  if (ingress.name !== WORKER_NAMES["slack-ingress"].production)
    differences.push("Worker name");
  for (const key of ["compatibility_date", "compatibility_flags"]) {
    if (!sameValue(ingress[key], platform[key])) differences.push(key);
  }
  if (!sameValue(Object.keys(ingress.vars).sort(), SLACK_INGRESS_VARS))
    differences.push("variable names");
  for (const key of SLACK_INGRESS_VARS) {
    if (ingress.vars[key] !== platform.vars[key])
      differences.push(`variable ${key}`);
  }
  if (
    !sameValue(
      ingress.d1_databases.map(databaseTarget).sort(),
      platform.d1_databases.map(databaseTarget).sort(),
    )
  )
    differences.push("D1 databases");
  if (
    !sameValue(
      ingress.secrets_store_secrets.map(storeSecretTarget).sort(),
      platform.secrets_store_secrets
        .filter(isVaultRoot)
        .map(storeSecretTarget)
        .sort(),
    )
  )
    differences.push("vault roots");
  const connector = platform.durable_objects.bindings.find(isConnectorBinding);
  if (
    connector === undefined ||
    !sameValue(ingress.durable_objects.bindings, [
      { ...connector, script_name: platform.name },
    ])
  )
    differences.push("Connector class");
  if (
    !sameValue(ingress.services, [
      { binding: "PLATFORM", service: platform.name },
    ])
  )
    differences.push("platform service");
  return differences;
}

const CODE_MODE_SANDBOX_CONFIG =
  "services/platform/wrangler.code-mode-sandbox.jsonc";
/**
 * The slowest rate of QuickJS interrupt polls that the CPU limit must cover.
 * Cloudflare measured about 10,000 polls for each second of computation, and
 * the local runtime about 6,400. A quarter of the first value leaves room for
 * a slow machine.
 */
const SLOWEST_INTERRUPT_POLLS_PER_SECOND = 2_500;

/**
 * The profile of the Code Mode sandbox Worker.
 *
 * The platform Worker binds the class of this Worker by name. A name that
 * differs would send a script to another Worker, or to none. This Worker runs
 * generated code, so it holds no credential, database, storage, or outbound
 * binding. Its CPU limit must cover the interrupt budget of one execution: a
 * VM that the platform stops first fails without its own stated reason.
 */
export function readCodeModeSandboxEnvironment(environment) {
  const platform = readWorkerEnvironment("platform", environment);
  const sandbox = unstable_readConfig({
    config: resolve(root, CODE_MODE_SANDBOX_CONFIG),
    env: environment,
  });
  const differences = codeModeSandboxProfileDifferences(
    platform,
    sandbox,
    WORKER_NAMES["code-mode-sandbox"][environment],
  );
  if (differences.length > 0)
    throw new Error(
      `code-mode-sandbox: the profile is invalid: ${differences.join("; ")}`,
    );
  return sandbox;
}

function codeModeSandboxProfileDifferences(platform, sandbox, name) {
  const differences = [];
  if (sandbox.name !== name) differences.push("Worker name");
  const sandboxClass = { name: "SANDBOX", class_name: "CodeModeSandbox" };
  if (!sameValue(sandbox.durable_objects.bindings, [sandboxClass]))
    differences.push("sandbox class");
  if (
    !sameValue(
      platform.durable_objects.bindings.find(isCodeModeSandboxBinding),
      {
        name: "CODE_MODE_SANDBOX",
        class_name: "CodeModeSandbox",
        script_name: name,
      },
    )
  )
    differences.push("platform binding of the sandbox class");
  const held = CODE_MODE_SANDBOX_FORBIDDEN_BINDINGS.filter(
    holdsBinding.bind(null, sandbox),
  );
  if (held.length > 0)
    differences.push(`forbidden bindings (${held.join(", ")})`);
  if (sandbox.workers_dev !== false || (sandbox.routes ?? []).length > 0)
    differences.push("public route");
  const requiredCpuMs =
    (CODE_MODE_SANDBOX_INTERRUPT_BUDGET / SLOWEST_INTERRUPT_POLLS_PER_SECOND) *
    1_000;
  const cpuMs = sandbox.limits?.cpu_ms;
  if (typeof cpuMs !== "number" || cpuMs < requiredCpuMs)
    differences.push(
      `CPU limit below ${requiredCpuMs} ms for the interrupt budget`,
    );
  return differences;
}

const CODE_MODE_SANDBOX_FORBIDDEN_BINDINGS = [
  "vars",
  "d1_databases",
  "kv_namespaces",
  "r2_buckets",
  "services",
  "secrets_store_secrets",
  "analytics_engine_datasets",
  "hyperdrive",
  "vectorize",
  "worker_loaders",
  "dispatch_namespaces",
  "mtls_certificates",
  "send_email",
  "pipelines",
  "workflows",
  "containers",
];

const MODEL_EXIT_CONFIG = "services/platform/wrangler.model-exit.jsonc";
/** The data centre closest to AWS Tokyo. Never Smart Placement. */
const MODEL_EXIT_PLACEMENT = { region: "aws:ap-northeast-1" };

/**
 * The profile of the model exit Worker (Plan 73).
 *
 * The platform Worker sends each direct model-provider request through this
 * Worker by its name. A name that differs would send provider credentials to
 * another Worker, or to none, and a region that differs would let a provider
 * see a location that it refuses. The Worker holds no credential, database,
 * storage or service binding, and it has no public route. Its invocation
 * logs are off, so Cloudflare keeps no record of its requests.
 */
export function readModelExitEnvironment(environment) {
  const platform = readWorkerEnvironment("platform", environment);
  const exit = unstable_readConfig({
    config: resolve(root, MODEL_EXIT_CONFIG),
    env: environment,
  });
  const differences = modelExitProfileDifferences(
    platform,
    exit,
    environment,
    WORKER_NAMES["model-exit"][environment],
  );
  if (differences.length > 0)
    throw new Error(
      `model-exit: the profile is invalid: ${differences.join("; ")}`,
    );
  return exit;
}

function modelExitProfileDifferences(platform, exit, environment, name) {
  const differences = [];
  if (exit.name !== name) differences.push("Worker name");
  if (
    !sameValue(platform.services.find(isModelExitBinding), {
      binding: "MODEL_EXIT",
      service: name,
    })
  )
    differences.push("platform binding of the exit Worker");
  if (!sameValue(definedFields(exit.placement), MODEL_EXIT_PLACEMENT))
    differences.push(`placement other than ${MODEL_EXIT_PLACEMENT.region}`);
  if (!sameValue(exit.vars, { PANTRY_DEPLOYMENT_PROFILE: environment }))
    differences.push("variables other than PANTRY_DEPLOYMENT_PROFILE");
  const held = [
    ...CODE_MODE_SANDBOX_FORBIDDEN_BINDINGS.filter(isNotVars),
    "durable_objects",
  ].filter(holdsModelExitBinding.bind(null, exit));
  if (held.length > 0)
    differences.push(`forbidden bindings (${held.join(", ")})`);
  if (exit.workers_dev !== false || (exit.routes ?? []).length > 0)
    differences.push("public route");
  if (exit.observability?.logs?.invocation_logs !== false)
    differences.push("invocation logs on");
  return differences;
}

const VAULT_ONEPASSWORD_CONFIG =
  "services/platform/wrangler.vault-onepassword.jsonc";

/**
 * The profile of the 1Password store Worker (Plan 79).
 *
 * The platform Worker sends each Vault operation of an Organisation that
 * uses 1Password through this Worker by its name, with that Organisation's
 * service account token. A name that differs would send the token to another
 * Worker, or to none. The Worker holds no credential, database, storage,
 * service binding or public route, and its invocation logs are off.
 */
export function readVaultOnePasswordEnvironment(environment) {
  const platform = readWorkerEnvironment("platform", environment);
  const store = unstable_readConfig({
    config: resolve(root, VAULT_ONEPASSWORD_CONFIG),
    env: environment,
  });
  const name = WORKER_NAMES["vault-onepassword"][environment];
  const differences = [];
  if (store.name !== name) differences.push("Worker name");
  if (
    !sameValue(
      platform.services.find(
        (binding) => binding.binding === "VAULT_ONEPASSWORD",
      ),
      { binding: "VAULT_ONEPASSWORD", service: name },
    )
  )
    differences.push("platform binding of the 1Password store Worker");
  if (!sameValue(definedFields(store.placement), MODEL_EXIT_PLACEMENT))
    differences.push(`placement other than ${MODEL_EXIT_PLACEMENT.region}`);
  if (!sameValue(store.vars, { PANTRY_DEPLOYMENT_PROFILE: environment }))
    differences.push("variables other than PANTRY_DEPLOYMENT_PROFILE");
  const held = [
    ...CODE_MODE_SANDBOX_FORBIDDEN_BINDINGS.filter(isNotVars),
    "durable_objects",
  ].filter(holdsModelExitBinding.bind(null, store));
  if (held.length > 0)
    differences.push(`forbidden bindings (${held.join(", ")})`);
  if (store.workers_dev !== false || (store.routes ?? []).length > 0)
    differences.push("public route");
  if (store.observability?.logs?.invocation_logs !== false)
    differences.push("invocation logs on");
  if (differences.length > 0)
    throw new Error(
      `vault-onepassword: the profile is invalid: ${differences.join("; ")}`,
    );
  return store;
}

const CHATGPT_EXIT_CONFIG = "services/platform/wrangler.chatgpt-exit.jsonc";

/**
 * The profile of the ChatGPT exit Worker (Plan 75).
 *
 * The platform Worker sends each chatgpt.com request of the ChatGPT
 * subscription route through this Worker by its name, with the
 * organisation's token. A name that differs would send that token to
 * another Worker, or to none. The Worker holds one Actor binding for one
 * small container in Asia Pacific, and nothing else: no credential,
 * database, storage, service binding or public route. Its invocation logs
 * are off, so Cloudflare keeps no record of its requests.
 */
export function readChatGptExitEnvironment(environment) {
  const platform = readWorkerEnvironment("platform", environment);
  const exit = unstable_readConfig({
    config: resolve(root, CHATGPT_EXIT_CONFIG),
    env: environment,
  });
  const name = WORKER_NAMES["chatgpt-exit"][environment];
  const differences = [];
  if (exit.name !== name) differences.push("Worker name");
  if (
    !sameValue(platform.services.find(isChatGptExitBinding), {
      binding: "CHATGPT_EXIT",
      service: name,
    })
  )
    differences.push("platform binding of the ChatGPT exit Worker");
  if (!sameValue(definedFields(exit.placement), MODEL_EXIT_PLACEMENT))
    differences.push(`placement other than ${MODEL_EXIT_PLACEMENT.region}`);
  if (!sameValue(exit.vars, { PANTRY_DEPLOYMENT_PROFILE: environment }))
    differences.push("variables other than PANTRY_DEPLOYMENT_PROFILE");
  const actors = (exit.durable_objects?.bindings ?? []).map(actorBinding);
  if (
    !sameValue(actors, [
      { name: "CHATGPT_EXIT_CONTAINER", class_name: "ChatGptExitContainer" },
    ])
  )
    differences.push("Actor bindings other than CHATGPT_EXIT_CONTAINER");
  const containers = (exit.containers ?? []).map(containerShape);
  if (
    !sameValue(containers, [
      {
        class_name: "ChatGptExitContainer",
        instance_type: "lite",
        max_instances: 1,
        regions: ["APAC"],
      },
    ])
  )
    differences.push("container other than one lite instance in APAC");
  const held = CODE_MODE_SANDBOX_FORBIDDEN_BINDINGS.filter(
    isNotVarsOrContainers,
  ).filter(holdsBinding.bind(null, exit));
  if (held.length > 0)
    differences.push(`forbidden bindings (${held.join(", ")})`);
  if (exit.workers_dev !== false || (exit.routes ?? []).length > 0)
    differences.push("public route");
  if (exit.observability?.logs?.invocation_logs !== false)
    differences.push("invocation logs on");
  if (differences.length > 0)
    throw new Error(
      `chatgpt-exit: the profile is invalid: ${differences.join("; ")}`,
    );
  return exit;
}

function isChatGptExitBinding(binding) {
  return binding.binding === "CHATGPT_EXIT";
}

function actorBinding(binding) {
  return { name: binding.name, class_name: binding.class_name };
}

function containerShape(container) {
  return {
    class_name: container.class_name,
    instance_type: container.instance_type,
    max_instances: container.max_instances,
    regions: container.constraints?.regions,
  };
}

function isNotVarsOrContainers(key) {
  return key !== "vars" && key !== "containers";
}

function holdsModelExitBinding(config, key) {
  return key === "durable_objects"
    ? (config.durable_objects?.bindings ?? []).length > 0
    : holdsBinding(config, key);
}

function isNotVars(key) {
  return key !== "vars";
}

function isModelExitBinding(binding) {
  return binding.binding === "MODEL_EXIT";
}

function definedFields(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, field]) => field !== undefined),
  );
}

function holdsBinding(config, key) {
  const value = config[key];
  if (value === undefined || value === null) return false;
  return Array.isArray(value)
    ? value.length > 0
    : Object.keys(value).length > 0;
}

function isCodeModeSandboxBinding(binding) {
  return binding.name === "CODE_MODE_SANDBOX";
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function databaseTarget(database) {
  return `${database.binding}=${database.database_name}/${database.database_id}`;
}

function storeSecretTarget(secret) {
  return `${secret.binding}=${secret.store_id}/${secret.secret_name}`;
}

function isVaultRoot(secret) {
  return secret.binding.startsWith("VAULT_ROOT_");
}

function isConnectorBinding(binding) {
  return binding.name === "CONNECTOR";
}

/**
 * The Wrangler arguments of a deployment.
 *
 * Wrangler creates a KV namespace, a D1 database or an R2 bucket that a
 * binding names and the account lacks, and deploys with the new, empty
 * resource. A profile that names a deleted bucket would give production an
 * empty archive. With this option the deployment fails instead.
 */
export function workerDeployArguments(environment) {
  return ["deploy", "--env", environment, "--experimental-provision=false"];
}

export function isResourceCreationOption(argument) {
  return /^--(no-)?(experimental|x)-(provision|auto-create)(=|$)/u.test(
    argument,
  );
}

export function requireLocalWorkerSecrets(service, config) {
  const path = resolve(dirname(config.configPath), ".dev.vars.local");
  if (!existsSync(path))
    throw new Error(
      `${service}: required .dev.vars.local is missing; run pnpm local:init`,
    );
  const secrets = parseEnv(readFileSync(path, "utf8"));
  for (const key of Object.keys(secrets)) {
    if (key in config.vars)
      throw new Error(
        `${service}: ${key} belongs in env.local.vars, not .dev.vars.local`,
      );
  }
  const required =
    service === "platform"
      ? [
          "SESSION_TOKEN_SECRET",
          "SLACK_OAUTH_STATE_SECRET",
          "COMMERCE_SERVICE_TOKEN",
        ]
      : config.secrets.required;
  for (const key of required) {
    if (!secrets[key]?.trim())
      throw new Error(
        `${service}: missing local secret ${key}; run pnpm local:init`,
      );
  }
  return secrets;
}

export function validateWorkerOrigins(service, environment, config) {
  for (const key of [
    "PANTRY_PUBLIC_ORIGIN",
    "PANTRY_OAUTH_CALLBACK_ORIGIN",
    "PANTRY_PROVIDER_INGRESS_ORIGIN",
    "COMMERCE_BASE_URL",
  ]) {
    const value = config.vars[key];
    if (value === undefined) continue;
    let url;
    try {
      url = new URL(requirePublicOrigin(value));
    } catch {
      throw new Error(`${service}: invalid ${key} for ${environment}`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (environment !== "local" && loopback) {
      throw new Error(`${service}: invalid ${key} for ${environment}`);
    }
  }
}
