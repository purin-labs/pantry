"""Plan 82 G0.4 and Plan 91 phase 6: the wake phrases that wake.py, train.py, export.py and
phase-bench.py build and measure.

Each phrase has its own training clips, test clips, model and reports. The speech and the noise
that measure false wakes (LibriSpeech and DEMAND, in <data>/features/test-*.npz) are the same
for every phrase, so the false-wake numbers of two phrases compare directly.

"Hey Satyr" keeps its files where they were first made, in <data>. Each new phrase keeps its
files in <data>/<slug>, for example ~/.satyr-voice-test/wake/hey-sous-chef.
"""
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

DATA = Path.home() / ".satyr-voice-test/wake"

# Speech in a bakery that is near no wake phrase. Each phrase adds its own near talk.
BAKERY_TALK = (
    "put the second tray in the oven", "the butter needs ten more minutes", "two flat whites for table six",
    "can you check the proofing cabinet", "we are out of almond flour", "hey can you pass the scraper",
    "the financiers are ready to box", "order forty seven is ready for pickup", "hey, watch out, hot tray behind you",
    "start the mixer at speed two", "the delivery came early today", "take the croissants off the rack",
    "thank you, see you next time", "would you like a bag for that", "hey, do we have more pistachio paste",
)
# Words before the name, in place of "hey". The name after another word must not wake the Portal.
LEADS = ("deɪ", "seɪ", "eɪ", "ðə", "ə", "meɪ", "weɪ", "pleɪ", "stɑːp", "oʊ", "wɛl")


@dataclass(frozen=True)
class Phrase:
    key: str
    # The ONNX file name without ".onnx", as the Portal loads it from /voice/.
    stem: str
    title: str
    # Text or [[ phonemes ]] for Piper and Kokoro. The test clips use the same forms.
    wake: tuple[str, ...]
    near_train: tuple[str, ...]
    # Near phrases that only measure. The generator below never makes them.
    near_test: tuple[str, ...]
    near_talk: tuple[str, ...]
    near_phonemes: Callable[[np.random.Generator, int], list[str]]
    # macOS voices only measure (export.py voices and phase-bench.py). Never train on them.
    macos_wake: tuple[str, ...]
    macos_near: tuple[str, ...]
    bench_wake: tuple[str, ...]
    bench_near: tuple[str, ...]
    bench_talk: tuple[str, ...]

    @property
    def slug(self) -> str:
        return self.stem.replace("_", "-")

    def folder(self, data: Path) -> Path:
        return data if self.key == "satyr" else data / self.slug

    def features(self, data: Path) -> Path:
        return self.folder(data) / "features"

    def onnx(self, data: Path) -> Path:
        return self.folder(data) / "models" / f"{self.stem}.onnx"

    @property
    def talk(self) -> tuple[str, ...]:
        return BAKERY_TALK + self.near_talk


# "Hey Satyr" (Plan 82 G0.4). Satyr has two usual English forms, with the vowel of "say" and of
# "sat". Both wake the Portal.
SATYR_ONSETS = ("s", "ʃ", "z", "θ", "t", "d", "k", "ɡ", "p", "b", "f", "v", "m", "n", "l", "ɹ", "w", "j", "h", "st", "sp", "sk", "sl", "sw", "sn", "sm")
SATYR_VOWELS = ("eɪ", "æ", "ɛ", "ɪ", "iː", "ʌ", "ɑː", "ɔː", "oʊ", "aɪ", "aʊ", "uː")
SATYR_MIDDLES = ("t", "ɾ", "d", "l", "n", "m", "v", "s", "z", "k", "p", "b", "ð")
SATYR_ENDS = ("ɚ", "ə", "iː", "oʊ", "ɪŋ", "ən")
SATYR_WAKE_ONSET_VOWELS = {("s", "eɪ"), ("s", "æ")}
SATYR_HELD_OUT = {("s", "eɪ", "d"), ("s", "iː", "d"), ("s", "ɛ", "ɾ"), ("s", "ɛ", "t"), ("s", "eɪ", "v"), ("s", "ɪ", "ɾ"), ("s", "ɪ", "t"),
                  ("d", "eɪ", "ɾ"), ("d", "eɪ", "t"), ("d", "æ", "ɾ"), ("d", "æ", "t"), ("sp", "æ", "ɾ"), ("sp", "æ", "t"), ("ʃ", "æ", "ɾ"),
                  ("ʃ", "æ", "t"), ("m", "æ", "ɾ"), ("m", "æ", "t"), ("sk", "eɪ", "ɾ"), ("sk", "eɪ", "t")}


