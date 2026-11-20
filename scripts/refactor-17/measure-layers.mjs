#!/usr/bin/env node
// Refactor 17: a first measure of the three layers in the Platform Worker.
//
// The script gives each file of services/platform/src a target module by name
// rules: F = foundation, A = product area, S = surface, W = Worker entry. It then
// counts the imports that cross two modules, the imports that point upward and
// the imports between two areas. The rules are a first guess. Step 0.2 of
// docs/refactor-17.md replaces them with a reviewed list of targets.
//
//   node scripts/refactor-17/measure-layers.mjs services/platform/src
//   node scripts/refactor-17/measure-layers.mjs services/platform/src "F:tools -> A:kitchen"
//   node scripts/refactor-17/measure-layers.mjs --packages .
//
// The second form also prints 25 file pairs of one crossing. The third form reads
// each package.json of the workspace and lists the package dependencies that
// point upward. The file scan also counts an import of a workspace package.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
const PACKAGE_TARGET = {
  std: "F:std", "type-utils": "F:std", contracts: "F:contracts", "control-api": "F:control",
  collaboration: "F:collaboration", "async-control": "F:async-control",
  "commerce-contracts": "A:commerce", "commerce-client": "A:commerce", "commerce-query-sqlite": "A:commerce",
  "product-description-crdt": "A:commerce", commerce: "A:commerce",
  "menu-draft-crdt": "A:cafe", "menu-board-crdt": "A:cafe",
  "bakery-model": "A:kitchen", "bakery-workflow": "A:kitchen", "production-simulation": "A:kitchen",
  "production-plan-crdt": "A:kitchen", "costs-sheet-crdt": "A:kitchen", "workflow-canvas-crdt": "A:kitchen",
  "email-draft-crdt": "A:inbox", "mail-reply-crdt": "A:inbox",
  portal: "S:portal", storefront: "S:storefront", docs: "S:docs-site", platform: "W:platform", punter: "W:punter",
};
const RANK = { F: 0, A: 1, S: 2, W: 3 };
const workspaceName = (spec) => { const m = spec.match(/^@(?:seams|purin-labs)\/([^/]+)/); return m ? m[1] : null; };
if (process.argv[2] === "--packages") {
  const base = resolve(process.argv[3] ?? ".");
  const found = [];
  for (const group of ["packages", "apps", "services", "scripts"]) {
    const dir = join(base, group); let names = []; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) { try { found.push([name, JSON.parse(readFileSync(join(dir, name, "package.json"), "utf8"))]); } catch { /* no package here */ } }
  }
  let up = 0, all = 0; const lines = [];
  for (const [folder, json] of found) {
    const from = PACKAGE_TARGET[folder] ?? "?:" + folder;
    for (const dep of Object.keys({ ...json.dependencies, ...json.devDependencies })) {
      const name = workspaceName(dep); if (name === null) continue; all++;
      const to = PACKAGE_TARGET[name] ?? "?:" + name;
      if (RANK[from[0]] < RANK[to[0]] || (from[0] === "A" && to[0] === "A" && from !== to)) { up++; lines.push(`${from[0] === "A" ? "area-to-area" : "upward"}  ${folder} (${from}) -> ${name} (${to})`); }
    }
  }
  console.log(`workspace packages ${found.length} | workspace dependencies ${all} | upward or area-to-area ${up}`);
  console.log(lines.sort().join("\n"));
  process.exit(0);
}
const root = resolve(process.argv[2]);
function walk(d, out = []) { for (const n of readdirSync(d)) { if (["node_modules","generated","dist"].includes(n)) continue; const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p); } return out; }
// keyword -> target module, tested on the path inside a mixed folder
const KW = [
  [/whatsapp|email|mail|gmail|inbox|contact-verification/, "A:inbox"],
  [/menu|board|screen-pairing|order-queue|sold-out|counter|terminal|register|cafe|order-times/, "A:cafe"],
  [/bakery|recipe|cost|production|workflow|kitchen|pastry|purchasing|inventory|stock|supplier(?!-pay)/, "A:kitchen"],
  [/commerce|shopify|stripe|square|payout|payment|checkout|offer|product|campaign|export-preset|merchant|shipping|refund|supplier-pay|paid-/, "A:commerce"],
  [/device|voice/, "A:devices"],
  [/memor|eval|brain|case-execution/, "A:brain"],
  [/custom-connector|integration|provider|airtable|typesafe|dropbox|discord|external-record|credential-lifecycle|vault(?!-root)|claude|jev/, "A:integrations"],
  [/onboarding|activation|invitation|user-preferences|workspace-ai-budget|operator|support|account-removal|first-operational|billing|inference-selection|organisation-workspace/, "A:organisation"],
  [/slack/, "S:slack"],
  [/portal|screen/, "S:portal"],
  [/chat|side-case|goal|project/, "F:conversation"],
];
const kw = (p, fallback) => { for (const [re, m] of KW) if (re.test(p)) return m; return fallback; };
function target(rel) {
  const p = rel.split(sep).join("/");
  const top = p.split("/")[0];
  if (!p.includes("/")) {
    if (/^(result|http|observability|runtime-fetch|request-deadline|boundary|ids|env|public-origin|isolate-location|fault-injection-auth|case-identity)\./.test(p)) return "F:kernel";
    if (/^(placement|organisation-execution-scope|database-handles)/.test(p)) return "F:tenancy";
    if (/^(policy-|approval-authentication|redaction|incremental-output-screen)/.test(p)) return "F:authority";
    if (/^(integration-gateway|control-router)/.test(p)) return "W:platform-entry";
    if (/^onboarding/.test(p)) return "A:organisation";
    return "F:agent"; // ingress-queue, workspace-*, harness-checkpoint, actor-wasm, agent-old-names
  }
  switch (top) {
    case "actors": {
      const f = p.slice(7);
      if (/^actor-journal\//.test(f)) return "F:agent";
      if (/^(lifecycle\/|actor-|schema|sql-rows|current-actor-schema|hibernatable|warm|conversation-residency)/.test(f)) return "F:actor-runtime";
      if (/^(connector-email|connector\/(connector-)?email)/.test(f)) return "S:email";
      if (/^(connector-whatsapp|connector\/(connector-)?whatsapp)/.test(f)) return "S:whatsapp";
      if (/^(action-ledger|action-)/.test(f)) return "F:authority";
      if (/^(collaboration)/.test(f)) return "F:collaboration";
      const k = kw(f, null); if (k && !/^(session\/|case\/|agent-session|pi-|embedded-harness|code-mode|harness-(history|steering|follow|side|memory)|message-|workspace-execution|transient|model)/.test(f)) return k;
      if (/^(connector|organisation)/.test(f)) return "F:conversation";
      if (/^(case)/.test(f)) return "F:conversation";
      return "F:agent";
    }
    case "agent-tools": { const f = p.slice(12); if (/^(catalog\/|define-tool|registry|context|effect-action|session-support|turn\/|files\/|messages\/)/.test(f)) return "F:tools"; return kw(f, "F:tools"); }
    case "data": return kw(p.slice(5), /access|grant|authz|capability|permission|held-output|policy/.test(p) ? "F:authority" : /agent|pinned|query-source/.test(p) ? "F:agent" : "F:tenancy");
    case "control": { const f = p.slice(8); if (/^(admission\/)/.test(f)) return kw(f, "F:control"); if (/^routes\//.test(f)) return kw(f.slice(7), /access|permission|held-output/.test(f) ? "F:authority" : /agent|session|case/.test(f) ? "F:agent" : "A:organisation"); return kw(f, "F:control"); }
    case "commerce": return kw(p.slice(9), "A:commerce");
    case "chat": return /^chat\/(portal-stream|reply-stream-projector|application|turn\/|screen-|.*-labels|prompt|feedback|thread-read-timing|kitchen-observation|workspace-canvas|case-screen-observations|public-conversation|input-|origin|generation-failure|connector-status|permission-items)/.test(p) ? "S:portal" : "F:conversation";
    case "slack": case "slack-ingress": return "S:slack";
    case "gateway": case "gateway-routing": return /mail-webhooks/.test(p) ? "S:email" : kw(p, "S:webhooks");
    case "authorization": case "access-control": case "policy": case "request-authority": case "credential-vault": case "vault-onepassword": case "seams": return "F:authority";
    case "account-platform": return "F:tenancy";
    case "context": case "models": case "model-exit": case "chatgpt-exit": case "code-mode-sandbox": case "messages": case "cues": case "schedules": return "F:agent";
    case "projects": return "F:conversation";
    case "case-context-discovery": return "F:agent";
    case "case-execution": case "memory": case "evals": return "A:brain";
    case "shopify": case "stripe": case "payouts": case "payout-providers": case "commerce-lab": return "A:commerce";
    case "provider-adapters": case "provider-lifecycle": case "provider-workflows": case "custom-connectors": case "integrations": case "external-records": case "jev-features": return "A:integrations";
    case "mail-inbox": return "A:inbox";
    case "mail": return "S:email";
    case "whatsapp": return "S:whatsapp";
    case "devices": case "voice": return "A:devices";
  }
  return "?:" + top;
}
const files = walk(root); const mod = new Map(files.map((f) => [f, target(relative(root, f))]));
const lines = new Map(), edges = new Map(), fileEdges = [], packageEdges = new Map();
const re = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const byNoExt = new Map(files.map((f) => [f.replace(/\.(ts|tsx)$/, ""), f]));
for (const f of files) {
  const text = readFileSync(f, "utf8"); const a = mod.get(f); lines.set(a, (lines.get(a) ?? 0) + text.split("\n").length);
  let m; re.lastIndex = 0;
  while ((m = re.exec(text))) { const spec = m[1] ?? m[2];
    if (!spec.startsWith(".")) { const name = workspaceName(spec); const b = name === null ? undefined : PACKAGE_TARGET[name]; if (b !== undefined && b !== a) { const k = a + " -> " + b; packageEdges.set(k, (packageEdges.get(k) ?? 0) + 1); } continue; } const t = resolve(dirname(f), spec); const tf = byNoExt.get(t) ?? byNoExt.get(join(t, "index")); if (!tf) continue; const b = mod.get(tf); if (a !== b) { const k = a + " -> " + b; edges.set(k, (edges.get(k) ?? 0) + 1); fileEdges.push([a, b, relative(root, f), relative(root, tf)]); } }
}
const rank = { F: 0, A: 1, S: 2, W: 3 };
let total = 0, up = 0, cross = 0; const ups = [], crosses = [];
for (const [k, n] of edges) { const [a, b] = k.split(" -> "); total += n; if (rank[a[0]] < rank[b[0]]) { up += n; ups.push([n, k]); } else if (a[0] === "A" && b[0] === "A") { cross += n; crosses.push([n, k]); } }
console.log("LINES", [...lines].sort((x, y) => y[1] - x[1]).map(([k, n]) => k + "=" + n).join("  "));
console.log("cross-module edges", total, "| upward", up, "| area-to-area", cross);
{ let pu = 0, pt = 0; const list = []; for (const [k, c] of packageEdges) { const [a, b] = k.split(" -> "); pt += c; if (rank[a[0]] < rank[b[0]]) { pu += c; list.push([c, k]); } } console.log("package imports", pt, "| upward", pu); console.log("UPWARD PACKAGE IMPORTS\n" + list.sort((x, y) => y[0] - x[0]).slice(0, 14).map(([c, k]) => c + " " + k).join("\n")); }
console.log("UPWARD\n" + ups.sort((x, y) => y[0] - x[0]).slice(0, 45).map(([n, k]) => n + " " + k).join("\n"));
console.log("AREA-TO-AREA\n" + crosses.sort((x, y) => y[0] - x[0]).slice(0, 25).map(([n, k]) => n + " " + k).join("\n"));
// foundation-internal cycles
const F = [...new Set([...lines.keys()].filter((k) => k[0] === "F"))];
const fe = [...edges].filter(([k]) => { const [a, b] = k.split(" -> "); return a[0] === "F" && b[0] === "F"; });
console.log("FOUNDATION-INTERNAL\n" + fe.sort((x, y) => y[1] - x[1]).map(([k, n]) => n + " " + k).join("\n"));
if (process.argv[3]) { const want = process.argv[3]; console.log("SAMPLE " + want); console.log(fileEdges.filter(([a, b]) => a + " -> " + b === want).slice(0, 25).map((e) => e[2] + " -> " + e[3]).join("\n")); }

// --write-targets <file>: writes the first list of targets for scripts/check-layers.mjs.
// A folder whose files all have one module becomes one rule. Each file of a mixed
// folder gets its own line. After this first write, a person edits the list by hand.
{
  const at = process.argv.indexOf("--write-targets");
  if (at !== -1) {
    const NAME = { F: "foundation", A: "areas", S: "surfaces", W: "workers" };
    const RENAME = { "F:tools": "foundation/agent-tools", "W:platform-entry": "workers/platform" };
    const name = (m) => RENAME[m] ?? NAME[m[0]] + "/" + m.slice(2);
    const base = process.cwd();
    const byDir = new Map();
    for (const [file, m] of mod) {
      let dir = dirname(relative(base, file));
      for (;;) { (byDir.get(dir) ?? byDir.set(dir, new Set()).get(dir)).add(name(m)); if (dir === relative(base, root)) break; dir = dirname(dir); }
    }
    const rules = {}, files = {};
    for (const [dir, set] of byDir) { const parent = dirname(dir); if (set.size === 1 && (byDir.get(parent)?.size ?? 2) > 1) rules[dir.split(sep).join("/") + "/"] = [...set][0]; }
    for (const [file, m] of mod) { const rel = relative(base, file); if (byDir.get(dirname(rel)).size > 1) files[rel.split(sep).join("/")] = name(m); }
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    const previous = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    writeFileSync(process.argv[at + 1], JSON.stringify({ ...previous, rules: sorted(rules), files: sorted(files) }, null, 2) + "\n");
    console.log("rules", Object.keys(rules).length, "files", Object.keys(files).length);
  }
}
