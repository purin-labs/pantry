// Drives the Plan 82C recorder through one whole session with a macOS voice, so that the recorder,
// its clips and the bench on them are proved before a person records (Plan 82C Phase 3). The voice is
// synthetic and the room is silent: the numbers of this session say nothing about real voices.
//
//   PLAYWRIGHT_MODULE=<playwright> node scripts/shop-voice/recorder-proof.cjs [recorder URL]
//
// It prints the session's name. Then: phrase-bench.py human .cache/human/<session>
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const { fakeMicrophone, play, speech } = require("./fake-microphone.cjs");

const PAGE = process.argv[2] ?? "http://127.0.0.1:3185/voice-recorder.html";
const VOICE = process.env.SHOP_VOICE_VOICE ?? "Moira";
// The wake phrase as the Portal journey says it to the wake model.
const WAKE = speech("Tessa", "hey, sayter");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript(fakeMicrophone);
  const page = await context.newPage();
  const tally = { prompts: 0, attempts: 0, misses: 0, skipped: 0 };
  try {
    await page.goto(PAGE);
    await page.getByRole("button", { name: "Start" }).click();
    const prompt = page.locator("[data-recorder-prompt]");
    const finished = page.locator("[data-recorder-session]");
    await prompt.or(finished).waitFor({ timeout: 180_000 });
    while ((await finished.count()) === 0) {
      const index = await prompt.getAttribute("data-recorder-prompt");
      const set = await prompt.getAttribute("data-recorder-set");
      const spoken = await prompt.getAttribute("data-recorder-spoken");
      const moved = async (ms) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          if ((await finished.count()) > 0) return true;
          if ((await prompt.getAttribute("data-recorder-prompt")) !== index)
            return true;
          if ((await page.locator(".voice-recorder-note").count()) > 0)
            return false;
          await sleep(150);
        }
        return false;
      };
      tally.prompts += 1;
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
        tally.attempts += 1;
        if (set === "room") {
          await page.keyboard.press("Space");
          done = await moved(45_000);
        } else if (set === "far") {
          await page.evaluate(play, WAKE);
          await page
            .getByText("Listening…")
            .waitFor({ timeout: 4_000 })
            .catch(() => undefined);
          await page.evaluate(play, speech(VOICE, spoken));
          done = await moved(15_000);
        } else {
          await page.keyboard.down("Space");
          await sleep(250);
          await page.evaluate(play, speech(VOICE, spoken));
          await sleep(300);
          await page.keyboard.up("Space");
          done = await moved(15_000);
        }
        if (!done) tally.misses += 1;
      }
      if (!done && set === "far") {
        await page.getByRole("button", { name: "Skip this one" }).click();
        tally.skipped += 1;
        await moved(5_000);
      } else if (!done)
        throw new Error(`Prompt ${index} (${set}) was not recorded.`);
    }
    const session = await finished.textContent();
    console.log(JSON.stringify({ session, ...tally }));
  } catch (error) {
    await page
      .screenshot({ path: "recorder-proof-failure.png" })
      .catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