def satyr_near_phonemes(rng: np.random.Generator, count: int) -> list[str]:
    """Every near phrase in the form "hey" + onset + vowel + middle + end. The forms of the wake
    phrase are left out, and so are the forms of the near test, so that it stays on unseen phrases."""
    out = []
    while len(out) < count:
        onset, vowel, middle, end = (str(rng.choice(part)) for part in (SATYR_ONSETS, SATYR_VOWELS, SATYR_MIDDLES, SATYR_ENDS))
        if (onset, vowel, middle) in SATYR_HELD_OUT or ((onset, vowel) in SATYR_WAKE_ONSET_VOWELS and middle in "tɾ" and end in ("ɚ", "ə")):
            continue
        if rng.random() < 0.1:
            out.append(f"[[ {rng.choice(LEADS)} sˈeɪɾɚ ]]" if rng.random() < 0.5 else f"[[ {rng.choice(LEADS)} sˈætə ]]")
        else:
            out.append(f"[[ heɪ {onset}ˈ{vowel}{middle}{end} ]]")
    return out


SATYR = Phrase(
    key="satyr",
    stem="hey_satyr",
    title="Hey Satyr",
    wake=("hey sayter", "hey, sayter", "[[ heɪ sˈeɪtə ]]", "[[ heɪ sˈeɪɾɚ ]]", "hey satyr", "hey, satyr", "[[ heɪ sˈætə ]]"),
    near_train=(
        "hey sailor", "hey sister", "hey there", "hey waiter", "hey later", "hey peter", "hey sadie",
        "hey hater", "hey cater", "hey sara", "hey slater", "hey sweater", "hey saturday", "hey sugar",
        "hey siri", "hey summer", "hey sir", "say to her", "say that", "satire", "satyr", "sayter", "hey",
        "hey doctor", "hey water", "stay there", "safer", "greater", "hey sam", "a satyr came",
        "see you later", "pass the butter", "hey set a timer", "they sat here", "the baker", "hey taylor",
    ),
    near_test=(
        "hey sayer", "hey seder", "hey cedar", "hey setter", "hey saver", "hey sitter", "hey sader",
        "hey data", "hey dater", "hey spatter", "hey shatter", "hey matter", "say her", "hey skater",
        "hey straighter", "hey it's later", "hey, sit there", "hey said her", "sat here", "they say to her",
    ),
    near_talk=(),
    near_phonemes=satyr_near_phonemes,
    macos_wake=("hey sayter", "hey, sayter", "hey satyr", "hey, satyr"),
    macos_near=("hey sailor", "hey setter", "hey data", "hey waiter", "hey later", "say to her", "see you later",
                "put the second tray in the oven", "hey can you pass the scraper", "the butter needs ten more minutes"),
    bench_wake=("Hey Satyr", "Hey, Satyr"),
    bench_near=("Hey sayter", "Hey Sarah", "Hey satire", "Hey Peter", "Hey sailor", "Hey Saturday",
                "Hey cedar", "Hey, setter"),
    bench_talk=(
        "Put two trays of kouign amann in the second oven.", "How much butter is left for tomorrow?",
        "Can you pass me the piping bag?", "The croissants need another five minutes.",
        "Say hi to Sarah for me.", "Hey, did the flour delivery come in?", "It's a satire, really.",
        "We have a lot of orders for Saturday.", "Hey Peter, can you take the next customer?",
        "Mark the black sesame financiers as sold out.", "That will be six hundred yen, please.",
        "Would you like that warmed up?", "The setter on the mixer is stuck again.",
        "Hey, can you check the proofer temperature?", "Thank you, have a nice day!",
        "Is the matcha latte with oat milk?", "We are out of the pistachio cakes.",
        "Hey there, what can I get for you?", "The sailor stripes on the boxes look great.",
        "Start the shift for the morning bake.",
    ),
)


# "Hey Sous Chef" (Plan 91 phase 6). English says /ˈsuː ʃɛf/. espeak reads "sous" as /suːz/, so
# the text form "hey sue chef" gives the usual sound, and "hey sous chef" gives the /z/ form that
# some people say. The stress falls on either word.
SOUS_ONSETS = ("s", "ʃ", "z", "θ", "t", "d", "k", "ɡ", "p", "b", "f", "v", "m", "n", "l", "ɹ", "w", "j", "h", "st", "sp", "sk", "sl", "sw", "sn", "sm", "")
SOUS_VOWELS = ("uː", "ʊ", "oʊ", "iː", "ɪ", "eɪ", "ɛ", "æ", "ʌ", "ɑː", "ɔː", "aɪ", "aʊ")
SOUS_MIDDLES = ("ʃ", "tʃ", "s", "z", "dʒ", "ʒ", "f", "θ", "t", "k", "p", "l", "n", "m", "h", "w")
SOUS_SECOND_VOWELS = ("ɛ", "æ", "ɪ", "eɪ", "ʌ", "ɑː", "uː", "oʊ", "iː", "ə")
SOUS_ENDS = ("f", "v", "θ", "s", "p", "t", "k", "l", "lf", "ft", "n", "m", "ɹ", "d", "")
# The near test says these. The generator never makes them.
SOUS_HELD_OUT = {("s", "uː", "ʃ", "iː"), ("ʃ", "uː", "ʃ", "ɛ"), ("s", "uː", "tʃ", "ɛ"), ("j", "uː", "ʃ", "ɛ"), ("s", "oʊ", "ʃ", "ɛ"),
                 ("t", "uː", "ʃ", "ɛ"), ("s", "uː", "tʃ", "iː"), ("s", "uː", "dʒ", "ɛ"), ("s", "iː", "ʃ", "ɛ")}


