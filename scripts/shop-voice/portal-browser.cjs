// The browser half of run-portal-journey.py (Plan 82 Phase 2). It acts as a manager and a baker in
// real Chrome, whose microphone input plays the journey's speech file. It checks what a person sees.
const { execSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const {
  fakeMicrophone,
  play: window_play,
  speech,
} = require("./fake-microphone.cjs");
const { sleep } = require("../../packages/std/src/index.ts");
const { chooseOption } = require("../lib/browser-journey.mjs");

const input = JSON.parse(process.argv[2]);
const results = { steps: [] };
// The Mac's speech engine for the scenes (Plan 82C Phase 2). A manager chooses it in the dialog after
// the install. The labels are the catalogue's (packages/control-api/src/voice-engines.ts).
const WHISPER = "whisper-large-v3-turbo";
const ENGINE_LABELS = {
  [WHISPER]: "Whisper large-v3-turbo",
  "qwen3-asr-1.7b": "Qwen3-ASR 1.7B",
};
const ENGINE = input.engine ?? WHISPER;
const ON_MAC = `Spoken command, transcribed on the shop Mac by ${ENGINE_LABELS[ENGINE]}`;

function step(name, facts = {}) {
  results.steps.push({ step: name, ...facts });
  console.log(`PASS ${name} ${JSON.stringify(facts)}`);
}
function require_(condition, message) {
  if (!condition) throw new Error(message);
}
async function waitFor(what, check, ms, every = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await sleep(every);
  }
}

function macPid() {
  const out = execSync(
    `lsof -nP -iTCP:${input.macPort} -sTCP:LISTEN -t || true`,
  )
    .toString()
    .trim();
  return out === "" ? null : Number(out.split("\n")[0]);
}

/**
 * The card's phrase is random, so this journey cannot use a fixed microphone file. The page's
 * microphone stream here plays the speech that the journey makes after it reads the phrase.
 * The worklet, the wake phrase model, the Mac, Whisper and the Platform are the same.
 */
/** The Mac's voice plays at the device's own rate. The capture and `__play` run at 16 kHz. */
function recordMacVoice() {
  window.__macVoice = [];
  let text = "";
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    if (String(url).endsWith("/speech")) text = JSON.parse(init.body).text;
    return realFetch(url, init);
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    if (this.context.sampleRate !== 16000) {
      window.__spoken.push(text);
      window.__macVoice.push({ text, seconds: this.buffer.duration });
    }
    return start.apply(this, args);
  };
}

/** Café talk: several voices at once and reversed, so that it holds no words. A WAV file in base64. */
function babble() {
  const lines = [
    [
      "Samantha",
      "The morning bake went well and the second oven needs a new seal before the weekend rush starts.",
    ],
    [
      "Daniel",
      "We should order more butter and flour this week because the wholesale customers asked for extra trays.",
    ],
    [
      "Karen",
      "Could you check the delivery list and call the supplier about the price of the ribbon and the boxes.",
    ],
    [
      "Moira",
      "The espresso machine is making a strange sound again and somebody has to look at it this afternoon.",
    ],
    [
      "Rishi",
      "Two customers asked about the pistachio cakes and I told them that a new batch comes out at noon.",
    ],
    [
      "Tessa",
      "Please wipe the counter and restock the display case before the next group arrives from the station.",
    ],
  ];
  const voices = lines.map(([voice, text]) => {
    const wav = Buffer.from(speech(voice, text), "base64");
    const at = wav.indexOf("data") + 8;
    const samples = new Int16Array(
      wav.buffer.slice(
        wav.byteOffset + at,
        wav.byteOffset + wav.length - ((wav.length - at) % 2),
      ),
    );
    return samples.reverse();
  });
  const length = Math.min(...voices.map((voice) => voice.length));
  const pcm = Buffer.alloc(length * 2);
  for (let index = 0; index < length; index += 1) {
    const sum = voices.reduce((total, voice) => total + voice[index], 0);
    pcm.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(sum / 2))),
      index * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

async function speakingPage(browser, input) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ["microphone"],
    viewport: { width: 1280, height: 860 },
  });
  await context.addCookies(
    input.cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return {
        name: pair.slice(0, at),
        value: pair.slice(at + 1),
        domain: "127.0.0.1",
        path: "/",
      };
    }),
  );
  await context.addInitScript(() => {
    window.__spoken = [];
    // The first tap's silent utterance only unlocks speech.
    speechSynthesis.speak = (utterance) => {
      if (utterance.text.trim() !== "") window.__spoken.push(utterance.text);
    };
  });
  await context.addInitScript(fakeMicrophone);
  await context.addInitScript(recordMacVoice);
  await context.addInitScript(() => {
    window.__tones = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      window.__tones.push(this.frequency.value);
      return start.apply(this, args);
    };
  });
  const page = await context.newPage();
  const spoken = () => page.evaluate(() => window.__spoken);
  const say = async (words) => {
    await page.evaluate(window_play, speech("Tessa", "hey, sayter"));
    await sleep(250);
    await page.evaluate(window_play, speech("Samantha", words));
  };
  const sayAndHear = async (words, sentence) => {
    const before = (await spoken()).length;
    await say(words);
    await waitFor(
      `"${sentence}" after "${words}"`,
      async () =>
        (await spoken()).slice(before).some((text) => text.includes(sentence)),
      30_000,
    );
  };
  /** The real key press, and the words as the microphone hears them. No wake phrase. */
  const holdAndSay = async (words, voice = "Samantha") => {
    await page.keyboard.down("AltRight");
    await page.evaluate(window_play, speech(voice, words));
    await page.keyboard.up("AltRight");
  };
  const holdSayAndHear = async (words, sentence) => {
    const before = (await spoken()).length;
    await holdAndSay(words);
    await waitFor(
      `"${sentence}" after a hold with "${words}"`,
      async () =>
        (await spoken()).slice(before).some((text) => text.includes(sentence)),
      30_000,
    );
  };
  return { context, page, spoken, say, sayAndHear, holdAndSay, holdSayAndHear };
}

/**
 * Hold-to-talk with the real key path: Chrome's input events, the session, the worker's speech
 * detection, the Mac and Whisper. The microphone stream plays macOS speech, as in the scenes above.
 */
