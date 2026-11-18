#!/usr/bin/env node
// Scores the files of `phrase-bench.py` with the Portal's own voice code (Plan 82C Phase 0).
//
//   node scripts/shop-voice/phrase-score.mjs output/shop-voice/phrase-bench.json [more files]
//
// A file of recorded voices (Plan 82C Phase 3) also has commands, commands from 2 m, bare lists and
// room sound, and the misses: the prompts where the device sent nothing. With one such file for each
// engine, the score ends with the D5 rule of the plan: Qwen3-ASR becomes the default for new Macs
// only when it is no worse than Whisper on each safety measure and no worse on words.
//
// Each clip takes the path of `features/voice/session.ts`: `readVoiceCommand` drops noise, an attempt
// at a waiting card's phrase goes to the exact match of the Platform (`normalizeVoicePhrase`), and other
// speech is a command. While a turn runs, `soundsLikeStop` also stops it with the engine's
// `heardAsStop`. `portal-voice.mjs` bundles the shipped code, so the score keeps no copy of it.
import { readFileSync } from "node:fs";

import { loadPortalVoice } from "./portal-voice.mjs";

const voice = await loadPortalVoice();

function outcome(row, names, engine) {
  const command = voice.readVoiceCommand(row.keptText, names);
  if (command.kind === "empty") return "dropped";
  if (command.kind === "stop") return "stop";
  // As in the session: the attempt and the match read the text after the text check. A card
  // waits only in the sets of phrases; a command, a list or the room has no card to match.
  const waiting = ["phrase", "near", "stop"].includes(row.set)
    ? [row.target]
    : [];
  if (voice.isVoiceConfirmationAttempt(command.text, waiting))
    return voice.normalizeVoicePhrase(command.text) ===
      voice.normalizeVoicePhrase(row.target)
      ? "matched"
      : "refused";
  return voice.soundsLikeStop(command.text, engine)
    ? "stop while a turn runs"
    : "to the agent";
}

const level = (row) => (row.level === null ? "quiet" : `${row.level} dB`);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// What a good outcome is for each set.
const GOOD = {
  phrase: ["matched"],
  near: ["refused", "to the agent", "dropped"],
  stop: ["stop", "stop while a turn runs"],
  command: ["to the agent"],
  far: ["to the agent"],
  list: ["to the agent"],
  room: ["dropped"],
};
const mean = (values) =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

/** The measures of the D5 rule for one engine's file of recorded voices. */
function measures(result, rows, overWait) {
  const of = (...sets) => rows.filter((row) => sets.includes(row.set));
  const good = (row) => GOOD[row.set].includes(row.outcome);
  const commands = of("command", "far");
  return {
    engine: result.engine,
    roomClipsSent: of("room").filter((row) => !good(row)).length,
    roomClips: of("room").length,
    commandsLost: commands.filter((row) => !good(row)).length,
    commands: commands.length,
    commandWords: mean(commands.map((row) => row.wordScore)),
    namesRight: commands.reduce((sum, row) => sum + row.namesRight, 0),
    namesWanted: commands.reduce((sum, row) => sum + row.namesWanted, 0),
    phrasesMatched: of("phrase").filter(good).length,
    phrases: of("phrase").length,
    nearMissesMatched: of("near").filter((row) => row.outcome === "matched")
      .length,
    stopsHeard: of("stop").filter(good).length,
    stops: of("stop").length,
    listsKept: of("list").filter(good).length,
    lists: of("list").length,
    clipsOverTheWait: rows.filter(overWait).length,
  };
}

