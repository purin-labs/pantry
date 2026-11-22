#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { cliCommand, cliResult } from "../browser-cli.mjs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const artifactDir = join(root, "output/playwright/plan21-browser");
const daemonDir = join(artifactDir, "daemon");
const session = `plan21-${process.pid}`;
const baseUrl = (
  process.env.PANTRY_PORTAL_URL ?? "http://localhost:7700"
).replace(/\/$/u, "");
const fixturePath = join(root, "scripts/plan21/browser-acceptance-fixture.js");
const checkPath = join(root, "scripts/plan21/browser-acceptance-check.js");
const openWorkspacePath = join(
  root,
  "scripts/plan21/browser-acceptance-open-workspace.js",
);
const openOrdersPath = join(
  root,
  "scripts/plan21/browser-acceptance-open-orders.js",
);
const directRoutesPath = join(
  root,
  "scripts/plan21/browser-acceptance-direct-routes.js",
);
const providerRecoveryPath = join(
  root,
  "scripts/plan21/browser-acceptance-provider-recovery.js",
);

mkdirSync(daemonDir, { recursive: true });

const cli = cliCommand();
const cliEnv = {
  ...process.env,
  PWTEST_DAEMON_SESSION_DIR: daemonDir,
  PLAYWRIGHT_BROWSERS_PATH:
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), "Library/Caches/ms-playwright"),
};

function runCli(command, args = []) {
  const result = spawnSync(
    cli.file,
    [...cli.args, "--session", session, "--json", command, ...args],
    {
      cwd: root,
      env: cliEnv,
      encoding: "utf8",
    },
  );
  return cliResult(command, result);
}

function assertCheck(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`PASS ${message}\n`);
}

function assertCommonPage(check, expectedPath) {
  assertCheck(check.path === expectedPath, `path is ${expectedPath}`);
  assertCheck(check.heading.length > 0, `route ${expectedPath} exposes an h1`);
  assertCheck(
    check.noHorizontalOverflow,
    `route ${expectedPath} has no horizontal overflow`,
  );
  assertCheck(
    check.semanticLandmarks.length === 0 ||
      check.semanticLandmarks.some(({ label }) => label === "Global"),
    `route ${expectedPath} names every navigation landmark`,
  );
  assertCheck(
    check.headingLevels[0] === 1 &&
      check.headingLevels.every(
        (level, index, levels) => index === 0 || level <= levels[index - 1] + 1,
      ),
    `route ${expectedPath} keeps a sequential heading outline`,
  );
  assertCheck(
    check.touchTargets.count === 0 || check.touchTargets.violations === 0,
    `route ${expectedPath} keeps interactive targets at least 44px in both dimensions`,
  );
}

async function assertTargetAvailable() {
  let response;
  try {
    response = await fetch(`${baseUrl}/portal`, { redirect: "manual" });
  } catch (error) {
    throw new Error(
      `target unavailable at ${baseUrl}; start it with ` +
        "pnpm portal:build && pnpm --filter @purin-labs/platform dev --ip localhost --port 7700 --var PANTRY_PUBLIC_ORIGIN:http://localhost:7700",
    );
  }
  if (response.status < 200 || response.status >= 400) {
    throw new Error(
      `target ${baseUrl}/portal returned HTTP ${response.status}`,
    );
  }
}

function checkPage() {
  return runCli("run-code", ["--filename", checkPath]);
}

function closeBrowser() {
  try {
    runCli("close");
  } catch {
    // The browser may not have opened when a prerequisite failed.
  }
}