async function holdToTalk(browser, input, chatUrl) {
  const { context, page, holdAndSay } = await speakingPage(browser, input);
  const audio = [];
  context.on("request", (request) => {
    const url = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (url === "/transcriptions" || url.endsWith("/voice/transcriptions"))
    )
      audio.push(url);
  });
  const tones = () => page.evaluate(() => window.__tones);
  const clearTones = () => page.evaluate(() => (window.__tones = []));
  const status = () =>
    page
      .locator(".voice-status")
      .textContent({ timeout: 500 })
      .catch(() => "");
  const messages = page.locator('article[aria-label="You"]');
  const ready = () =>
    waitFor(
      "listening again",
      async () => (await status()).includes("Hey Satyr"),
      20_000,
    );
  try {
    await page.goto(chatUrl);
    await page.waitForSelector("#chat-message", { timeout: 60_000 });
    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    await page.getByRole("button", { name: "Turn on" }).click();
    await waitFor(
      "the shop Mac path",
      async () =>
        (await status()).includes("hold Right Option") &&
        (await page.locator(".voice-cloud").count()) === 0,
      60_000,
    );

    await page.keyboard.down("AltRight");
    await sleep(60);
    await page.keyboard.up("AltRight");
    await sleep(600);
    require_(
      (await tones()).length === 0 && audio.length === 0,
      `A slip of the finger: ${JSON.stringify(await tones())}`,
    );
    step("a short tap of the key makes no sound and sends nothing");

    await page.keyboard.down("AltRight");
    const holding = waitFor(
      "the hold status",
      async () => (await status()).includes("Release to send"),
      5_000,
      50,
    );
    await page.evaluate(
      window_play,
      speech("Samantha", "Label the second tray."),
    );
    await holding;
    await page.screenshot({
      path: path.join(input.artifacts, "portal-hold.png"),
    });
    await page.keyboard.up("AltRight");
    const first = messages.filter({ hasText: "second tray" });
    await first.waitFor({ timeout: 30_000 });
    require_(
      (await first.getByRole("img", { name: ON_MAC }).count()) === 1,
      "The held command has no microphone mark with its engine.",
    );
    require_(
      /tray/iu.test(await first.textContent()) &&
        audio.length === 1 &&
        audio[0] === "/transcriptions",
      `audio: ${JSON.stringify(audio)}`,
    );
    const firstTones = await tones();
    require_(
      firstTones.join() === "880,660",
      `tones: ${JSON.stringify(firstTones)}`,
    );
    step("a held key sends the command with no wake phrase, to the last word", {
      text: await first.locator("p").first().textContent(),
    });

    await ready();
    await clearTones();
    await page.keyboard.down("AltRight");
    await sleep(1200);
    await page.keyboard.up("AltRight");
    await waitFor(
      "the two low tones",
      async () => (await tones()).join() === "880,440,440",
      5_000,
      100,
    );
    await ready();
    require_(audio.length === 1, "A silent hold sent audio.");
    step("a hold with no speech gives two low tones and sends no audio");

    // Words that a person says for a shortcut or for a character such as é stay here.
    await clearTones();
    await page.keyboard.down("AltRight");
    await sleep(400);
    await page.keyboard.press("KeyE");
    await page.evaluate(
      window_play,
      speech("Samantha", "Throw away the butter."),
    );
    await page.keyboard.up("AltRight");
    await sleep(1500);
    require_(audio.length === 1, "A key chord sent audio.");
    require_(
      (await tones()).join() === "880,440,440",
      `chord tones: ${JSON.stringify(await tones())}`,
    );
    await ready();
    step("another key during a hold gives up the command, and its audio stays");

    await page.keyboard.down("AltRight");
    await sleep(300);
    const away = page.evaluate(
      window_play,
      speech("Samantha", "Throw away the butter."),
    );
    await sleep(300);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await away;
    await page.keyboard.up("AltRight");
    await sleep(1500);
    require_(audio.length === 1, "A hold that lost the window sent audio.");
    await ready();
    step("a hold ends with nothing sent when the page loses focus");

    // Past the limit, the command goes while the key is still down, and it goes once.
    const long = page.evaluate(
      window_play,
      speech(
        "Samantha",
        "Wipe the counter, sweep the floor, fill the sugar jars, count the boxes, wash the mixing bowls, sharpen the knives, stack the crates, print the labels, restock the ribbon, check the walk in fridge, clean the display case, empty the bins, and write the delivery list for tomorrow morning, then call the milk supplier about the next order and ask about the price.",
      ),
    );
    await page.keyboard.down("AltRight");
    const limited = messages.filter({ hasText: "sugar jars" });
    await limited.waitFor({ timeout: 40_000 });
    require_(audio.length === 2, `limit audio: ${audio.length}`);
    await long;
    await sleep(1000);
    await page.keyboard.up("AltRight");
    await sleep(1500);
    require_(
      audio.length === 2 && (await limited.count()) === 1,
      "The rest of a long hold became a second command.",
    );
    step("a hold past 15 s sends one command that the Mac accepts", {
      text: await limited.locator("p").first().textContent(),
    });

    await ready();
    await holdAndSay("Count the spoons.");
    await messages.filter({ hasText: "spoons" }).waitFor({ timeout: 30_000 });
    require_(audio.length === 3, `next hold audio: ${audio.length}`);
    step("the key works again after the limit");

    await ready();
    const fnKey = (type) =>
      page.evaluate(
        (name) =>
          window.dispatchEvent(
            new KeyboardEvent(name, { code: "Fn", key: "Fn" }),
          ),
        type,
      );
    await fnKey("keydown");
    await page.evaluate(window_play, speech("Samantha", "Count the napkins."));
    await fnKey("keyup");
    await messages.filter({ hasText: "napkins" }).waitFor({ timeout: 30_000 });
    step(
      "a browser that reports Fn gets the same hold (a page event, not a real key)",
    );

    // Café talk on a held key: the Mac's own values stop it, and it never reaches the agent.
    await ready();
    const audioBeforeTalk = audio.length;
    const messagesBeforeTalk = await messages.count();
    await clearTones();
    await page.keyboard.down("AltRight");
    await page.evaluate(window_play, babble());
    await page.keyboard.up("AltRight");
    await waitFor(
      "the Mac to refuse the talk",
      async () => (await tones()).join() === "880,660,440,440",
      20_000,
      100,
    );
    await ready();
    require_(
      audio.length === audioBeforeTalk + 1 &&
        (await messages.count()) === messagesBeforeTalk,
      `Café talk became a command: ${JSON.stringify(await messages.allTextContents())}`,
    );
    step("café talk on a held key reaches the Mac and becomes no command");

    // The model sends one sentence and then works on. The person hears it during that wait.
    await ready();
    const heard = () => page.evaluate(() => window.__spoken);
    const sentence = "The flour count is twelve bags.";
    const heardBefore = (await heard()).length;
    const streaming = page.locator(".chat-streaming");
    await holdAndSay("Count the flour.");
    await waitFor(
      "the first sentence",
      async () =>
        (await heard()).slice(heardBefore).join(" ").includes(sentence),
      10_000,
      100,
    );
    const openOnScreen = await streaming.textContent({ timeout: 2_000 });
    require_(
      !openOnScreen.includes("sugar"),
      `The whole answer had arrived: ${openOnScreen}`,
    );
    const firstHeardAt = Date.now();
    await waitFor(
      "the rest of the answer",
      async () =>
        (await heard())
          .slice(heardBefore)
          .join(" ")
          .endsWith("More on screen."),
      30_000,
      100,
    );
    const whole = (await heard()).slice(heardBefore).join(" ");
    require_(
      // The answer to the command before this one can still play just before it.
      whole.endsWith(`${sentence} The sugar is low. More on screen.`) &&
        whole.split(sentence).length === 2,
      `The answer as heard: ${whole}`,
    );
    step(
      "the first sentence is heard while the agent still works, and nothing repeats",
      {
        earlierByMs: Date.now() - firstHeardAt,
        heard: whole,
      },
    );

    // "Cancel" during the wait: the rest of this answer is not spoken.
    await ready();
    const heardAtCancel = (await heard()).length;
    await holdAndSay("Count the flour.");
    await waitFor(
      "the first sentence again",
      async () =>
        (await heard()).slice(heardAtCancel).join(" ").includes(sentence),
      10_000,
      100,
    );
    // An engine can write this voice's "Cancel" as another word, such as Whisper's "pencil".
    const messagesBeforeCancel = await messages.count();
    const heardAsCancel = [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname === "/transcriptions")
        heardAsCancel.push((await response.json()).text);
    });
    await holdAndSay("Cancel.", "Karen");
    await sleep(16_000);
    require_(
      (await messages.count()) === messagesBeforeCancel,
      `"Cancel" became a message: ${JSON.stringify(heardAsCancel)}`,
    );
    require_(
      (await heard()).slice(heardAtCancel).join(" ") === sentence,
      `After cancel: ${JSON.stringify((await heard()).slice(heardAtCancel))}`,
    );
    step("cancel during the wait leaves the rest of the answer unspoken", {
      macWrote: heardAsCancel,
    });

    // On noise, an engine reads the shop's names back as a list. The Mac's engine writes this
    // list as it hears it, and the Portal's text check drops it on the Mac's path too (Plan 82C D1).
    await ready();
    const readCounts = () =>
      page.evaluate(
        () =>
          Object.values(
            JSON.parse(localStorage.getItem("satyr.voice.counts")),
          )[0],
      );
    const countsBeforeList = await readCounts();
    const messagesBeforeList = await messages.count();
    const heardAsList = [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname === "/transcriptions")
        heardAsList.push((await response.json()).text);
    });
    await holdAndSay("Kouign-amann, financier, canelé.");
    // The device counts what each host and engine heard (Plan 82C Phase 3).
    const onMac = (counts) =>
      counts?.heardBy?.[`shop_mac:${ENGINE}`] ?? { commands: 0, noise: 0 };
    await waitFor(
      "the list to be dropped",
      async () =>
        onMac(await readCounts()).noise > onMac(countsBeforeList).noise,
      30_000,
    );
    await sleep(3_000);
    require_(
      heardAsList.some((text) => text.split(",").length >= 3),
      `The Mac did not write a list: ${JSON.stringify(heardAsList)}`,
    );
    require_(
      (await messages.count()) === messagesBeforeList,
      `The list became a message: ${JSON.stringify(heardAsList)}`,
    );
    step(
      "the shop's names read back as a list stay out of the chat on the Mac's path",
      {
        macWrote: heardAsList,
      },
    );

    // A sound close to the wake phrase, as often as needed for one near wake.
    await ready();
    const beforeNear = await readCounts();
    // The model's score moves with the audio's position in a chunk, so the same phrase can
    // be a wake or a near wake. This phrase scored 0.91 to 1.00 on the real wake models.
    await waitFor(
      "a near wake",
      async () => {
        await page.evaluate(window_play, speech("Samantha", "hey, sailor"));
        await sleep(2600);
        await ready();
        return (await readCounts()).nearWakes > beforeNear.nearWakes;
      },
      120_000,
      0,
    );
    const afterNear = await readCounts();
    step("the device counts wakes, near wakes and holds with no audio", {
      before: beforeNear,
      after: afterNear,
    });
    require_(
      afterNear.holds >= 5 &&
        onMac(afterNear).noise >= 1 &&
        onMac(afterNear).commands >= 1,
      `counts: ${JSON.stringify(afterNear)}`,
    );

    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    const dayNote = await page
      .locator("[data-voice-day-note]")
      .textContent({ timeout: 5_000 });
    require_(
      dayNote.includes(`key holds ${afterNear.holds}`),
      `day note: ${dayNote}`,
    );
    const weekNote = await page
      .locator("[data-voice-week-note]")
      .textContent({ timeout: 5_000 });
    const macCounts = onMac(afterNear);
    require_(
      weekNote.includes(
        `${ENGINE_LABELS[ENGINE]} on the shop Mac: ${macCounts.commands} commands, ${macCounts.noise} dropped as noise`,
      ),
      `week note: ${weekNote}`,
    );
    step("the dialog shows what each engine heard in the last 7 days", {
      weekNote,
    });
    await page.getByRole("button", { name: "Turn off" }).click();
    const audioWhileOn = audio.length;
    await page.keyboard.down("AltRight");
    await sleep(400);
    await page.keyboard.up("AltRight");
    require_(
      audio.length === audioWhileOn &&
        (await page.locator(".voice-status").count()) === 0,
      "The key did something with voice control off.",
    );
    step("the key does nothing while voice control is off");
  } catch (error) {
    await page
      .screenshot({
        path: path.join(input.artifacts, "portal-hold-failure.png"),
      })
      .catch(() => undefined);
    results.hold = {
      audio,
      status: await status(),
      tones: await tones().catch(() => null),
      messages: await messages.allTextContents().catch(() => null),
    };
    throw error;
  } finally {
    await context.close();
  }
}

