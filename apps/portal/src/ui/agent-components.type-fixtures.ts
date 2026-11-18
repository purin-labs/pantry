import type { AttachmentState } from "./attachment";
import type { QuestionAnswer, QuestionSubmitResult } from "./question-card";
import type { ResponseActionResult, ResponseRating } from "./response-actions";

// @ts-expect-error A ready attachment requires an actual destination.
const missingFile: AttachmentState = { kind: "ready" };
// @ts-expect-error An upload cannot also expose a ready link.
const uploadingLink: AttachmentState = {
  kind: "uploading",
  progress: 50,
  href: new URL("https://example.com"),
};
const readyFile = {
  kind: "ready" as const,
  href: new URL("https://example.com"),
};
// @ts-expect-error Spreading a ready link into an unavailable attachment is invalid.
const unavailableLink: AttachmentState = {
  ...readyFile,
  kind: "unavailable",
  reason: "Removed",
};
// @ts-expect-error A choice answer cannot contain a separate free-text answer.
const mixedAnswer: QuestionAnswer = {
  kind: "choice",
  choice: { id: "a", label: "A" },
  text: "B",
};
// @ts-expect-error Failures must explain why the answer was rejected.
const emptyFailure: QuestionSubmitResult = { kind: "failed" };

void [missingFile, uploadingLink, unavailableLink, mixedAnswer, emptyFailure];

// @ts-expect-error Skipping cannot carry an answer, including through a spread.
const skipWithChoice: QuestionAnswer = { ...mixedAnswer, kind: "skipped" };
// @ts-expect-error A skipped response cannot also supply free text.
const skipWithText: QuestionAnswer = { kind: "skipped", text: "Yes" };
void [skipWithChoice, skipWithText];

// @ts-expect-error Failed response actions require a visible error message.
const unexplainedAction: ResponseActionResult = { kind: "failed" };
const failedAction = { kind: "failed" as const, message: "Delivery failed." };
// @ts-expect-error An accepted action cannot retain a failure through a spread.
const acceptedFailure: ResponseActionResult = {
  ...failedAction,
  kind: "accepted",
};
// @ts-expect-error A response has one rating at a time.
const conflictingRating: ResponseRating = ["good", "bad"];
void [unexplainedAction, acceptedFailure, conflictingRating];
import type { TaskState } from "./task-list";
// @ts-expect-error Completed tasks cannot retain running progress.
const completedWithProgress: TaskState = { kind: "completed", progress: 50 };
// @ts-expect-error Running tasks must specify known or indeterminate progress.
const runningWithoutProgress: TaskState = { kind: "running" };
void [completedWithProgress, runningWithoutProgress];

import type {
  VoiceAssistantInput,
  VoiceAssistantState,
} from "./voice-assistant-card";

// @ts-expect-error Listening requires an explicit audio source.
const voiceWithoutInput: VoiceAssistantState = { kind: "listening" };
// @ts-expect-error One source cannot provide both a level and a microphone.
const mixedVoiceInput: VoiceAssistantInput = {
  kind: "level",
  level: 0.4,
  stream: new MediaStream(),
};
const listeningVoice = {
  kind: "listening" as const,
  input: { kind: "level" as const, level: 0.4 },
};
// @ts-expect-error Processing cannot retain the audio input through a spread.
const processingWithInput: VoiceAssistantState = {
  ...listeningVoice,
  kind: "processing",
};
// @ts-expect-error A direct assertion cannot add audio to the idle state.
const unsafeVoiceCast = {
  kind: "idle",
  input: { kind: "level", level: 0.4 },
} as VoiceAssistantState;
void [voiceWithoutInput, mixedVoiceInput, processingWithInput, unsafeVoiceCast];