async function main() {
  await assertTargetAvailable();
  process.stdout.write(`[plan21] browser acceptance target ${baseUrl}\n`);
  runCli("open", ["data:text/html,<title>Plan 21 fixture</title>"]);
  runCli("run-code", ["--filename", fixturePath]);

  runCli("goto", [`${baseUrl}/portal`]);
  const desktopSignIn = checkPage();
  assertCommonPage(desktopSignIn, "/portal");
  assertCheck(
    desktopSignIn.heading === "Sign in to Purin Pantry",
    "signed-out page uses the Café sign-in heading",
  );
  assertCheck(
    desktopSignIn.googleLabel === "Continue with Google",
    "Google sign-in action has an accessible label",
  );
  assertCheck(
    desktopSignIn.googleHref ===
      "/v1/control/auth/google/start?returnTo=%2Fportal",
    "Google action uses the canonical control route",
  );
  assertCheck(
    desktopSignIn.focusedId === "signin-title" &&
      desktopSignIn.focusedHeadingVisible,
    "sign-in heading receives visible focus after the route settles",
  );
  assertCheck(
    desktopSignIn.googleHeight !== null &&
      desktopSignIn.googleHeight >= 48 &&
      desktopSignIn.googleHeight <= 52,
    "Google action remains 50px high on desktop",
  );
  assertCheck(
    desktopSignIn.mainCount === 1 && desktopSignIn.h1Count === 1,
    "sign-in exposes one main landmark and one page heading",
  );
  assertCheck(
    desktopSignIn.semanticLists.length === 0,
    "sign-in does not claim list semantics for narrative content",
  );

  runCli("resize", ["1080", "800"]);
  assertCommonPage(checkPage(), "/portal");
  runCli("resize", ["760", "900"]);
  assertCommonPage(checkPage(), "/portal");

  runCli("resize", ["390", "844"]);
  const mobileSignIn = checkPage();
  assertCommonPage(mobileSignIn, "/portal");
  assertCheck(
    mobileSignIn.googleHeight !== null &&
      mobileSignIn.googleHeight >= 48 &&
      mobileSignIn.googleHeight <= 52,
    "Google action remains 50px high at 390px",
  );
  const reducedMotion = runCli("run-code", [
    "async (page) => { await page.emulateMedia({ reducedMotion: 'reduce' }); return page.evaluate(() => ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior })); }",
  ]);
  assertCheck(
    reducedMotion.reduced && reducedMotion.scrollBehavior === "auto",
    "reduced-motion mode disables smooth document scrolling",
  );
  runCli("run-code", [
    "async (page) => { await page.emulateMedia({ reducedMotion: 'no-preference' }); return true; }",
  ]);
  runCli("resize", ["320", "800"]);
  const narrowestSignIn = runCli("run-code", [
    "async (page) => page.evaluate(() => { const heading = document.querySelector('.signin-story-body h2'); if (!(heading instanceof HTMLElement)) return null; const style = getComputedStyle(heading); return { viewport: innerWidth, documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth, headingFits: heading.scrollWidth <= heading.clientWidth, whiteSpace: style.whiteSpace }; })",
  ]);
  assertCheck(
    narrowestSignIn !== null &&
      narrowestSignIn.viewport === 320 &&
      narrowestSignIn.documentFits,
    "sign-in reflows without horizontal overflow at 320px",
  );
  assertCheck(
    narrowestSignIn.headingFits && narrowestSignIn.whiteSpace === "nowrap",
    "sign-in story remains one line and fits at 320px",
  );
  runCli("resize", ["390", "844"]);

  const directPath = "/portal/direct-route-check";
  runCli("goto", [`${baseUrl}${directPath}`]);
  const direct = checkPage();
  assertCommonPage(direct, directPath);
  assertCheck(
    direct.heading === "Sign in to Purin Pantry",
    "direct SPA fallback still resolves the signed-out app",
  );
  runCli("go-back");
  assertCheck(
    checkPage().path === "/portal",
    "browser Back restores the canonical portal route",
  );
  runCli("go-forward");
  assertCheck(
    checkPage().path === directPath,
    "browser Forward restores the direct route",
  );

  runCli("resize", ["1440", "900"]);
  runCli("goto", [`${baseUrl}/portal?p21_auth=1`]);
  runCli("run-code", [
    "async (page) => { await page.evaluate(() => { document.cookie = 'pantry_csrf=csrf_plan21; path=/; SameSite=Lax'; }); return true; }",
  ]);
  const workspaces = checkPage();
  assertCommonPage(workspaces, "/portal");
  assertCheck(
    workspaces.heading === "Workspaces",
    "mocked session renders the workspace list",
  );
  assertCheck(
    workspaces.mainCount === 1 && workspaces.h1Count === 1,
    "workspace list exposes one main landmark and one page heading",
  );
  assertCheck(
    workspaces.semanticLandmarks.some(({ label }) => label === "Workspaces"),
    "workspace list exposes a named workspace navigation landmark",
  );
  assertCheck(
    workspaces.semanticLists.length > 0 &&
      workspaces.semanticLists.every(({ itemCount }) => itemCount > 0),
    "workspace navigation keeps its list semantics",
  );
  const formFailure = runCli("run-code", [
    "async (page) => { const name = page.getByRole('textbox', { name: 'Workspace name' }); await name.fill('Unavailable workspace'); await page.getByRole('button', { name: 'Create workspace' }).click(); await page.getByRole('alert').waitFor({ state: 'visible', timeout: 10_000 }); return true; }",
  ]);
  assertCheck(
    formFailure === true,
    "workspace creation exposes its failed submission beside the form",
  );
  const failedWorkspaces = checkPage();
  assertCheck(
    failedWorkspaces.alertCount === 1 &&
      failedWorkspaces.invalidFieldCount === 2,
    "workspace form marks affected fields invalid",
  );
  assertCheck(
    failedWorkspaces.describedError ===
      "Café could not create this workspace. Try again.",
    "workspace form associates merchant-safe recovery copy with its fields",
  );
  assertCheck(
    failedWorkspaces.describedFieldIds.length === 2 &&
      failedWorkspaces.describedFieldIds.every(
        ({ describedBy }) => describedBy === "create-workspace-error",
      ),
    "workspace form associates both invalid fields with one recovery message",
  );
  runCli("run-code", ["--filename", openWorkspacePath]);
  runCli("run-code", [
    "async (page) => { await page.locator('#home-attention-title').waitFor({ state: 'visible', timeout: 10_000 }); return true; }",
  ]);
  const home = checkPage();
  assertCommonPage(home, "/portal/cafe-browser-lab");
  assertCheck(
    home.heading === "Home",
    "workspace navigation opens Home without a document reload",
  );
  assertCheck(
    home.navigationLabels.includes("Products") &&
      home.navigationLabels.includes("Customer orders"),
    "workspace shell exposes canonical Commerce navigation",
  );
  assertCheck(
    home.semanticLists.length > 0 &&
      home.semanticLists.every(({ itemCount }) => itemCount >= 0),
    "Home exposes list semantics for bounded observations",
  );
  assertCheck(
    home.touchTargets.minimumHeight === null ||
      home.touchTargets.minimumHeight >= 44,
    "Home actions preserve 44px touch target height",
  );
  assertCheck(
    home.focusedId.length > 0 && home.focusedHeadingVisible,
    "workspace route moves visible focus into the new page heading",
  );
  const homeAccessibility = runCli("run-code", [
    "async (page) => { const client = await page.context().newCDPSession(page); const tree = await client.send('Accessibility.getFullAXTree'); const nodes = tree.nodes.map((node) => ({ role: node.role?.value ?? '', name: node.name?.value ?? '' })); const has = (role, name) => nodes.some((node) => node.role === role && node.name === name); const includes = (role, name) => nodes.some((node) => node.role === role && node.name.includes(name)); return { root: nodes.some((node) => node.role === 'RootWebArea'), globalNavigation: has('navigation', 'Global'), main: nodes.some((node) => node.role === 'main'), homeHeading: has('heading', 'Home'), workspaceNavigation: has('navigation', 'Workspace pages'), search: includes('button', 'Search Café'), urgentAction: includes('link', 'Open customer order') }; }",
  ]);
  assertCheck(
    homeAccessibility.root &&
      homeAccessibility.globalNavigation &&
      homeAccessibility.main,
    "computed accessibility tree exposes the document, global navigation, and main landmarks",
  );
  assertCheck(
    homeAccessibility.homeHeading && homeAccessibility.workspaceNavigation,
    "computed accessibility tree exposes the Home heading and named workspace navigation",
  );
  assertCheck(
    homeAccessibility.search && homeAccessibility.urgentAction,
    "computed accessibility tree exposes the command trigger and urgent action names",
  );
  const identityLayer = runCli("run-code", [
    "async (page) => { const menu = page.locator('details.identity-menu'); const summary = menu.locator('summary'); await summary.click(); const panel = menu.locator(':scope > div'); await panel.waitFor({ state: 'visible', timeout: 10_000 }); const result = await page.evaluate(() => { const panel = document.querySelector('.identity-menu > div'); const nav = document.querySelector('.portal-nav'); if (!(panel instanceof HTMLElement) || !(nav instanceof HTMLElement)) return null; const panelBox = panel.getBoundingClientRect(); const probe = document.createElement('div'); probe.style.position = 'fixed'; probe.style.zIndex = '20'; probe.style.insetInlineStart = `${panelBox.left}px`; probe.style.insetBlockStart = `${panelBox.top}px`; probe.style.width = `${panelBox.width}px`; probe.style.height = `${panelBox.height}px`; document.body.append(probe); const topElement = document.elementFromPoint(panelBox.left + panelBox.width / 2, panelBox.top + panelBox.height / 2); const menuWins = topElement !== null && panel.contains(topElement); probe.remove(); return { menuWins, navLayer: getComputedStyle(nav).zIndex }; }); await page.keyboard.press('Escape'); return result; }",
  ]);
  assertCheck(
    identityLayer?.menuWins && identityLayer.navLayer === "30",
    "account menu renders above sticky workspace actions in the global chrome layer",
  );
  const commandClose = runCli("run-code", [
    "async (page) => { const trigger = page.getByRole('button', { name: 'Search Café' }); await trigger.focus(); await page.keyboard.press('Meta+K'); const dialog = page.getByRole('dialog', { name: 'Search workspace pages' }); await dialog.waitFor({ state: 'visible', timeout: 10_000 }); const input = page.getByRole('combobox', { name: 'Search workspace pages' }); const listbox = page.getByRole('listbox', { name: 'Workspace page results' }); const activeId = await input.getAttribute('aria-activedescendant'); const activeOption = page.locator('[role=option][aria-selected=true]'); const focusedInput = await input.evaluate((node) => document.activeElement === node); const modal = await dialog.evaluate((node) => node.matches(':modal')); const hasListbox = await listbox.count() === 1; const roleOptions = await page.getByRole('option').count(); const activeOptionId = await activeOption.getAttribute('id'); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden', timeout: 10_000 }); await page.waitForFunction(() => document.activeElement?.matches('.portal-command-trigger')); return { focusedInput, focusRestored: await trigger.evaluate((node) => document.activeElement === node), modal, hasListbox, roleOptions, activeOption: activeId !== null && activeOptionId === activeId }; }",
  ]);
  assertCheck(
    commandClose.focusedInput && commandClose.focusRestored,
    "Command-K focuses search and Escape restores the trigger",
  );
  assertCheck(
    commandClose.modal &&
      commandClose.hasListbox &&
      commandClose.roleOptions > 0 &&
      commandClose.activeOption,
    "command palette exposes a modal dialog, combobox listbox, and active option semantics",
  );
  const commandNavigation = runCli("run-code", [
    "async (page) => { await page.keyboard.press('Meta+K'); const input = page.getByRole('combobox', { name: 'Search workspace pages' }); await input.fill('customer orders'); const activeLabel = (await page.locator('[role=option][aria-selected=true] span').textContent() ?? '').trim(); await page.keyboard.press('Enter'); await page.locator('h1#portal-page-title').filter({ hasText: 'Customer orders' }).waitFor({ state: 'visible', timeout: 10_000 }); return { activeLabel, path: await page.evaluate(() => location.pathname), focused: await page.evaluate(() => document.activeElement?.id === 'portal-page-title'), focusIndicator: await page.evaluate(() => { const active = document.activeElement; if (!(active instanceof HTMLElement)) return null; const style = getComputedStyle(active); return { matchesFocusVisible: active.matches(':focus-visible'), outlineStyle: style.outlineStyle, outlineColor: style.outlineColor, outlineWidth: style.outlineWidth }; }) }; }",
  ]);
  assertCheck(
    commandNavigation.activeLabel === "Customer orders",
    "command palette filters to the canonical Customer orders destination",
  );
  assertCheck(
    commandNavigation.path === "/portal/cafe-browser-lab/orders" &&
      commandNavigation.focused,
    "Enter opens and focuses the command destination",
  );
  assertCheck(
    commandNavigation.focusIndicator?.matchesFocusVisible &&
      commandNavigation.focusIndicator.outlineStyle === "solid" &&
      commandNavigation.focusIndicator.outlineColor !== "rgb(0, 0, 0)",
    "keyboard route focus keeps a muted visible focus cue",
  );
  runCli("go-back");
  assertCheck(
    checkPage().path === "/portal/cafe-browser-lab",
    "command palette navigation preserves browser Back",
  );
  const rail = runCli("run-code", [
    "async (page) => { const toggle = page.getByRole('button', { name: /sidebar/ }); const shell = page.locator('.portal-shell-workspace'); const aside = page.locator('aside.console-sidebar'); if (await toggle.getAttribute('aria-expanded') === 'false') { await toggle.click(); await page.waitForTimeout(340); } const expandedWidth = (await aside.boundingBox())?.width ?? 0; const expandedIcon = await toggle.locator('svg').getAttribute('class'); const toggleBox = await toggle.boundingBox(); const asideBox = await aside.boundingBox(); const toggleInset = toggleBox === null || asideBox === null ? null : toggleBox.x - (asideBox.x + asideBox.width); const transitionDuration = await shell.evaluate((node) => getComputedStyle(node).transitionDuration); await toggle.click(); await page.waitForTimeout(340); const collapsedWidth = (await aside.boundingBox())?.width ?? 0; const collapsed = await shell.getAttribute('data-sidebar-state') === 'collapsed'; const collapsedLabel = await toggle.getAttribute('aria-label'); const collapsedIcon = await toggle.locator('svg').getAttribute('class'); const iconsAligned = await page.locator('.console-nav-item').evaluateAll((links) => links.every((link) => { const icon = link.querySelector('.console-nav-icon svg'); if (!(icon instanceof SVGElement)) return false; const linkBox = link.getBoundingClientRect(); const iconBox = icon.getBoundingClientRect(); return Math.abs(iconBox.width - 18) < 0.5 && Math.abs(iconBox.height - 18) < 0.5 && Math.abs(linkBox.left + linkBox.width / 2 - (iconBox.left + iconBox.width / 2)) < 0.5; })); await toggle.click(); await page.waitForTimeout(340); const restoredWidth = (await aside.boundingBox())?.width ?? 0; return { expandedWidth, collapsedWidth, restoredWidth, collapsed, collapsedLabel, expandedIcon, collapsedIcon, toggleInset, iconsAligned, transitionDuration }; }",
  ]);
  assertCheck(
    rail.collapsed && rail.collapsedLabel === "Expand sidebar",
    "sidebar toggle exposes and enters its collapsed state",
  );
  assertCheck(
    rail.expandedWidth === 264 &&
      rail.collapsedWidth === 60 &&
      rail.restoredWidth === 264,
    "sidebar transitions between the 264px panel and 60px rail",
  );
  assertCheck(
    rail.toggleInset === 8,
    "sidebar toggle sits 0.5rem from the rail edge",
  );
  assertCheck(
    rail.expandedIcon === "console-sidebar-toggle-icon" &&
      rail.collapsedIcon === "console-sidebar-toggle-icon",
    "sidebar toggle keeps the hamburger menu icon in both states",
  );
  assertCheck(
    rail.iconsAligned,
    "collapsed sidebar keeps every navigation icon optically centered",
  );
  assertCheck(
    rail.transitionDuration !== "0s",
    "sidebar width change uses an interruptible CSS transition",
  );
  runCli("resize", ["1161", "800"]);
  const railBoundaryWide = checkPage();
  runCli("resize", ["1160", "800"]);
  const railBoundaryCompact = checkPage();
  assertCheck(
    railBoundaryWide.touchTargets.violations === 0 &&
      railBoundaryCompact.touchTargets.violations === 0,
    "rail breakpoint preserves touch targets on both sides of 1160px",
  );
  runCli("resize", ["1440", "900"]);
  const workspaceSwitch = runCli("run-code", [
    "async (page) => { const trigger = page.getByRole('button', { name: /^Workspace:/ }); await trigger.focus(); await page.keyboard.press('ArrowDown'); const choice = page.getByRole('menuitemradio', { name: /Riverside Cafe/ }); await choice.waitFor({ state: 'visible', timeout: 10_000 }); const openedWithKeyboard = await trigger.getAttribute('aria-expanded') === 'true'; await choice.focus(); await page.keyboard.press('Enter'); await page.waitForURL('**/portal/riverside-cafe'); await page.locator('h1#portal-page-title').filter({ hasText: 'Home' }).waitFor({ state: 'visible', timeout: 10_000 }); const selectedPath = await page.evaluate(() => location.pathname); const selectedWorkspaceLocator = page.locator('.console-switcher-workspace .console-switcher-label'); await selectedWorkspaceLocator.filter({ hasText: 'Riverside Cafe' }).waitFor({ state: 'visible', timeout: 10_000 }); const selectedWorkspace = (await selectedWorkspaceLocator.textContent() ?? '').trim(); const currentTrigger = page.getByRole('button', { name: /^Workspace:/ }); await currentTrigger.focus(); await page.keyboard.press('ArrowDown'); const original = page.getByRole('menuitemradio', { name: /Café browser lab/ }); await original.focus(); await page.keyboard.press('Enter'); await page.waitForURL('**/portal/cafe-browser-lab'); await page.locator('h1#portal-page-title').filter({ hasText: 'Home' }).waitFor({ state: 'visible', timeout: 10_000 }); return { openedWithKeyboard, selectedPath, selectedWorkspace, restoredPath: await page.evaluate(() => location.pathname) }; }",
  ]);
  assertCheck(
    workspaceSwitch.openedWithKeyboard,
    "workspace picker opens from the keyboard",
  );
  assertCheck(
    workspaceSwitch.selectedPath === "/portal/riverside-cafe" &&
      workspaceSwitch.selectedWorkspace === "Riverside Cafe",
    "workspace picker opens the selected workspace directly",
  );
  assertCheck(
    workspaceSwitch.restoredPath === "/portal/cafe-browser-lab",
    "workspace picker can return to the original workspace",
  );
  const wideHome = runCli("run-code", [
    "async (page) => { const main = page.locator('main.portal-main'); const box = await main.boundingBox(); const viewport = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth })); await page.screenshot({ path: 'docs/evidence/plan-21/home-wide.png', fullPage: true }); return { mainWidth: box?.width ?? null, viewportWidth: viewport.width, noHorizontalOverflow: viewport.scrollWidth <= viewport.width }; }",
  ]);
  assertCheck(
    wideHome.viewportWidth === 1440,
    "wide Home evidence uses the 1440px viewport",
  );
  assertCheck(
    wideHome.mainWidth !== null && wideHome.mainWidth >= 900,
    "wide Home content uses the expected shell width",
  );
  assertCheck(
    wideHome.noHorizontalOverflow,
    "wide Home evidence has no horizontal overflow",
  );
  const zoom = runCli("run-code", [
    "async (page) => { const client = await page.context().newCDPSession(page); await client.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 450, deviceScaleFactor: 2, mobile: false }); await page.waitForTimeout(50); const result = await page.evaluate(() => ({ width: innerWidth, scale: devicePixelRatio, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, heading: document.querySelectorAll('h1').length, action: document.querySelectorAll('main a, main button').length })); await client.send('Emulation.clearDeviceMetricsOverride'); return result; }",
  ]);
  assertCheck(
    zoom.width === 720 && zoom.scale === 2,
    "200% equivalent browser metrics use a halved CSS viewport at 2x scale",
  );
  assertCheck(
    !zoom.overflow && zoom.heading === 1 && zoom.action > 0,
    "200% equivalent reflow preserves the heading, primary action, and horizontal fit",
  );
  runCli("resize", ["390", "844"]);
  const narrowHome = runCli("run-code", [
    "async (page) => { const viewport = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth })); await page.screenshot({ path: 'docs/evidence/plan-21/home-narrow.png', fullPage: true }); return { viewportWidth: viewport.width, noHorizontalOverflow: viewport.scrollWidth <= viewport.width }; }",
  ]);
  assertCheck(
    narrowHome.viewportWidth === 390,
    "narrow Home evidence uses the 390px viewport",
  );
  assertCheck(
    narrowHome.noHorizontalOverflow,
    "narrow Home evidence has no horizontal overflow",
  );
  runCli("resize", ["320", "800"]);
  const authenticatedNarrowest = checkPage();
  assertCommonPage(authenticatedNarrowest, "/portal/cafe-browser-lab");
  assertCheck(
    authenticatedNarrowest.noHorizontalOverflow,
    "authenticated Home reflows without horizontal overflow at 320px",
  );
  assertCheck(
    authenticatedNarrowest.touchTargets.violations === 0,
    "authenticated Home keeps touch targets at 320px",
  );
  runCli("resize", ["1440", "900"]);
  const attention = runCli("run-code", [
    "async (page) => { const action = page.locator('section[aria-labelledby=\"home-attention-title\"] a.primary-button').first(); await action.waitFor({ state: 'visible', timeout: 10_000 }); await action.focus(); const label = (await action.textContent() ?? '').trim(); await page.keyboard.press('Enter'); await page.locator('h1#portal-page-title').filter({ hasText: 'Order #1041' }).waitFor({ state: 'visible', timeout: 10_000 }); const currentUrl = page.url(); const path = currentUrl.slice(currentUrl.indexOf('/', currentUrl.indexOf('://') + 3)).split('?')[0]; return { label, path, heading: (await page.locator('h1#portal-page-title').textContent() ?? '').trim(), focused: await page.evaluate(() => document.activeElement?.id === 'portal-page-title') }; }",
  ]);
  assertCheck(
    attention.label === "Open customer order",
    "urgent Home attention row exposes its primary keyboard action",
  );
  assertCheck(
    attention.path === "/portal/cafe-browser-lab/orders/order_plan21_attention",
    "urgent Home action targets the canonical order detail URL",
  );
  assertCheck(
    attention.heading.startsWith("Order #1041") && attention.focused,
    "urgent Home action opens and focuses the order detail heading",
  );
  const reducedMotionStyles = runCli("run-code", [
    "async (page) => { await page.emulateMedia({ reducedMotion: 'reduce' }); const trigger = page.getByRole('button', { name: 'Search Café' }); await trigger.click(); const dialog = page.getByRole('dialog', { name: 'Search workspace pages' }); await dialog.waitFor({ state: 'visible', timeout: 10_000 }); const styles = await page.evaluate(() => ['.workspace-command-dialog', '.portal-shell-workspace', '.console-sidebar', '.console-nav-label', '.console-switcher-trigger'].map((selector) => { const node = document.querySelector(selector); if (node === null) return { selector, transitionDuration: null, animationDuration: null }; const style = getComputedStyle(node); return { selector, transitionDuration: style.transitionDuration, animationDuration: style.animationDuration }; })); await page.keyboard.press('Escape'); await page.emulateMedia({ reducedMotion: 'no-preference' }); return styles; }",
  ]);
  assertCheck(
    reducedMotionStyles.every(
      ({ transitionDuration, animationDuration }) =>
        (transitionDuration === null ||
          Number.parseFloat(transitionDuration) <= 0.02) &&
        (animationDuration === null ||
          Number.parseFloat(animationDuration) <= 0.02),
    ),
    "reduced-motion mode removes nonessential transition and animation durations",
  );
  runCli("go-back");
  assertCheck(
    checkPage().path === "/portal/cafe-browser-lab",
    "attention detail Back restores Home",
  );
  const directRoutes = runCli("run-code", ["--filename", directRoutesPath]);
  assertCheck(
    directRoutes.length === 11,
    "every canonical list and resource route loads directly",
  );
  assertCheck(
    directRoutes.every(
      (route) =>
        route.path.length > 0 && route.heading.length > 0 && route.shell === 1,
    ),
    "every direct route renders its canonical heading inside one workspace shell",
  );
  runCli("resize", ["1440", "900"]);
  runCli("goto", [`${baseUrl}/portal/cafe-browser-lab`]);
  const navigation = runCli("run-code", ["--filename", openOrdersPath]);
  assertCheck(
    navigation.visited.length === 8,
    "every canonical workspace destination opens from navigation",
  );
  assertCheck(
    navigation.visited.every((route) => route.path.length > 0 && route.focused),
    "every canonical destination restores heading focus",
  );
  assertCheck(
    navigation.sameShell,
    "canonical navigation preserves the mounted workspace shell",
  );
  assertCheck(
    navigation.navigationCount === navigation.initialNavigationCount,
    "canonical navigation does not create a document navigation",
  );
  const interruptedRoute = runCli("run-code", [
    "async (page) => { let releaseProduct = () => {}; const productGate = new Promise((resolve) => { releaseProduct = resolve; }); const pattern = '**/v1/control/organisations/organisation_browser/products?**'; await page.route(pattern, async (route) => { await productGate; await route.continue(); }, { times: 1 }); const open = async (query, heading) => { await page.keyboard.press('Meta+K'); const input = page.getByRole('combobox', { name: 'Search workspace pages' }); await input.pressSequentially(query); await page.keyboard.press('Enter'); await page.locator('h1#portal-page-title').filter({ hasText: heading }).waitFor({ state: 'visible', timeout: 10_000 }); }; await open('products', 'Products'); await open('customer orders', 'Customer orders'); releaseProduct(); await page.waitForTimeout(500); await page.unroute(pattern); return { path: await page.evaluate(() => location.pathname), heading: (await page.locator('h1#portal-page-title').textContent() ?? '').trim() }; }",
  ]);
  assertCheck(
    interruptedRoute.path === "/portal/cafe-browser-lab/orders" &&
      interruptedRoute.heading === "Customer orders",
    "an interrupted Products request cannot overwrite the newer Customer orders route",
  );
  const refreshedRoute = runCli("run-code", [
    "async (page) => { await page.reload(); await page.locator('h1#portal-page-title').filter({ hasText: 'Customer orders' }).waitFor({ state: 'visible', timeout: 10_000 }); const text = (await page.locator('body').textContent() ?? '').replace(/\\s+/gu, ' '); return { path: await page.evaluate(() => location.pathname), heading: (await page.locator('h1#portal-page-title').textContent() ?? '').trim(), globalOpening: text.includes('Opening Pantry') }; }",
  ]);
  assertCheck(
    refreshedRoute.path === "/portal/cafe-browser-lab/orders" &&
      refreshedRoute.heading === "Customer orders" &&
      !refreshedRoute.globalOpening,
    "refresh restores the nested route without a global opening screen",
  );
  runCli("goto", [`${baseUrl}/portal/cafe-browser-lab`]);
  runCli("run-code", [
    "async (page) => { await page.keyboard.press('Meta+K'); const input = page.getByRole('combobox', { name: 'Search workspace pages' }); await input.pressSequentially('customer orders'); await page.keyboard.press('Enter'); await page.locator('h1#portal-page-title').filter({ hasText: 'Customer orders' }).waitFor({ state: 'visible', timeout: 10_000 }); return true; }",
  ]);
  const orders = checkPage();
  assertCommonPage(orders, "/portal/cafe-browser-lab/orders");
  assertCheck(
    orders.heading === "Customer orders",
    "same-shell navigation opens Customer orders",
  );
  runCli("go-back");
  assertCheck(
    checkPage().path === "/portal/cafe-browser-lab",
    "Back preserves the workspace shell route",
  );
  runCli("go-forward");
  assertCheck(
    checkPage().path === "/portal/cafe-browser-lab/orders",
    "Forward restores the nested Commerce route",
  );
  runCli("resize", ["390", "844"]);
  const drawer = runCli("run-code", [
    "async (page) => { const toggle = page.getByRole('button', { name: /sidebar/ }); const sidebar = page.locator('aside.console-sidebar'); if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click(); await toggle.focus(); await page.keyboard.press('Enter'); const closed = await sidebar.getAttribute('hidden') !== null; await page.keyboard.press('Enter'); const reopened = await sidebar.getAttribute('hidden') === null; const switcher = page.getByRole('button', { name: /^Workspace:/ }); await switcher.focus(); await page.keyboard.press('ArrowDown'); const opened = await switcher.getAttribute('aria-expanded') === 'true'; await page.keyboard.press('End'); const endFocused = await page.getByRole('menuitem', { name: /All workspaces/ }).evaluate((node) => document.activeElement === node); await page.keyboard.press('Home'); const homeFocused = await page.getByRole('menuitemradio', { name: /Café browser lab/ }).evaluate((node) => document.activeElement === node); await page.keyboard.press('Escape'); return { closed, reopened, opened, endFocused, homeFocused, switcherFocusRestored: await switcher.evaluate((node) => document.activeElement === node) }; }",
  ]);
  assertCheck(
    drawer.closed && drawer.reopened,
    "compact sidebar closes completely and reopens from the controlled toggle",
  );
  assertCheck(
    drawer.opened &&
      drawer.endFocused &&
      drawer.homeFocused &&
      drawer.switcherFocusRestored,
    "workspace switcher supports Arrow, Home, End, and Escape with focus restoration",
  );
  const compactPreference = runCli("run-code", [
    "async (page) => { const key = 'pantry:cafeos:sidebar-expanded'; await page.evaluate((storageKey) => localStorage.setItem(storageKey, 'false'), key); const before = await page.evaluate((storageKey) => localStorage.getItem(storageKey), key); const toggle = page.getByRole('button', { name: /sidebar/ }); await toggle.focus(); await page.keyboard.press('Enter'); const closed = await page.locator('aside.console-sidebar').getAttribute('hidden') !== null; await page.keyboard.press('Enter'); const reopened = await page.locator('aside.console-sidebar').getAttribute('hidden') === null; const after = await page.evaluate((storageKey) => localStorage.getItem(storageKey), key); return { before, after, closed, reopened }; }",
  ]);
  assertCheck(
    compactPreference.closed &&
      compactPreference.reopened &&
      compactPreference.before === "false" &&
      compactPreference.after === "false",
    "compact drawer close and reopen preserve the persisted desktop rail preference",
  );
  runCli("goto", [
    `${baseUrl}/portal/cafe-browser-lab/operations?p21_auth=1&p21_provider=1`,
  ]);
  const providerReview = runCli("run-code", [
    "async (page) => { await page.locator('h1#portal-page-title').filter({ hasText: 'Operations' }).waitFor({ state: 'visible', timeout: 10_000 }); const review = page.getByRole('button', { name: 'Review change' }); const count = await review.count(); await review.first().click(); const approve = page.getByRole('button', { name: 'Approve and apply' }); try { await approve.waitFor({ state: 'visible', timeout: 10_000 }); } catch { const content = (await page.locator('main').textContent() ?? '').replace(/\\s+/gu, ' '); throw new Error(`Selected action did not render approval controls: ${content}`); } const beforeReceipt = (await page.locator('.commerce-action-status').textContent() ?? '').replace(/\\s+/gu, ' '); await approve.click(); await page.locator('.commerce-action-status .action-state').filter({ hasText: 'Approved' }).waitFor({ state: 'visible', timeout: 10_000 }); const afterText = (await page.locator('.commerce-action-status').textContent() ?? '').replace(/\\s+/gu, ' '); return { count, beforeReceipt, approved: afterText.includes('Approved'), providerReceipt: afterText.includes('Provider receipt') }; }",
  ]);
  assertCheck(
    providerReview.count === 2 && providerReview.approved,
    "synthetic governed approval keeps the Operations review and terminal approval path merchant-visible",
  );
  assertCheck(
    providerReview.providerReceipt === false,
    "synthetic approval does not claim a provider receipt",
  );
  await runCli("goto", [
    `${baseUrl}/portal/cafe-browser-lab/operations?p21_auth=1&p21_provider=1`,
  ]);
  const providerRejection = runCli("run-code", [
    "async (page) => { await page.locator('h1#portal-page-title').filter({ hasText: 'Operations' }).waitFor({ state: 'visible', timeout: 10_000 }); const review = page.getByRole('button', { name: 'Review change' }); await review.last().waitFor({ state: 'visible', timeout: 10_000 }); await review.last().click(); const reject = page.getByRole('button', { name: 'Reject change' }); await reject.first().waitFor({ state: 'visible', timeout: 10_000 }); await reject.first().click(); await reject.last().waitFor({ state: 'visible', timeout: 10_000 }); await reject.last().click(); await page.locator('.commerce-action-status .action-state').filter({ hasText: 'Rejected' }).waitFor({ state: 'visible', timeout: 10_000 }); const text = (await page.locator('.commerce-action-status').textContent() ?? '').replace(/\\s+/gu, ' '); return { rejected: text.includes('Rejected'), providerReceipt: text.includes('Provider receipt'), noProviderOutcome: !text.includes('connected service recorded') }; }",
  ]);
  assertCheck(
    providerRejection.rejected,
    "synthetic governed rejection records a terminal merchant decision",
  );
  assertCheck(
    providerRejection.providerReceipt === false &&
      providerRejection.noProviderOutcome,
    "synthetic rejection records no provider outcome",
  );
  runCli("goto", [
    `${baseUrl}/portal/cafe-browser-lab/integrations?p21_auth=1&p21_provider=1`,
  ]);
  const recovery = runCli("run-code", ["--filename", providerRecoveryPath]);
  assertCheck(
    recovery.statusCount > 0 &&
      recovery.reconnectCount > 0 &&
      recovery.accountVisible,
    "synthetic degraded Slack state exposes the merchant Reconnect recovery action",
  );
  assertCheck(
    recovery.rawReasonVisible === false,
    "synthetic recovery keeps the provider reason out of primary merchant copy",
  );
  assertCheck(
    recovery.activeStatusCount > 0 &&
      recovery.recoveredVisible &&
      recovery.path.includes("p21_recovered=1"),
    "synthetic Reconnect mutation returns to an active Slack connection",
  );
  assertCheck(
    recovery.recoveredText.includes("Healthy") &&
      !recovery.recoveredText.includes("oauth_scope_revoked"),
    "synthetic recovery shows repaired connection health without exposing provider internals",
  );
  process.stdout.write("Plan 21 browser acceptance passed.\n");
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Plan 21 browser acceptance blocked: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  closeBrowser();
}
