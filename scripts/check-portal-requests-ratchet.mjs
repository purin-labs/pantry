#!/usr/bin/env node
// Fails when a Portal component file adds a direct control request
// (Refactor 17, step A2.2).
//
// A Portal component reads through `useLatestRead` and changes through
// `useMutation` (foundation/ui). The request itself is a function in the
// request module of the feature, for example `features/devices/requests.ts`.
// The module calls `controlRead` or `controlMutation` and parses the answer.
//
// A component file is a `.tsx` file, or a `.ts` file that imports React. The
// baseline in scripts/portal-requests-ratchet.json lists each component file
// that still calls the control client itself, with its count. A listed file
// may not add a call, and a new component file may not have one. When a file
// loses a call, lower its entry with --update.
//
//   node scripts/check-portal-requests-ratchet.mjs            check
//   node scripts/check-portal-requests-ratchet.mjs --update   lower entries, drop files with no call
//   node scripts/check-portal-requests-ratchet.mjs --init     write the baseline from the current tree
import { runCountRatchet } from "./lib/count-ratchet.mjs";
import { inFolders, PORTAL_SOURCE } from "./lib/source-roots.mjs";

const SOURCE = /\.(ts|tsx)$/;
const EXCLUDED = [
  /^apps\/portal\/src\/dev\//,
  /\.test\.[a-z]+$/,
  /^(apps\/portal\/src|foundation\/control\/portal)\/control-client\.ts$/,
];
const IMPORTS_REACT = /from\s+["']react["']/u;
// The reads and the writes of the control client. The other functions of the
// client (a stream, a presence beat, a recording) are not a read or a change
// of a record.
const CALL =
  /(?<![\w.$])control(?:Read|ReadIfChanged|Mutation|Write|SecretMutation|Upload)\s*\(/gu;

runCountRatchet({
  name: "portal requests ratchet",
  script: "scripts/check-portal-requests-ratchet.mjs",
  baseline: "scripts/portal-requests-ratchet.json",
  count: (file, read) =>
    inFolders(file, PORTAL_SOURCE) &&
    SOURCE.test(file) &&
    !EXCLUDED.some((pattern) => pattern.test(file)) &&
    (file.endsWith(".tsx") || IMPORTS_REACT.test(read()))
      ? (read().match(CALL)?.length ?? 0)
      : 0,
  refusal: (file, calls, allowed) =>
    `${file} has ${calls} direct control requests, ${allowed} allowed. Put the request in the request module of the feature, then read it with useLatestRead or change it with useMutation (foundation/ui/README.md).`,
});