const human = [];
for (const file of process.argv.slice(2)) {
  const result = JSON.parse(readFileSync(file, "utf8"));
  const names = result.vocabulary.split(", ");
  const rows = result.rows.map((row) => ({
    ...row,
    outcome: outcome(row, names, result.engine),
  }));
  // The Portal's wait for the Mac, from the engine catalogue.
  const overWait = (row) =>
    row.seconds * 1000 >
    voice.voiceMacDeadlineMs(result.engine, row.audioSeconds);
  console.log(`\n${result.engine} (${file})`);
  console.log(
    `  first call ${result.firstCallSeconds.toFixed(2)} s, median ${median(rows.map((r) => r.seconds)).toFixed(2)} s,` +
      ` ${rows.filter(overWait).length} of ${rows.length} clips over the Portal's wait`,
  );
  for (const set of Object.keys(GOOD)) {
    const inSet = rows.filter((row) => row.set === set);
    if (inSet.length === 0) continue;
    const levels = [...new Set(inSet.map(level))];
    const counts = levels.map((name) => {
      const at = inSet.filter((row) => level(row) === name);
      const tally = {};
      for (const row of at) tally[row.outcome] = (tally[row.outcome] ?? 0) + 1;
      return `${name}: ${Object.entries(tally)
        .map(([key, count]) => `${count} ${key}`)
        .join(", ")} (of ${at.length})`;
    });
    console.log(`  ${set}\n    ${counts.join("\n    ")}`);
    // A phrase's digits come back as numerals from Whisper, so words are scored for commands only.
    const words = ["command", "far", "list"].includes(set)
      ? mean(inSet.map((row) => row.wordScore))
      : null;
    if (words !== null)
      console.log(`    words heard: ${(words * 100).toFixed(1)}%`);
    const wrong = inSet.filter((row) => !GOOD[set].includes(row.outcome));
    const heard = {};
    for (const row of wrong) {
      const key = `${row.kind} -> "${row.keptText}" (${row.outcome})`;
      heard[key] = (heard[key] ?? 0) + 1;
    }
    for (const [key, count] of Object.entries(heard).sort(
      (a, b) => b[1] - a[1],
    ))
      console.log(`      ${count} x ${key}`);
  }
  const stopForms = {};
  for (const row of rows.filter((r) => r.set === "stop"))
    stopForms[`${row.kind}: "${row.keptText}"`] =
      (stopForms[`${row.kind}: "${row.keptText}"`] ?? 0) + 1;
  console.log(
    `  every form of "stop" and "cancel": ${JSON.stringify(stopForms)}`,
  );
  if (result.session !== undefined) {
    const misses = {};
    for (const miss of result.misses)
      misses[`${miss.set} ${miss.event}`] =
        (misses[`${miss.set} ${miss.event}`] ?? 0) + 1;
    console.log(
      `  prompts where the device sent nothing: ${JSON.stringify(misses)}`,
    );
    human.push(measures(result, rows, overWait));
  }
}

const whisper = human.find((m) => m.engine === "whisper-large-v3-turbo");
const qwen3 = human.find((m) => m.engine === "qwen3-asr-1.7b");
if (whisper !== undefined && qwen3 !== undefined) {
  console.log("\nThe D5 rule (Plan 82C Phase 3), Qwen3-ASR against Whisper");
  console.log(JSON.stringify({ whisper, qwen3 }, null, 1));
  // Room sound counts only from the shop; a run with no room clips waits for it.
  const checks = [
    [
      "no more room clips sent",
      qwen3.roomClips === 0 ? null : qwen3.roomClipsSent <= whisper.roomClipsSent,
    ],
    ["no more commands lost", qwen3.commandsLost <= whisper.commandsLost],
    [
      "no fewer approval phrases matched",
      qwen3.phrasesMatched >= whisper.phrasesMatched,
    ],
    ["no near miss matched", qwen3.nearMissesMatched === 0],
    ["no fewer stop words heard", qwen3.stopsHeard >= whisper.stopsHeard],
    ["no clip after the Portal's wait", qwen3.clipsOverTheWait === 0],
    ["no fewer words heard", qwen3.commandWords >= whisper.commandWords],
  ];
  for (const [name, passed] of checks)
    console.log(
      `  ${passed === null ? "WAIT (no room sound)" : passed ? "pass" : "FAIL"} ${name}`,
    );
  console.log(
    checks.some(([, passed]) => passed === false)
      ? "D5: Qwen3-ASR does not pass. Whisper stays the default."
      : checks.some(([, passed]) => passed === null)
        ? "D5: not decided. Record the shop's sound (voice-recorder.html?only=room) and run the bench again."
        : "D5: Qwen3-ASR passes on these recordings. The week of device counts comes next.",
  );
}