async function spokenApproval(browser, input, chatUrl) {
  const { context, page, spoken, sayAndHear, say } = await speakingPage(
    browser,
    input,
  );
  try {
    await page.goto(chatUrl);
    await page.waitForSelector("#chat-message", { timeout: 60_000 });
    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    // The owner lets the agent stage a change, as the Access page does.
    const enabled = await page.evaluate(
      async ({ organisationId, csrf }) => {
        const base = `/v1/control/organisations/${organisationId}/access-control`;
        const view = (await (await fetch(base)).json()).accessControl;
        const capability = view.capabilities.find(
          (candidate) =>
            candidate.definition?.capabilityId === "commerce.action.propose",
        );
        if (capability.mode === "enabled") return 200;
        const changed = await fetch(
          `${base}/capabilities/commerce.action.propose`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-satyr-csrf": csrf,
              "idempotency-key": crypto.randomUUID(),
            },
            body: JSON.stringify({
              expectedRevision: view.revision,
              capabilityRevision: capability.revision,
              capabilityVersion: 1,
              mode: "enabled",
            }),
          },
        );
        return changed.status;
      },
      { organisationId: input.organisationId, csrf: input.csrf },
    );
    require_(enabled === 200, `The proposal capability: ${enabled}`);
    await page.getByRole("button", { name: "Turn on" }).click();
    await waitFor(
      "listening",
      async () =>
        (
          await page
            .locator(".voice-status")
            .textContent()
            .catch(() => "")
        ).includes("Hey Satyr"),
      60_000,
    );
    await waitFor(
      "the shop Mac path",
      async () => (await page.locator(".voice-cloud").count()) === 0,
      40_000,
    );

    await say("Create a new area for pastry.");
    const line = page.locator(".voice-approval-line strong");
    await line.waitFor({ timeout: 60_000 });
    const phrase = await line.textContent();
    require_(
      /^confirm change (three|five|six|seven|nine) (three|five|six|seven|nine) (three|five|six|seven|nine)$/u.test(
        phrase,
      ),
      `phrase: ${phrase}`,
    );
    await waitFor(
      "the spoken phrase",
      async () => (await spoken()).some((text) => text.includes(phrase)),
      40_000,
    );
    const heard = await spoken();
    require_(
      heard.findIndex((text) => text.includes("confirm it")) <
        heard.findIndex((text) => text.includes(phrase)),
      `order: ${JSON.stringify(heard)}`,
    );
    await page.screenshot({
      path: path.join(input.artifacts, "portal-approval.png"),
    });
    step("an approval card shows and speaks a phrase after the answer", {
      phrase,
    });

    const status = page.locator(".draft-message-status");
    const pending = await status.textContent();
    const messages = page.locator('article[aria-label="You"]');
    const messageCount = await messages.count();
    await sayAndHear(`do not ${phrase}`, "did not match");
    const words = phrase.split(" ");
    const last = words[words.length - 1] === "nine" ? "three" : "nine";
    await sayAndHear([...words.slice(0, -1), last].join(" "), "did not match");
    await sayAndHear(
      `hold change ${words.slice(2).join(" ")}`,
      "did not match",
    );
    await sayAndHear(
      `${words.slice(0, 2).join(" ")} ${words[2]} ${words[4]}`,
      "did not match",
    );
    require_(
      (await status.textContent()) === pending,
      "A near miss changed the card.",
    );
    require_(
      (await messages.count()) === messageCount,
      "A near miss went to the agent.",
    );
    step(
      "a negation, other digits, another word or a missing digit refuses, and the card stays open",
    );

    await sayAndHear(phrase, "Done.");
    await waitFor(
      "the card to settle",
      async () => (await status.textContent()) !== pending,
      20_000,
    );
    require_(
      (await page.locator(".voice-approval-line").count()) === 0,
      "The phrase stayed after the approval.",
    );
    const settled = await status.textContent();
    const conversationId = new URL(page.url()).searchParams.get("conversation");
    const receipts = await page.evaluate(
      ({ organisationId, conversationId }) =>
        fetch(
          `/v1/control/organisations/${organisationId}/voice/confirmations?conversationId=${conversationId}`,
        ).then((response) => response.json()),
      { organisationId: input.organisationId, conversationId },
    );
    require_(
      receipts.receipts.length === 1 &&
        receipts.receipts[0].phrase === phrase &&
        receipts.receipts[0].transcriptionPath === "shop_mac",
      `receipts: ${JSON.stringify(receipts)}`,
    );
    await page.screenshot({
      path: path.join(input.artifacts, "portal-approved.png"),
    });
    step(
      "the exact phrase runs the card's own confirmation and records a receipt",
      { status: settled, receipt: receipts.receipts[0] },
    );

    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    await page.getByRole("button", { name: "Turn off" }).click();
  } catch (error) {
    await page
      .screenshot({
        path: path.join(input.artifacts, "portal-approval-failure.png"),
      })
      .catch(() => undefined);
    results.approval = {
      spoken: await spoken().catch(() => null),
      status: await page
        .locator(".voice-status")
        .textContent({ timeout: 500 })
        .catch(() => null),
      messages: await page
        .locator('article[aria-label="You"]')
        .allTextContents()
        .catch(() => null),
      permission: await page
        .locator("dialog[open]")
        .allTextContents()
        .catch(() => null),
    };
    throw error;
  } finally {
    await context.close();
  }
}

