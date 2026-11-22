#!/usr/bin/env node
// Fails when a new information-flow destination has no class (Plan 27C).
//
// The exit check treats a destination by its class, so a destination with no
// class would pass as if it stayed inside the Organisation. A tool effect names
// its capability, and that capability must be in one of the class sets at the
// top of the exit rule in services/platform/src/policy/information-flow/sinks.ts.
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
const SINKS = "services/platform/src/policy/information-flow/sinks.ts";

// These files name no capability, because the capability comes from the caller.
// Each caller that names one is checked.
const EFFECTS_WITH_A_NAMED_CALLER = new Set([
  "services/platform/src/access-control/decision-explanation.ts",
  "services/platform/src/control/routes/access-control-explain.ts",
  "services/platform/src/actors/agent-session.ts",
  // Refactor 10 moved these effects out of agent-session.ts unchanged.
  "services/platform/src/agent-tools/channels/handlers.ts",
  "services/platform/src/agent-tools/session-support.ts",
]);

// These files check a read for a member, or deliver through the one Slack sink
// `actors/case-conversation-sink.ts`, which reads `reachesOutside`.
const CONVERSATION_DELIVERIES = new Set([
  "services/platform/src/access-control/decision-explanation.ts",
  "services/platform/src/actors/case-conversation-sink.ts",
  "services/platform/src/case-context-discovery/metadata.ts",
  "services/platform/src/chat/application.ts",
  // Refactor 13 moved the timeline effects out of application.ts unchanged.
  "services/platform/src/chat/turn/timeline.ts",
  "services/platform/src/chat/conversation-disclosure.ts",
  "services/platform/src/chat/information-flow.ts",
  "services/platform/src/control/routes/access-control-explain.ts",
  "services/platform/src/control/routes/supplier-payouts.ts",
  "services/platform/src/mail-inbox/contract/mail-source-authorization.ts",
  "services/platform/src/mail-inbox/chat-source-access.ts",
  "services/platform/src/mail-inbox/supplier-context.ts",
  "services/platform/src/whatsapp/read-authorization.ts",
  "services/platform/src/projects/context.ts",
  "services/platform/src/projects/references.ts",
]);

const sinks = readFileSync(resolve(root, SINKS), "utf8");
const classes = sinks.slice(
  sinks.indexOf("export const INSIDE_CAPABILITIES"),
  sinks.indexOf("function sinkSendsToRecipient"),
);
if (!sinks.includes("export const INSIDE_CAPABILITIES"))
  throw new Error(`${SINKS}: the class sets are gone`);

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
    if (!line.includes('kind: "tool_effect"')) return;
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
