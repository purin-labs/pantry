// Captures full Portal app screens for the Seams site's product tour from the local
// preview pages, which hold sample data only: never a real mailbox or account.
// Start the Portal previews first (`pnpm --filter @seams/portal dev --port 3114`).
// Usage: node scripts/site-shots/capture-portal-tour.mjs <out-dir> [inbox|activity|orders|kitchen...]
// It writes 3200 × 2000 PNGs; the site keeps them as 2400 × 1500 WebP files named tour-<view>.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2];
const ONLY = process.argv.slice(3);
const BASE = 'http://127.0.0.1:3114';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CH =
  process.env.CHROME_HEADLESS_SHELL ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CH, [
  '--headless', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shots-'))}`, 'about:blank',
], { stdio: 'ignore' });

async function pageSocket() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('no page');
}

const ws = new WebSocket(await pageSocket());
await new Promise((r) => (ws.onopen = r));
let next = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
function send(method, params = {}) {
  const id = ++next;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))),
  );
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
async function open(path, wait = 3000) {
  await send('Page.navigate', { url: `${BASE}${path}` });
  await sleep(wait);
}
/** Clicks the first visible button or link whose text starts with `text`. */
async function click(text, wait = 1200) {
  const done = await evaluate(`(() => {
    const items = [...document.querySelectorAll('button, a, [role=button], [role=tab], li, tr')];
    const el = items.find((e) => e.offsetParent !== null && e.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!done) throw new Error(`no element "${text}"`);
  await sleep(wait);
}
/* One sample café in every shot: the previews name their fixture organisations differently. */
const SAME_NAMES = `(() => {
  const names = { 'Fixture organisation': 'Nuki Inc.', 'Preview organisation': 'Nuki Inc.', 'Local preview': 'Nuki Inc.', 'Sample bakery': 'Cafe operations' };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (names[text]) node.nodeValue = node.nodeValue.replace(text, names[text]);
  }
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length < 4 && /^Development fixture/.test(el.textContent.trim()) && el.textContent.length < 60) el.style.visibility = 'hidden';
    if (el.children.length === 0 && /^Visual preview · Example data/.test(el.textContent.trim())) el.style.display = 'none';
  }
})()`;
async function shot(name) {
  await evaluate(SAME_NAMES);
  await sleep(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('shot', name);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });

const fixture = readFileSync(join(ROOT, 'scripts/mail-inbox/mount-browser-fixture.js'), 'utf8');
const mount = fixture.slice(fixture.indexOf('async function mount()'), fixture.lastIndexOf('});') + 1);

const VIEWS = {
  async inbox() {
    await open('/theme-preview.html', 2500);
    await evaluate(`window.mailFixtureDrafts = "three"; (${mount})()`);
    await sleep(3000);
    await evaluate(`[...document.querySelectorAll('button.mail-case-row')].find((e) => e.textContent.includes('Peita Lin'))?.click()`);
    await sleep(2500);
    await shot('inbox');
  },
  async activity() {
    await open('/brain-preview.html?view=activity', 9000);
    await shot('activity');
  },
  async orders() {
    await open('/orders-preview.html?frame', 2500);
    await shot('orders');
    await open('/orders-preview.html?frame&order=order_2207', 2500);
    await shot('orders-drawer');
  },
  async kitchen() {
    await open('/workflow-preview.html', 16000);
    await shot('kitchen-floor');
    await click('Production timeline', 2500);
    await shot('kitchen-timeline');
    await click('Production timeline', 1000);
    await click('Details', 2500);
    await shot('kitchen-details');
    await click('Details', 1000);
    await click('Floor plan', 3000);
    await shot('kitchen-plan');
  },
};

try {
  for (const [name, run] of Object.entries(VIEWS)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try { await run(); } catch (error) { console.log('FAILED', name, error.message); }
  }
} finally {
  ws.close();
  chrome.kill();
}
