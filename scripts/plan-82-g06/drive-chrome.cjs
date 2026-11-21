// Plan 82 G0.6: press the test page's buttons in real Chrome on this Mac.
// Headless Chrome refuses the local network permission, so this turns the check off.
// It measures the server and the name. It does not prove the permission prompt.
// Usage: PLAYWRIGHT_MODULE=<path> node drive-chrome.cjs https://<name>:8443 check warm cold bakers hang off
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [mac, ...tests] = process.argv.slice(2);
const PAGE = "https://pantry-voice-path-test.n6378056.workers.dev/?mac=";

(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--disable-features=LocalNetworkAccessChecks"],
  });
  const page = await browser.newPage();
  await page.goto(PAGE + encodeURIComponent(mac));
  for (const test of tests) {
    await page.click(`button[data-test=${test}]`);
    await page.waitForFunction(() => document.querySelector("#out").textContent.length > 0, null, { timeout: 300000 });
    const report = JSON.parse(await page.textContent("#out"));
    console.log(test, JSON.stringify({ ...report.result, failure: report.failure, saved: report.saved }));
    await page.waitForFunction(() => !document.querySelector("button").disabled);
    await page.evaluate(() => {
      document.querySelector("#out").textContent = "";
    });
  }
  await browser.close();
})();
