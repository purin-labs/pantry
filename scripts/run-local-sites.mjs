import { resolve } from "node:path";

import { clearLocalPorts, runLocalProcesses } from "./local-process-runner.mjs";
import { createLocalProxyProcess } from "./local-proxy.mjs";

const root = resolve(import.meta.dirname, "..");
const siteLinkColor = "1;38;5;214";
// The shop link opens the live pâtisserie site. The local café and store
// routes still run for the browser journeys, so they are left off the list.
const localSites = [
  { label: "Shop", url: "https://shop.seams.tokyo" },
  { label: "Portal", url: "https://localhost:3003" },
  { label: "Docs", url: "http://docs.localhost:3005" },
];

process.env.VITE_DOCS_ORIGIN ??= "http://docs.localhost:3005";

clearLocalPorts([3103, 3104, 3105]);
const sites = runLocalProcesses(
  root,
  [
    createLocalProxyProcess(root),
    {
      name: "storefront",
      headerColor: "36",
      lifecycle: "persistent",
      readyPattern: /Local:\s+http:\/\/127\.0\.0\.1:3104/u,
      command: "pnpm",
      args: [
        "--filter",
        "@purin-labs/storefront",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "3104",
        "--strictPort",
      ],
    },
    {
      name: "portal",
      headerColor: "35",
      lifecycle: "persistent",
      readyPattern: /Local:\s+http:\/\/127\.0\.0\.1:3103/u,
      command: "pnpm",
      args: [
        "--filter",
        "@purin-labs/portal",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "3103",
        "--strictPort",
      ],
    },
    {
      name: "docs",
      headerColor: "34",
      lifecycle: "persistent",
      readyPattern: /Local:\s+http:\/\/127\.0\.0\.1:3105/u,
      command: "pnpm",
      args: [
        "--filter",
        "satyr-docs",
        "dev",
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
    },
  ],
  "sites",
);
await sites.ready;
printLocalSiteLinks();

function printLocalSiteLinks() {
  const colorsEnabled =
    process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  console.log(`\n${styleTerminalText("Sites", siteLinkColor, colorsEnabled)}`);
  for (const site of localSites) printLocalSiteLink(site, colorsEnabled);
  console.log();
}

function printLocalSiteLink(site, colorsEnabled) {
  const label = styleTerminalText(
    site.label.padEnd(8),
    siteLinkColor,
    colorsEnabled,
  );
  const url = styleTerminalText(site.url, `${siteLinkColor};4`, colorsEnabled);
  console.log(`  ${label} ${url}`);
}

function styleTerminalText(text, color, colorsEnabled) {
  return colorsEnabled ? `\u001b[${color}m${text}\u001b[0m` : text;
}
