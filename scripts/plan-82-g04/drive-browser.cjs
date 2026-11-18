// Plan 82 G0.4: serve browser.html and its files, and run the wake phrase in Chrome on this Mac.
// Usage: PLAYWRIGHT_MODULE=<path> node drive-browser.cjs <models folder> <stream.pcm>
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [models, stream] = process.argv.slice(2);

function resolve(url) {
  const name = url.split("?")[0];
  if (name === "/") return path.join(__dirname, "browser.html");
  if (name === "/stream.pcm") return stream;
  if (name.startsWith("/models/")) return path.join(models, path.basename(name));
  return null;
}

const server = http.createServer((request, response) => {
  const file = resolve(request.url);
  if (!file || !fs.existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
});

server.listen(0, "127.0.0.1", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector("#out").textContent.length > 0, null, { timeout: 300000 });
  console.log(await page.textContent("#out"));
  await browser.close();
  server.close();
});