def sous_chef_wake_like(onset: str, vowel: str, middle: str, second: str, end: str) -> bool:
    """Forms that a person can say for "sous chef". They are not near phrases."""
    return onset in ("s", "z") and vowel in ("uː", "ʊ") and middle in ("ʃ", "ʒ") and second in ("ɛ", "eɪ", "æ") and end in ("f", "v", "θ", "ft")


def sous_chef_near_phonemes(rng: np.random.Generator, count: int) -> list[str]:
    """Every near phrase in the form "hey" + onset + vowel + middle + second vowel + end."""
    out = []
    while len(out) < count:
        parts = tuple(str(rng.choice(part)) for part in (SOUS_ONSETS, SOUS_VOWELS, SOUS_MIDDLES, SOUS_SECOND_VOWELS, SOUS_ENDS))
        onset, vowel, middle, second, end = parts
        if parts[:4] in SOUS_HELD_OUT or sous_chef_wake_like(*parts):
            continue
        if rng.random() < 0.1:
            out.append(f"[[ {rng.choice(LEADS)} sˈuː ʃɛf ]]" if rng.random() < 0.5 else f"[[ {rng.choice(LEADS)} suː ʃˈɛf ]]")
        else:
            # Two words ("sue shell") or one word ("sushi").
            gap = " " if rng.random() < 0.5 else ""
            out.append(f"[[ heɪ {onset}ˈ{vowel}{gap}{middle}{second}{end} ]]")
    return out


SOUS_CHEF = Phrase(
    key="sous-chef",
    stem="hey_sous_chef",
    title="Hey Sous Chef",
    wake=("hey sue chef", "hey, sue chef", "hey sous chef", "[[ heɪ sˈuː ʃɛf ]]", "[[ heɪ suː ʃˈɛf ]]",
          "[[ heɪ sˈuːʃˌɛf ]]", "[[ heɪ sʊ ʃˈɛf ]]"),
    near_train=(
        "hey chef", "yes chef", "yes, chef", "sous chef", "sue chef", "the sous chef", "hey sue", "hey shoe",
        "hey soup", "hey super", "hey sushi chef", "hey head chef", "hey pastry chef", "hey new chef",
        "hey shelf", "hey jeff", "hey josef", "hey chief", "hey staff", "hey sous vide", "hey suit",
        "hey siri", "hey there", "hey", "hey you", "hey sir", "hey sugar", "hey waiter", "hey sam",
        "ask the sous chef", "a sous chef came", "see you later", "hey set a timer", "she's the chef",
        "hey stuff", "two chefs",
    ),
    near_test=(
        "hey sushi", "hey shoe shelf", "hey true self", "hey soup chef", "hey sue chen", "hey, you, chef",
        "hey so chef", "hey school chef", "hey two shelves", "hey moose chef", "hey juice shelf",
        "hey sous chief", "hey sue jeff", "hey cute chef", "hey swiss chef", "hey see chef", "our sous chef",
        "the new sous chef", "hey such a chef", "hey shoe chef",
    ),
    near_talk=(
        "behind you, chef", "chef, the oven is hot", "the sous chef is off today", "where is the sous chef",
        "hey, the chef wants the tarts now", "yes chef, two minutes",
    ),
    near_phonemes=sous_chef_near_phonemes,
    macos_wake=("hey sous chef", "hey, sous chef", "hey sue chef", "hey, sue chef"),
    macos_near=("hey chef", "hey sushi", "hey shoe shelf", "hey sous vide", "hey soup chef", "yes chef", "the sous chef",
                "put the second tray in the oven", "hey can you pass the scraper", "the butter needs ten more minutes"),
    bench_wake=("Hey Sous Chef", "Hey, Sous Chef"),
    bench_near=("Hey chef", "Hey sushi", "Hey shoe shelf", "Hey sous vide", "Hey soup chef", "Hey Sue",
                "Hey, you, chef", "Hey Josef"),
    # The same café talk as for "Hey Satyr", with the six lines near "Satyr" changed to lines near
    # "Sous Chef".
    bench_talk=(
        "Put two trays of kouign amann in the second oven.", "How much butter is left for tomorrow?",
        "Can you pass me the piping bag?", "The croissants need another five minutes.",
        "Yes chef, two minutes.", "Hey, did the flour delivery come in?", "Ask the sous chef about the cake order.",
        "The sushi place next door is closed today.", "Hey chef, the delivery is here.",
        "Mark the black sesame financiers as sold out.", "That will be six hundred yen, please.",
        "Would you like that warmed up?", "We need a new shoe shelf in the back.",
        "Hey, can you check the proofer temperature?", "Thank you, have a nice day!",
        "Is the matcha latte with oat milk?", "We are out of the pistachio cakes.",
        "Hey there, what can I get for you?", "Our sous chef starts at six tomorrow.",
        "Start the shift for the morning bake.",
    ),
)

PHRASES = {phrase.key: phrase for phrase in (SATYR, SOUS_CHEF)}