/**
 * The Slack and email cards. A Slack workspace and a mailbox need their own providers, so this
 * page's draft routes are stand-ins that record each call and answer. The real chat, cards,
 * wake phrase model, Mac, Whisper and the Platform's phrase check run.
 */
async function spokenDrafts(browser, input, chatUrl) {
  const { context, page, spoken, say, sayAndHear, holdSayAndHear } =
    await speakingPage(browser, input);
  const digest = "a".repeat(64);
  const slack = {
    proposalId: "draft_slack_voice",
    version: 1,
    workspaceName: "Satyr Kitchen",
    channelId: null,
    channelName: null,
    channelHint: "general",
    body: "The financiers are ready.",
    bodyDigest: digest,
    lifecycle: "awaiting_approval",
    failureMessage: null,
    createdAt: Date.now(),
  };
  const emailId = "draft_email_voice";
  const target = { kind: "self_test", selfTestId: "self_test_voice" };
  const email = {
    kind: "operational_new_message",
    proposal_id: emailId,
    integration_account_id: "integration_voice",
    case_id: "case_voice",
    version: 1,
    lifecycle_kind: "awaiting_approval",
    created_at: Date.now(),
    updated_at: Date.now(),
    backing: {
      kind: "encrypted_connector",
      target,
      snapshot_digest: digest,
      indeterminate_rfc_message_id: null,
    },
  };
  const slackSends = [];
  const emailSends = [];
  await context.route(
    /\/organisations\/[^/]+\/chat(\?.*)?$/u,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({
        response,
        json: {
          ...body,
          slackDrafts: [slack],
          emailReviews: [...body.emailReviews, email],
        },
      });
    },
  );
  await context.route(/\/slack-messages\/draft_slack_voice/u, async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({
        json: {
          ok: true,
          draft: slack,
          channels: [{ channelId: "C_PRODUCTION", name: "production" }],
        },
      });
    slackSends.push(request.postDataJSON());
    // The first send fails, as Slack can.
    if (slackSends.length === 1)
      return route.fulfill({ status: 502, json: { ok: false } });
    slack.lifecycle = "sent";
    slack.channelId = slackSends.at(-1).channelId;
    return route.fulfill({ json: { ok: true, draft: slack } });
  });
  await context.route(
    /\/email-operational\/draft_email_voice/u,
    async (route) => {
      const request = route.request();
      if (request.method() === "GET")
        return route.fulfill({
          json: {
            ok: true,
            kind: "current",
            challenge: "challenge_voice",
            proposal: {
              proposal_id: emailId,
              version: 1,
              case_id: "case_voice",
              integration_account_id: "integration_voice",
              target,
              from: "shop@example.test",
              to: "owner@example.test",
              recipient_display_name: null,
              subject: "Today's test",
              body: "This is a test message.",
              target_digest: digest,
              snapshot_digest: digest,
              expires_at: Date.now() + 3_600_000,
            },
          },
        });
      emailSends.push(request.postDataJSON());
      email.lifecycle_kind = "sent";
      return route.fulfill({ json: { ok: true } });
    },
  );

  const phraseOf = (word) =>
    page
      .locator(".voice-approval-line strong", { hasText: `send ${word} ` })
      .textContent({ timeout: 500 })
      .catch(() => null);
  const newPhrase = (word, old) =>
    waitFor(
      `a new ${word} phrase`,
      async () => {
        const phrase = await phraseOf(word);
        return phrase !== null && phrase !== old ? phrase : null;
      },
      20_000,
    );
  try {
    await page.goto(chatUrl);
    await page.waitForSelector("#chat-message", { timeout: 60_000 });
    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    await page.getByRole("button", { name: "Turn on" }).click();
    await waitFor(
      "the shop Mac path",
      async () =>
        (
          await page
            .locator(".voice-status")
            .textContent()
            .catch(() => "")
        )?.includes("Hey Satyr") &&
        (await page.locator(".voice-cloud").count()) === 0,
      60_000,
    );
    await say("Label the second tray.");
    const message = page.locator('article[aria-label="You"]', {
      hasText: "Label the second tray",
    });
    await message.waitFor({ timeout: 60_000 });
    const firstSlack = await newPhrase("message", null);
    const firstEmail = await newPhrase("email", null);
    require_(
      /^send message( (three|five|six|seven|nine)){3}$/u.test(firstSlack) &&
        /^send email( (three|five|six|seven|nine)){3}$/u.test(firstEmail),
      `phrases: ${firstSlack}, ${firstEmail}`,
    );
    await page.screenshot({
      path: path.join(input.artifacts, "portal-draft-cards.png"),
    });
    await waitFor(
      "both spoken phrases",
      async () => {
        const heard = await spoken();
        return (
          heard.some((text) => text.includes(firstSlack)) &&
          heard.some((text) => text.includes(firstEmail))
        );
      },
      60_000,
    );
    step("the Slack and email cards each show and speak their own phrase", {
      slack: firstSlack,
      email: firstEmail,
    });

    await sayAndHear(firstSlack, "Choose a channel first");
    require_(slackSends.length === 0, "A send ran with no channel.");
    const secondSlack = await newPhrase("message", firstSlack);
    step("a Slack card with no channel asks for one and gets a new phrase");

    await chooseOption(page, page.getByLabel("Channel"), {
      value: "C_PRODUCTION",
    });
    const words = secondSlack.split(" ");
    const last = words.at(-1) === "nine" ? "three" : "nine";
    await sayAndHear([...words.slice(0, -1), last].join(" "), "did not match");
    require_(slackSends.length === 0, "A near miss sent the Slack message.");
    await sayAndHear(secondSlack, "did not work");
    require_(slackSends.length === 1, "The send did not run.");
    const thirdSlack = await newPhrase("message", secondSlack);
    step("a failed send keeps the card open and gives a new phrase");

    await sayAndHear(thirdSlack, "Done.");
    require_(
      slackSends.length === 2 &&
        slackSends[1].channelId === "C_PRODUCTION" &&
        slackSends[1].bodyDigest === digest &&
        slackSends[1].version === 1,
      `sends: ${JSON.stringify(slackSends)}`,
    );
    await waitFor(
      "the Slack phrase to end",
      async () => (await phraseOf("message")) === null,
      20_000,
    );
    require_(emailSends.length === 0, "The Slack phrase sent the email.");
    step("the exact phrase sends the Slack message to the chosen channel", {
      channelId: slackSends[1].channelId,
    });

    // A phrase on a held key has the same effect as a phrase after the wake phrase.
    await holdSayAndHear(firstEmail, "Done.");
    require_(
      emailSends.length === 1 &&
        emailSends[0].challenge === "challenge_voice" &&
        emailSends[0].snapshotDigest === digest,
      `sends: ${JSON.stringify(emailSends)}`,
    );
    await waitFor(
      "the email phrase to end",
      async () => (await phraseOf("email")) === null,
      20_000,
    );
    const conversationId = new URL(page.url()).searchParams.get("conversation");
    const receipts = await page.evaluate(
      ({ organisationId, conversationId }) =>
        fetch(
          `/v1/control/organisations/${organisationId}/voice/confirmations?conversationId=${conversationId}`,
        ).then((response) => response.json()),
      { organisationId: input.organisationId, conversationId },
    );
    const kinds = receipts.receipts.map((receipt) => receipt.target.kind);
    require_(
      kinds.filter((kind) => kind === "slack_draft").length === 3 &&
        kinds.filter((kind) => kind === "email_draft").length === 1 &&
        receipts.receipts.every(
          (receipt) => receipt.transcriptionPath === "shop_mac",
        ),
      `receipts: ${JSON.stringify(receipts)}`,
    );
    require_(
      (await page.locator('article[aria-label="You"]').count()) === 1,
      "A phrase went to the agent.",
    );
    await page.screenshot({
      path: path.join(input.artifacts, "portal-draft-cards-sent.png"),
    });
    step("the email phrase sends the email, and each card has its receipt", {
      kinds,
    });

    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    await page.getByRole("button", { name: "Turn off" }).click();
  } catch (error) {
    await page
      .screenshot({
        path: path.join(input.artifacts, "portal-drafts-failure.png"),
      })
      .catch(() => undefined);
    results.drafts = {
      spoken: await spoken().catch(() => null),
      slackSends,
      emailSends,
    };
    throw error;
  } finally {
    await context.close();
  }
}

