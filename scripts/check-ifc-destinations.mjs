#!/usr/bin/env node
// Fails when a new information-flow destination has no class (Plan 27C).
//
// The exit check treats a destination by its class, so a destination with no
// class would pass as if it stayed inside the Organisation. A tool effect names
// its capability, and that capability must be in one of the class sets at the
// top of the exit rule in foundation/authority/policy/information-flow/sinks.ts.
// A conversation delivery reaches outside only through `reachesOutside`, so a
// new file that builds one must be added to the list below after a look at where
// it delivers.
//
//   node scripts/check-ifc-destinations.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { PLATFORM_SOURCE } from "./lib/source-roots.mjs";

const root = resolve(import.meta.dirname, "..");
const SINKS = "foundation/authority/policy/information-flow/sinks.ts";

// These files name no capability, because the capability comes from the caller.
// Each caller that names one is checked: a literal tool effect, and each call
// of a builder in `EFFECT_BUILDERS`.
const EFFECTS_WITH_A_NAMED_CALLER = new Set([
  "foundation/authority/access-control/decision-explanation.ts",
  "foundation/control/worker/routes/access-control-explain.ts",
  "workers/platform/src/actors/agent-session.ts",
  // Refactor 10 moved these effects out of agent-session.ts unchanged.
  "areas/inbox/server/agent-tools/channels/handlers.ts",
  "foundation/tool-handlers/agent-tools/session-support.ts",
]);

// These files check a read for a member, or deliver through the one Slack sink
// `actors/case-conversation-sink.ts`, which reads `reachesOutside`.
const CONVERSATION_DELIVERIES = new Set([
  "foundation/authority/access-control/decision-explanation.ts",
  "foundation/conversation/actors/case-conversation-sink.ts",
  "foundation/conversation/case-context-discovery/metadata.ts",
  "surfaces/portal/server/chat/application.ts",
  // Refactor 13 moved the timeline effects out of application.ts unchanged.
  "surfaces/portal/server/chat/turn/timeline.ts",
  "foundation/conversation/chat/conversation-disclosure.ts",
  "foundation/conversation/chat/information-flow.ts",
  "foundation/control/worker/routes/access-control-explain.ts",
  "areas/commerce/server/control/routes/supplier-payouts.ts",
  "areas/inbox/contract/server/mail-source-authorization.ts",
  "areas/inbox/server/mail-inbox/chat-source-access.ts",
  "areas/inbox/server/mail-inbox/supplier-context.ts",
  "areas/inbox/server/whatsapp/read-authorization.ts",
  "foundation/conversation/projects/context.ts",
  "foundation/conversation/projects/references.ts",
]);

// The destination classes. `PASSES_AFTER_OUTSIDE_TEXT` is the writer rule,
// not a class, so a capability that only it names has no destination class.
const CLASS_SETS = [
  "INSIDE_CAPABILITIES",
  "OUTSIDE_CAPABILITIES",
  "OTHER_SERVICE_CAPABILITIES",
  "RECIPIENT_CAPABILITIES",
];

// Functions that build a tool effect from the capability that their caller
// names.
const EFFECT_BUILDERS = ["proposalFlowEffect"];

const sinks = readFileSync(resolve(root, SINKS), "utf8");
const classes = CLASS_SETS.map(function classSet(name) {
  const start = new RegExp(`const ${name}\\b[^=]*= new Set\\(\\[`, "u").exec(
    sinks,
  );
  if (start === null)
    throw new Error(`${SINKS}: the class set ${name} is gone`);
  const body = sinks.slice(start.index + start[0].length);
  return body.slice(0, body.indexOf("]);"));
}).join("\n");

const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    ...PLATFORM_SOURCE,
  ],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter((path) => path.endsWith(".ts"));

const problems = [];
for (const path of files) {
  if (path === SINKS || path.endsWith("/types.ts")) continue;
  let source;
  try {
    source = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  if (
    source.includes('kind: "conversation_delivery"') &&
    !CONVERSATION_DELIVERIES.has(path)
  )
    problems.push(
      `${path}: a new conversation delivery. If it posts to Slack, go through case-conversation-sink.ts. Then add the file to this script.`,
    );
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const builds =
      line.includes('kind: "tool_effect"') ||
      EFFECT_BUILDERS.some((builder) => line.includes(`${builder}(`));
    if (!builds || /^\s*(export\s+)?function\s/u.test(line)) return;
    const near = lines.slice(index, index + 8).join("\n");
    const named = /capabilityId:\s*(CAPABILITY_KEYS\.\w+|"[^"]+")/u.exec(
      near,
    )?.[1];
    if (named === undefined) {
      if (!EFFECTS_WITH_A_NAMED_CALLER.has(path))
        problems.push(
          `${path}:${String(index + 1)}: name the capability of this tool effect, so that its class can be checked.`,
        );
      return;
    }
    if (!classes.includes(named))
      problems.push(
        `${path}:${String(index + 1)}: ${named} has no destination class. Add it to a class set in ${SINKS}.`,
      );
  });
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