/**
 * Voice stays on while the chat is closed (voice/host.ts). A command spoken on another page
 * opens the chat beside that page and is sent there, and the next command continues that chat.
 */
async function closedChat(browser, input, chatUrl) {
  const { context, page, say } = await speakingPage(browser, input);
  const commands = [];
  context.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/chat") &&
      request.postData() !== null
    ) {
      const body = JSON.parse(request.postData());
      if (body.inputMode !== undefined) commands.push(body);
    }
  });
  const composer = page.locator("#chat-message");
  const mark = page.getByRole("button", {
    name: "Voice control is listening. Open the chat",
  });
  const spokenAfter = async (before, sentence) =>
    waitFor(
      `"${sentence}" spoken`,
      async () =>
        (await page.evaluate(() => window.__spoken))
          .slice(before)
          .some((text) => text.includes(sentence)),
      40_000,
    );
  const closeChat = async () => {
    await page.getByRole("link", { name: "Ask" }).click();
    await composer.waitFor({ state: "detached", timeout: 20_000 });
    await mark.waitFor({ timeout: 20_000 });
  };
  try {
    await page.goto(chatUrl);
    await composer.waitFor({ timeout: 60_000 });
    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    await page.getByRole("button", { name: "Turn on" }).click();
    await waitFor(
      "the shop Mac path",
      async () =>
        (
          await page
            .locator(".voice-status")
            .textContent({ timeout: 500 })
            .catch(() => "")
        ).includes("hold Right Option"),
      60_000,
    );
    const closeDialog = page.getByRole("button", {
      name: "Close voice control",
    });
    if (await closeDialog.isVisible()) await closeDialog.click();

    await closeChat();
    // The person moves to another page with the chat closed. A command then
    // opens the chat beside that page and carries it (Plan 87).
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    await page.waitForURL(/\/knowledge/u, { timeout: 20_000 });
    await mark.waitFor({ timeout: 20_000 });
    const pagePath = new URL(page.url()).pathname;
    require_(!pagePath.endsWith("/chat"), `still on the chat: ${pagePath}`);
    await page.screenshot({
      path: path.join(input.artifacts, "portal-closed-chat-mark.png"),
    });
    step("with the chat closed, the page shows that voice still listens", {
      page: pagePath,
    });

    let before = (await page.evaluate(() => window.__spoken)).length;
    await say("Label the second tray.");
    await composer.waitFor({ timeout: 40_000 });
    await page
      .locator('article[aria-label="You"]', { hasText: "second tray" })
      .waitFor({ timeout: 40_000 });
    await spokenAfter(before, "Two trays are in the second oven");
    const opened = await page.evaluate(() => ({
      path: location.pathname,
      returnPath: history.state?.usr?.chatReturnPath ?? null,
    }));
    require_(
      opened.path.endsWith("/chat") && opened.returnPath?.startsWith(pagePath),
      `The chat did not open beside the page: ${JSON.stringify(opened)}`,
    );
    require_(commands.length === 1, `commands: ${commands.length}`);
    await page.screenshot({
      path: path.join(input.artifacts, "portal-closed-chat-opened.png"),
    });
    step(
      "a command on a closed chat opens the chat beside the page, and its answer is spoken",
      {
        text: commands[0].text,
        beside: opened.returnPath,
      },
    );

    await closeChat();
    before = (await page.evaluate(() => window.__spoken)).length;
    await say("Also check the butter in the walk in fridge.");
    await page
      .locator('article[aria-label="You"]', { hasText: "butter" })
      .waitFor({ timeout: 40_000 });
    await spokenAfter(before, "Two trays are in the second oven");
    require_(
      commands.length === 2 &&
        commands[1].conversationId === commands[0].conversationId,
      `The second command left the chat: ${JSON.stringify(commands.map((c) => c.conversationId))}`,
    );
    require_(
      (await page.locator('article[aria-label="You"]').count()) === 2,
      "The chat does not show both commands.",
    );
    step("the next command on a closed chat continues the same chat", {
      conversationId: commands[1].conversationId,
    });
  } catch (error) {
    await page
      .screenshot({
        path: path.join(input.artifacts, "portal-closed-chat-failure.png"),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${input.microphone}%noloop`,
      `--host-resolver-rules=MAP *.voice.shop-voice.test 127.0.0.1:${input.macPort}`,
      "--disable-features=LocalNetworkAccessChecks",
    ],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ["microphone"],
    viewport: { width: 1280, height: 860 },
  });
  await context.addCookies(
    input.cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return {
        name: pair.slice(0, at),
        value: pair.slice(at + 1),
        domain: "127.0.0.1",
        path: "/",
      };
    }),
  );
  // The device's speech synthesis is recorded here. Headless Chrome has no voices.
  await context.addInitScript(() => {
    window.__spoken = [];
    // The first tap's silent utterance only unlocks speech.
    speechSynthesis.speak = (utterance) => {
      if (utterance.text.trim() !== "") window.__spoken.push(utterance.text);
    };
  });
  await context.addInitScript(recordMacVoice);
  const requests = [];
  const seen = new Set();
  let streamStart = null;
  context.on("request", (request) => {
    const url = request.url();
    if (
      /\.onnx$|\.wasm$|wake-worker|\/transcriptions$|\/voice\/grants$|\/health$|\/chat(\/cancel)?$/u.test(
        new URL(url).pathname,
      )
    )
      requests.push({
        url: new URL(url).pathname,
        host: new URL(url).host,
        method: request.method(),
        body:
          request.method() === "POST" && /\/chat$/u.test(url)
            ? request.postData()
            : null,
      });
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(String(error)));
  const consoleLines = [];
  context.on("console", (line) => {
    if (line.type() === "error" || line.type() === "warning")
      consoleLines.push(line.text().slice(0, 400));
  });
  context.on("weberror", (error) =>
    consoleLines.push(String(error.error()).slice(0, 400)),
  );
  page.on("worker", (worker) => {
    consoleLines.push(`worker: ${worker.url().slice(-60)}`);
    worker.on("close", () => consoleLines.push("worker closed"));
  });
  const shot = (name) =>
    page.screenshot({ path: path.join(input.artifacts, `portal-${name}.png`) });
  try {
    // The production build's worker starts from the Worker's assets and loads its files.
    await page.goto(input.worker);
    const built = await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const worker = new Worker(url, { type: "module" });
          worker.onmessage = (event) => {
            if (event.data.type === "ready" || event.data.type === "failed")
              resolve(event.data.type);
          };
          worker.onerror = () => resolve("error");
        }),
      input.builtWorker,
    );
    require_(built === "ready", `The built worker: ${built}`);
    await page.evaluate(() => caches.delete("satyr-voice-v1"));
    requests.length = 0;
    step(
      "the production build's worker loads its files from the Worker's assets",
    );

    const chatUrl = `${input.platform}/portal/satyr-kitchen-acceptance/cafe-operations/chat`;
    await page.goto(chatUrl);
    await page
      .waitForSelector("#chat-message", { timeout: 60_000 })
      .catch(async (error) => {
        await shot("no-composer");
        console.log(page.url(), (await page.textContent("body")).slice(0, 500));
        throw error;
      });
    const voiceFiles = () =>
      requests.filter((request) =>
        /\.onnx$|\.wasm$|wake-worker/u.test(request.url),
      );
    require_(
      voiceFiles().length === 0,
      `Voice files before opt-in: ${JSON.stringify(voiceFiles())}`,
    );
    step("the Portal loads no voice file before opt-in");

    const api = (method, route, body) =>
      page.evaluate(
        async ({ method, route, body, csrf, organisationId }) => {
          const response = await fetch(
            `/v1/control/organisations/${organisationId}/${route}`,
            {
              method,
              headers:
                method === "GET"
                  ? {}
                  : {
                      "content-type": "application/json",
                      "x-satyr-csrf": csrf,
                      "idempotency-key": crypto.randomUUID(),
                    },
              body: body === undefined ? undefined : JSON.stringify(body),
            },
          );
          return { status: response.status, body: await response.json() };
        },
        {
          method,
          route,
          body,
          csrf: input.csrf,
          organisationId: input.organisationId,
        },
      );

    // A manager adds the Mac from the dialog, and the Mac runs the command that it shows.
    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    const shopMac = () =>
      page.getByRole("button", { name: /^Shop Mac/u }).click();
    await shopMac();
    await page.getByRole("button", { name: "Add a shop Mac" }).click();
    const command = await page.locator(".voice-install code").textContent();
    require_(
      command.startsWith(
        `curl -fsSL ${input.platform}/shop-voice/install.sh | sh -s -- `,
      ),
      `command: ${command}`,
    );
    execSync(
      `${command} ${input.installFlags.map((flag) => `'${flag}'`).join(" ")}`,
      { stdio: "pipe", timeout: 300_000, shell: "/bin/sh" },
    );
    const macs = await waitFor(
      "the Mac to finish its download",
      async () => {
        const { body } = await api("GET", "voice/macs");
        return body.macs[0]?.modelState === "unloaded" ? body.macs : null;
      },
      300_000,
      2000,
    );
    // The dialog shows the enrollment by itself, and the spent command goes.
    await page
      .locator(".voice-mac-row", { hasText: macs[0].hostname })
      .getByText(/Ready|Installed|Does not answer/u)
      .waitFor({ timeout: 30_000 });
    require_(
      (await page.locator(".voice-install code").count()) === 0,
      "The spent command stayed on screen.",
    );
    await shot("manager");
    step("the install command from the dialog enrolls the Mac", {
      hostname: macs[0].hostname,
    });
    if (ENGINE !== WHISPER) {
      // The manager chooses the engine. The Mac keeps Whisper until it has the new files.
      const engineSelect = page
        .locator(".voice-mac-row")
        .getByRole("combobox", { name: "Speech engine" });
      await chooseOption(page, engineSelect, { value: ENGINE });
      await page
        .locator(".voice-mac-row")
        .getByText(`The Mac downloads ${ENGINE_LABELS[ENGINE]}`)
        .waitFor({ timeout: 10_000 });
      await shot("engine-choice");
      await waitFor(
        "the Mac to change engine",
        async () => {
          const { body } = await api("GET", "voice/macs");
          return body.macs[0]?.engine === ENGINE ? true : null;
        },
        600_000,
        2000,
      );
      await page
        .locator(".voice-mac-row")
        .getByText(`Ready with ${ENGINE_LABELS[ENGINE]}`, { exact: true })
        .waitFor({ timeout: 30_000 });
      step("a manager chooses the Mac's speech engine in the dialog", {
        engine: ENGINE,
      });
    }
    await page.getByRole("button", { name: "Back to voice control" }).click();

    // The model loads on a member's check. It takes 16 s the first time, so load it before the scenes.
    const grant = await api("POST", "voice/grants", {
      deviceId: "journeyprewarm0000",
    });
    require_(
      grant.body.mac?.origin === `https://${macs[0].hostname}`,
      `grant: ${JSON.stringify(grant)}`,
    );
    await waitFor(
      "the model load",
      () =>
        page.evaluate(async (mac) => {
          const response = await fetch(`${mac.origin}/health`, {
            headers: { authorization: `Bearer ${mac.grant}` },
          });
          return (await response.json()).modelState === "loaded";
        }, grant.body.mac),
      120_000,
      1000,
    );
    await waitFor(
      "the Mac's voice",
      () =>
        page.evaluate(async (mac) => {
          const response = await fetch(`${mac.origin}/speech`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${mac.grant}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ text: "Ready." }),
          });
          return response.ok;
        }, grant.body.mac),
      300_000,
      2000,
    );

    if (process.env.SHOP_VOICE_APPROVAL_ONLY) {
      const closeDialog = page.getByRole("button", {
        name: "Close voice control",
      });
      if (await closeDialog.isVisible()) await closeDialog.click();
      // SHOP_VOICE_SCENE=closed_chat runs only the scene with the closed chat.
      if (process.env.SHOP_VOICE_SCENE !== "closed_chat") {
        await spokenApproval(browser, input, chatUrl);
        await spokenDrafts(browser, input, chatUrl);
        await holdToTalk(browser, input, chatUrl);
      }
      await closedChat(browser, input, chatUrl);
      results.result = "passed";
      return;
    }

    // The Organisation's off switch raises the access prompt in place. Allow turns voice on.
    const access = (await api("GET", "access-control")).body.accessControl;
    const capability = access.capabilities.find(
      (candidate) =>
        candidate.definition?.capabilityId === "voice.transcription",
    );
    const off = await api(
      "POST",
      "access-control/capabilities/voice.transcription",
      {
        expectedRevision: access.revision,
        capabilityRevision: capability.revision,
        capabilityVersion: 1,
        mode: "disabled",
      },
    );
    require_(off.status === 200, `policy: ${JSON.stringify(off)}`);
    await page.getByRole("button", { name: "Turn on" }).click();
    await page
      .getByRole("button", { name: "Allow" })
      .click({ timeout: 20_000 });
    // The microphone stream starts just after this, so these times run a little early.
    streamStart = Date.now();
    const statusText = () =>
      page
        .locator(".voice-status")
        .textContent({ timeout: 500 })
        .catch(() => "");
    await waitFor(
      "listening",
      async () => (await statusText()).includes("Hey Satyr"),
      60_000,
    );
    require_(
      voiceFiles().some((request) => request.url.endsWith("hey_satyr.onnx")),
      "The wake model did not load.",
    );
    require_(
      await page.locator(".voice-header-mark").isVisible(),
      "The header has no microphone mark.",
    );
    await shot("listening");
    step("the access prompt turns voice on, and the files load after opt-in", {
      files: voiceFiles().length,
    });

    let watching = true;
    const watcher = (async () => {
      while (watching) {
        seen.add(await statusText());
        await sleep(100);
      }
    })();
    const elapsed = () => Date.now() - streamStart;
    const message = (text) =>
      page.locator('article[aria-label="You"]', { hasText: text });
    const chatCommands = () =>
      requests
        .filter(
          (request) => request.url.endsWith("/chat") && request.body !== null,
        )
        .map((request) => JSON.parse(request.body))
        .filter((body) => body.inputMode !== undefined);
    const macAudio = () =>
      requests.filter(
        (request) =>
          request.url === "/transcriptions" && request.method === "POST",
      );
    const platformAudio = () =>
      requests.filter((request) =>
        request.url.endsWith("/voice/transcriptions"),
      );
    // The mark names the host and the engine that heard the command (Plan 82C): ON_MAC.

    // Scene 1: a command with the shop vocabulary, on the Mac.
    const first = message("second oven");
    await first.waitFor({ timeout: 40_000 });
    const firstText = await first.locator("p").first().textContent();
    require_(firstText.includes("Kouign-amann"), `transcript: ${firstText}`);
    require_(
      (await first.getByRole("img", { name: ON_MAC }).count()) === 1,
      "The message has no microphone mark.",
    );
    require_(platformAudio().length === 0, "The audio left the shop.");
    step("a spoken command reaches the chat through the Mac", {
      text: firstText,
      atMs: elapsed(),
    });

    // Scene 2: the next command waits behind the running turn, and the answer is spoken once.
    await waitFor(
      "the queued command",
      () => chatCommands().some((body) => body.kind === "next"),
      40_000,
    );
    await message("butter").waitFor({ timeout: 60_000 });
    await waitFor(
      "the spoken answer",
      () =>
        page.evaluate(() =>
          window.__spoken.some((text) => text.endsWith("More on screen.")),
        ),
      60_000,
    );
    const spoken = await page.evaluate(() => window.__spoken);
    require_(
      spoken.join(" ") ===
        "Two trays are in the second oven. The timer is set. More on screen.",
      `spoken: ${JSON.stringify(spoken)}`,
    );
    const macVoice = await page.evaluate(() => window.__macVoice);
    const macSeconds = macVoice.reduce((sum, part) => sum + part.seconds, 0);
    require_(
      macVoice.length === spoken.length && macSeconds > 2,
      `The answer did not play in the Mac's voice: ${JSON.stringify(macVoice)}`,
    );
    step(
      "a command during a turn waits as next, and only its own answer is spoken, in the Mac's voice",
      { spoken: spoken.join(" "), seconds: macSeconds },
    );

    // Scene 3: "change" steers the running turn.
    await message("financiers").waitFor({ timeout: 40_000 });
    await waitFor(
      "the steer",
      () => chatCommands().some((body) => body.kind === "steer"),
      40_000,
    );
    const steer = chatCommands().find((body) => body.kind === "steer");
    require_(/^change/iu.test(steer.text), `steer: ${steer.text}`);
    step("a command that starts with change steers the turn", {
      text: steer.text,
    });

    // Scene 4: "cancel" stops the turn and sends no message.
    await message("croissants").waitFor({ timeout: 40_000 });
    await waitFor(
      "the stop",
      () =>
        requests.some(
          (request) =>
            request.url.endsWith("/chat/cancel") ||
            request.url.endsWith("/cancel"),
        ),
      40_000,
    );
    require_(
      !chatCommands().some((body) => /^cancel\W*$/iu.test(body.text)),
      "Cancel became a message.",
    );
    step("the word cancel stops the turn and sends no message");

    // Scene 5 and other talk: no speech after the wake phrase, and talk with no wake phrase.
    const audioBefore = macAudio().length + platformAudio().length;
    await waitFor(
      "the end of the other talk",
      () => elapsed() > 90_000,
      90_000,
    );
    require_(
      macAudio().length + platformAudio().length === audioBefore,
      "Audio left the device with no command.",
    );
    require_(
      chatCommands().length === 5,
      `commands: ${JSON.stringify(chatCommands().map((body) => body.text))}`,
    );
    require_(
      seen.has("Listening") && seen.has("Transcribing…"),
      `states: ${JSON.stringify([...seen])}`,
    );
    step(
      "no audio leaves the device for talk with no wake phrase or for a wake with no command",
      { audioRequests: audioBefore },
    );

    // Scene 6: the Mac stops answering. The command takes the fallback and gives one message.
    const pid = macPid();
    const voicesBefore = await page.evaluate(() => ({
      spoken: window.__spoken.length,
      mac: window.__macVoice.length,
    }));
    process.kill(pid, "SIGSTOP");
    const label = message("Label the second tray");
    let fallbackAtMs;
    try {
      await label.waitFor({ timeout: 30_000 });
      fallbackAtMs = elapsed();
      require_(
        (await label
          .getByRole("img", {
            name: "Spoken command, transcribed in the cloud by Whisper large-v3-turbo",
          })
          .count()) === 1,
        "The fallback mark with its engine is missing.",
      );
      require_(
        platformAudio().length === 1,
        `fallback calls: ${platformAudio().length}`,
      );
      await waitFor(
        "the Cloud mark",
        () => page.locator(".voice-cloud").isVisible(),
        40_000,
      );
      await shot("cloud");
      await waitFor(
        "the answer in the browser's voice",
        () =>
          page.evaluate(
            (before) =>
              window.__spoken.length > before.spoken &&
              window.__macVoice.length === before.mac,
            voicesBefore,
          ),
        30_000,
      );
    } finally {
      process.kill(pid, "SIGCONT");
    }
    await sleep(3000);
    require_(
      (await label.count()) === 1,
      "A late answer from the Mac gave a second message.",
    );
    const state = await (await fetch(`${input.worker}/test/state`)).json();
    require_(
      state.aiCalls.length === 1 &&
        state.aiCalls[0].language === "en" &&
        state.aiCalls[0].audioBase64Length > 1000,
      `AI: ${JSON.stringify(state.aiCalls)}`,
    );
    step("the fallback gives one message when the Mac stops answering", {
      atMs: fallbackAtMs,
    });

    watching = false;
    await watcher;

    // A reload keeps the setting. Off closes the microphone and deletes the voice files.
    await page.goto(chatUrl);
    await page.waitForSelector("#chat-message", { timeout: 60_000 });
    await waitFor(
      "the session to resume",
      async () => (await statusText()).includes("Hey Satyr"),
      30_000,
    );
    step("after a reload, voice control starts again with no new choice");
    const cached = await page.evaluate(() => caches.keys());
    require_(cached.includes("satyr-voice-v1"), `caches: ${cached}`);
    await page
      .getByRole("button", { name: "Voice control", exact: true })
      .click();
    await page.getByRole("button", { name: "Turn off" }).click();
    await waitFor(
      "the files to go",
      async () =>
        !(await page.evaluate(() => caches.keys())).includes("satyr-voice-v1"),
      10_000,
    );
    require_(
      (await page.locator(".voice-status").count()) === 0 &&
        (await page.locator(".voice-header-mark").count()) === 0,
      "The microphone mark stayed.",
    );
    step("off closes the microphone and deletes the voice files");

    await spokenApproval(browser, input, chatUrl);
    await spokenDrafts(browser, input, chatUrl);
    await holdToTalk(browser, input, chatUrl);
    await closedChat(browser, input, chatUrl);

    // The manager revokes the Mac in the dialog, and the Mac stops.
    await shopMac();
    if (ENGINE !== WHISPER) {
      // A change back needs no download: Whisper's file stays the same file.
      const home = path.join(process.env.PANTRY_VOICE_HOME, "model");
      const weights = path.join(home, WHISPER, "weights.safetensors");
      const before = fs.statSync(weights).ino;
      await chooseOption(
        page,
        page
          .locator(".voice-mac-row")
          .getByRole("combobox", { name: "Speech engine" }),
        { value: WHISPER },
      );
      await waitFor(
        "the change back",
        async () => {
          const { body } = await api("GET", "voice/macs");
          return body.macs[0]?.engine === WHISPER ? true : null;
        },
        60_000,
        1000,
      );
      require_(
        fs.statSync(weights).ino === before,
        "The change back downloaded Whisper again.",
      );
      require_(
        fs.existsSync(path.join(home, ENGINE, ".unused-since")),
        "The other engine's files did not start their 14 days.",
      );
      step("a change back to Whisper in the dialog needs no download");
    }
    await page
      .locator(".voice-mac-row")
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await page.getByRole("button", { name: "Revoke this Mac" }).click();
    await waitFor(
      "the row to go",
      async () => (await page.locator(".voice-mac-row").count()) === 0,
      15_000,
    );
    await waitFor("the Mac to stop", () => macPid() === null, 60_000, 1000);
    step("a revocation in the dialog stops the Mac");
    require_(problems.length === 0, `page errors: ${problems.join("; ")}`);
    results.result = "passed";
  } catch (error) {
    results.result = "failed";
    results.error = String(error);
    results.requests = requests.slice(-40);
    results.status = await page
      .locator(".voice-status")
      .textContent({ timeout: 500 })
      .catch(() => null);
    results.pageErrors = problems;
    results.console = consoleLines.slice(-30);
    results.seen = [...seen];
    results.articleHtml = await page
      .locator('article[aria-label="You"]')
      .first()
      .innerHTML()
      .catch(() => null);
    results.chatError = await page
      .locator('[role="alert"]')
      .allTextContents()
      .catch(() => null);
    results.messages = await page
      .locator('article[aria-label="You"]')
      .allTextContents()
      .catch(() => null);
    await shot("failure").catch(() => undefined);
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(input.artifacts, "portal-journey-results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    await Promise.race([browser.close(), sleep(15_000)]);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(String(error));
    process.exit(1);
  },
);
