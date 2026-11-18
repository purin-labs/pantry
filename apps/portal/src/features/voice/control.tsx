import {
  DEFAULT_MAC_VOICE_ENGINE,
  parseVoiceMacEnrollmentStart,
  parseVoiceMacList,
  VOICE_ENGINES,
  type ChatTranscriptionPath,
  type VoiceEngineId,
  type VoiceMacEnrollmentStart,
  type VoiceMacView,
} from "@seams/control-api";
import {
  ArrowLeft,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  HardDriveDownload,
  Laptop,
  Mic,
  Trash2,
  X,
} from "lucide-react";
import React from "react";
import { createPortal } from "react-dom";

import { cancelDialog, DialogHeading, syncDialog } from "../../dialog";
import {
  ActionMenu,
  PermissionRequestDialog,
  PantryMark,
  Select,
  type PermissionRequestDecision,
} from "../../ui";
import type { AccessRouteTransport } from "@seams/control-api/portal/access-models";
import {
  enableCapabilities,
  mayEnableEvery,
  type RequestedCapability,
} from "../access/permission-enable";
import { readCookie } from "../chat/api";
import {
  ControlApiError,
  controlRead,
  controlWrite,
} from "../../control-client";
import { voiceCountsToday, voiceHeardLastDays } from "./counts";
import {
  chosenMicrophone,
  voiceControlIsOn,
  voiceIsListening,
  voiceTalkKeyName,
  type VoiceSession,
  type VoiceStatus,
} from "./session";
import "./styles.css";

const VOICE_CAPABILITY: RequestedCapability = {
  capabilityId: "voice.transcription",
  capabilityVersion: 1,
  label: "Transcribe spoken commands",
};

type Props = Readonly<{
  session: VoiceSession;
  organisationId: string;
  workspaceName: string;
  signedInAs: string | null;
  accessPath: string;
  access: Pick<AccessRouteTransport, "read" | "mutate">;
}>;

function useVoiceStatus(session: VoiceSession): VoiceStatus {
  return React.useSyncExternalStore(session.subscribe, session.status);
}

function statusText(status: VoiceStatus): string | null {
  switch (status.kind) {
    case "off":
      return null;
    case "starting":
      return "Starting voice control…";
    case "listening": {
      const key = voiceTalkKeyName();
      return key === null
        ? 'Say "Hey Satyr"'
        : `Say "Hey Satyr" or hold ${key}`;
    }
    case "capturing":
      return status.hold ? "Listening. Release to send." : "Listening";
    case "transcribing":
      return "Transcribing…";
    case "needs_tap":
      return null;
    case "blocked":
      switch (status.reason) {
        case "other_tab":
          return "Voice control is on in another tab";
        case "microphone":
          return "Allow the microphone to use voice control";
        case "voice_disabled":
          return "Voice control is off for this workspace";
        case "failed":
          return "Voice control stopped. Open it to try again.";
      }
  }
}

function usesCloud(status: VoiceStatus): boolean {
  return (
    (status.kind === "listening" ||
      status.kind === "capturing" ||
      status.kind === "transcribing") &&
    status.path === "workers_ai"
  );
}

/** The page header's mark: the microphone is open. */
export function VoiceHeaderMark(
  props: Readonly<{ session: VoiceSession }>,
): React.ReactNode {
  const status = useVoiceStatus(props.session);
  return voiceIsListening(status) ? (
    <span
      className="voice-header-mark"
      role="img"
      aria-label="Voice control is listening"
    >
      <Mic aria-hidden="true" size={15} />
    </span>
  ) : null;
}

/** The microphone mark on a spoken message in the timeline. */
export function VoiceMessageMark(
  props: Readonly<{
    spoken: Readonly<{
      path: ChatTranscriptionPath;
      engine: VoiceEngineId | null;
    }>;
  }>,
): React.ReactNode {
  const { path, engine } = props.spoken;
  const where =
    path === "shop_mac"
      ? "Spoken command, transcribed on the shop Mac"
      : "Spoken command, transcribed in the cloud";
  // A message from before Plan 82C names no engine.
  const label =
    engine === null ? where : `${where} by ${VOICE_ENGINES[engine].label}`;
  return (
    <span
      className="voice-message-mark"
      role="img"
      aria-label={label}
      title={label}
    >
      <Mic aria-hidden="true" size={13} />
    </span>
  );
}

/** The chat panel's control: the microphone button, its state and the voice dialog. */
export function VoiceControl(props: Props): React.ReactNode {
  const { session } = props;
  const status = useVoiceStatus(session);
  const [open, setOpen] = React.useState(false);
  const [askAccess, setAskAccess] = React.useState(false);
  const blockedByPolicy =
    status.kind === "blocked" && status.reason === "voice_disabled";

  React.useEffect(() => {
    void session.resume();
  }, [session]);
  React.useEffect(() => {
    if (blockedByPolicy) setAskAccess(true);
  }, [blockedByPolicy]);

  const text = statusText(status);
  return (
    <>
      {status.kind === "needs_tap" ? (
        <button
          type="button"
          className="voice-tap"
          onClick={() => void session.tap()}
        >
          Tap to start voice control
        </button>
      ) : null}
      {text === null ? null : (
        <div
          className="voice-status"
          data-state={status.kind}
          aria-live="polite"
        >
          {text}
          {usesCloud(status) ? (
            <span
              className="voice-cloud"
              title="The next command goes to the transcription service, because the Mac in the shop does not answer."
            >
              Cloud
            </span>
          ) : null}
        </div>
      )}
      <button
        type="button"
        className="voice-toggle"
        data-state={status.kind}
        aria-label="Voice control"
        aria-haspopup="dialog"
        title="Voice control"
        onClick={() => setOpen(true)}
      >
        <Mic aria-hidden="true" size={17} />
      </button>
      {/* The composer is a form, and its rules and submit reach all inside it. */}
      {createPortal(
        <div onSubmit={stopSubmit}>
          <VoiceDialog
            {...props}
            open={open}
            status={status}
            close={() => setOpen(false)}
          />
          {askAccess ? (
            <VoiceAccessPrompt {...props} close={() => setAskAccess(false)} />
          ) : null}
        </div>,
        document.body,
      )}
    </>
  );
}

type DialogStatus = Readonly<{
  tone: VoiceDot;
  text: string;
}>;

/** What the dialog says about this device. The composer's line says what to do now. */
function dialogStatus(status: VoiceStatus): DialogStatus | null {
  switch (status.kind) {
    case "off":
      return null;
    case "starting":
      return { tone: "wait", text: "Starting voice control…" };
    case "listening":
    case "capturing":
    case "transcribing":
      return {
        tone: "ready",
        text:
          status.path === "shop_mac"
            ? "On. Commands go to the Mac in the shop."
            : "On. Commands go to the transcription service.",
      };
    case "needs_tap":
      return { tone: "wait", text: "On. The browser needs one tap to start." };
    case "blocked":
      return {
        tone: "problem",
        text:
          status.reason === "failed"
            ? "Voice control stopped."
            : (statusText(status) ?? ""),
      };
  }
}

function VoiceDialog(
  props: Props &
    Readonly<{ open: boolean; status: VoiceStatus; close: () => void }>,
): React.ReactNode {
  const { session, status, open, organisationId } = props;
  const dialog = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const [view, setView] = React.useState<"main" | "shop_mac">("main");
  const [microphones, setMicrophones] = React.useState<
    readonly MediaDeviceInfo[]
  >([]);
  const [microphone, setMicrophone] = React.useState<string | null>(
    chosenMicrophone(),
  );
  const shopMacs = useShopMacs(organisationId, open);
  const on = status.kind !== "off" && voiceControlIsOn(organisationId);
  const talkKey = voiceTalkKeyName();
  const close = () => {
    setView("main");
    props.close();
  };

  React.useEffect(() => {
    syncDialog(dialog, open);
    if (!open) return;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) =>
        setMicrophones(
          devices.filter((device) => device.kind === "audioinput"),
        ),
      );
  }, [open, status.kind]);
  // The button that opened this view is gone, so focus moves with the view.
  React.useEffect(() => {
    if (!open) return;
    dialog.current?.scrollTo({ top: 0 });
    dialog.current
      ?.querySelector<HTMLElement>("[data-voice-view-focus]")
      ?.focus({ preventScroll: true });
  }, [view]);

  const microphoneLabelId = React.useId();
  const microphoneValueId = React.useId();
  const microphoneOptions = [
    { id: "", label: "Default microphone" },
    ...microphones
      .filter(
        (device) => device.deviceId !== "" && device.deviceId !== "default",
      )
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label === "" ? `Microphone ${index + 1}` : device.label,
      })),
  ];
  const chooseMicrophone = (id: string) => {
    const value = id === "" ? null : id;
    setMicrophone(value);
    if (on) {
      session.close();
      void session.turnOn(value);
    }
  };
  const turnOn = () => {
    void session.turnOn(microphone);
    close();
  };

  return (
    <dialog
      ref={dialog}
      className="voice-dialog"
      aria-labelledby={titleId}
      onCancel={cancelDialog.bind(null, close)}
    >
      {view === "shop_mac" ? (
        <ShopMacView
          titleId={titleId}
          shopMacs={shopMacs}
          back={() => setView("main")}
          close={close}
        />
      ) : (
        <>
          <DialogHeading id={titleId} title="Voice control" close={close} />
          <VoiceDialogStatus status={status} on={on} />
          <p className="voice-lead">
            {talkKey === null
              ? 'Say "Hey Satyr", then your command.'
              : `Say "Hey Satyr", then your command. Or hold ${talkKey}, speak and release. This works while this page is in front.`}{" "}
            Voice control takes English commands.
          </p>
          {on ? (
            <details className="voice-terms-fold">
              <summary>How voice control handles audio</summary>
              <VoiceTerms />
            </details>
          ) : (
            <VoiceTerms />
          )}
          <div className="voice-microphone">
            <span id={microphoneLabelId}>Microphone</span>
            <ActionMenu
              className="voice-microphone-menu"
              label="Microphone"
              trigger={
                <button
                  type="button"
                  className="voice-microphone-trigger"
                  aria-labelledby={`${microphoneLabelId} ${microphoneValueId}`}
                >
                  <span id={microphoneValueId}>
                    {microphoneOptions.find(
                      (option) => option.id === (microphone ?? ""),
                    )?.label ?? "Default microphone"}
                  </span>
                  <ChevronDown aria-hidden="true" size={16} />
                </button>
              }
              sections={[
                {
                  id: "microphones",
                  items: microphoneOptions.map((option) => ({
                    id: option.id,
                    label: option.label,
                    icon:
                      option.id === (microphone ?? "") ? (
                        <Check />
                      ) : (
                        <span className="voice-microphone-mark" />
                      ),
                    onSelect: () => {
                      chooseMicrophone(option.id);
                    },
                  })),
                },
              ]}
            />
          </div>
          {shopMacs.macs === null ? null : (
            <ShopMacLink
              macs={shopMacs.macs}
              focus={view === "main"}
              open={() => setView("shop_mac")}
            />
          )}
          {on ? <VoiceDayNote /> : null}
          <VoiceWeekNote />
          <div className="voice-dialog-actions">
            {on ? (
              <button
                type="button"
                className="voice-secondary-button"
                onClick={() => void session.turnOff()}
              >
                Turn off
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={turnOn}>
                Turn on
              </button>
            )}
            {status.kind === "needs_tap" ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => void session.tap()}
              >
                Start
              </button>
            ) : null}
            {status.kind === "blocked" ? (
              <button type="button" className="primary-button" onClick={turnOn}>
                Try again
              </button>
            ) : null}
          </div>
        </>
      )}
    </dialog>
  );
}

function VoiceDialogStatus(
  props: Readonly<{ status: VoiceStatus; on: boolean }>,
): React.ReactNode {
  const line = props.on ? dialogStatus(props.status) : null;
  return line === null ? null : (
    <p className="voice-dialog-status" data-tone={line.tone} aria-live="polite">
      <span className="voice-dot" data-tone={line.tone} aria-hidden="true" />
      {line.text}
    </p>
  );
}

/** Many phrases almost heard mean that the device misses this person's wake phrase. */
function VoiceDayNote(): React.ReactNode {
  const counts = voiceCountsToday();
  if (counts.wakes + counts.nearWakes + counts.holds === 0) return null;
  return (
    <p className="voice-note" data-voice-day-note="">
      Today on this device: wake phrase heard {counts.wakes}, almost heard{" "}
      {counts.nearWakes}, key holds {counts.holds}.
    </p>
  );
}

const WEEK_DAYS = 7;

/** What each engine heard on this device, so that a manager can compare engines (Plan 82C Phase 3). */
function VoiceWeekNote(): React.ReactNode {
  const heard = voiceHeardLastDays(WEEK_DAYS);
  if (heard.length === 0) return null;
  const parts = heard.map(
    (total) =>
      `${VOICE_ENGINES[total.engine].label} ${total.path === "shop_mac" ? "on the shop Mac" : "in the cloud"}: ` +
      `${total.commands} ${total.commands === 1 ? "command" : "commands"}, ${total.noise} dropped as noise`,
  );
  return (
    <p className="voice-note" data-voice-week-note="">
      Last {WEEK_DAYS} days on this device: {parts.join("; ")}.
    </p>
  );
}

/** The disclosures that a person reads before voice control turns on. */
function VoiceTerms(): React.ReactNode {
  return (
    <ul className="voice-terms">
      <li>
        <Mic aria-hidden="true" size={16} />
        <span>
          The microphone stays open while voice control is on. Audio stays on
          this device until you say the wake phrase or hold the talk key.
        </span>
      </li>
      <li>
        <AudioLines aria-hidden="true" size={16} />
        <span>
          A command's audio goes to the Mac in the shop. If the Mac does not
          answer, the audio goes to the transcription service, and it can be
          processed outside the country. The text of a spoken answer also goes
          to the Mac, which reads it aloud and keeps nothing.
        </span>
      </li>
      <li>
        <Trash2 aria-hidden="true" size={16} />
        <span>
          Seams keeps no audio. The chat shows the text that the agent received.
        </span>
      </li>
      <li>
        <HardDriveDownload aria-hidden="true" size={16} />
        <span>
          This setting is for you on this device. Voice control downloads about
          17 MB of files to this device, and turning it off deletes them.
        </span>
      </li>
    </ul>
  );
}

function macsPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/voice/macs`;
}

/** A Mac request's answer. A lost connection stays a failure. */
async function macRequest(
  path: string,
  method: "GET" | "POST",
  payload?: unknown,
): Promise<Readonly<{ ok: boolean; status: number; body: unknown }>> {
  // Without a session Pantry refuses a change.
  if (method === "POST" && readCookie("satyr_control_csrf") === null)
    return { ok: false, status: 403, body: null };
  try {
    const body = await (method === "GET"
      ? controlRead(path)
      : controlWrite(path, "POST", payload));
    return { ok: true, status: 200, body };
  } catch (error) {
    if (error instanceof ControlApiError && error.status !== null)
      return { ok: false, status: error.status, body: error.details };
    throw error;
  }
}

/** `--code=` keeps a code that starts with "-" a value, not an option, for the Mac's parser. */
function installCommand(start: VoiceMacEnrollmentStart): string {
  const origin = window.location.origin;
  return `curl -fsSL ${origin}/shop-voice/install.sh | sh -s -- --origin ${origin} --organisation ${start.organisationId} --mac ${start.macId} --code=${start.code} --accept-letsencrypt-terms`;
}

/** A new Mac starts with the default engine (Plan 82C D2). */
const INSTALLED_ENGINE = VOICE_ENGINES[DEFAULT_MAC_VOICE_ENGINE];
/** Kokoro and its voice (`SPEECH_FILES` in `services/shop-voice/shop_voice/model_files.py`). */
const ANSWER_VOICE_BYTES = 92_886_853;

const INSTALL_DOWNLOAD = `After that, it downloads the ${INSTALLED_ENGINE.label} speech model and the answer voice (${((INSTALLED_ENGINE.macDownloadBytes + ANSWER_VOICE_BYTES) / 1e9).toFixed(1)} GB, ${INSTALLED_ENGINE.licence} and Apache-2.0 licences).`;

type VoiceDot = "ready" | "wait" | "problem" | "none";
type MacStatus = Readonly<{ tone: VoiceDot; text: string }>;

function macStatus(mac: VoiceMacView): MacStatus {
  if (mac.state === "pending")
    return { tone: "wait", text: "Waiting for the install" };
  if (mac.lastHeartbeatAt === null)
    return { tone: "wait", text: "Installed. No answer yet." };
  if (Date.now() - mac.lastHeartbeatAt > 3 * 60_000)
    return { tone: "problem", text: "Does not answer" };
  const engine = VOICE_ENGINES[mac.engine ?? DEFAULT_MAC_VOICE_ENGINE].label;
  if (mac.modelState === "downloading")
    return { tone: "wait", text: `Downloads ${engine}` };
  if (mac.modelState === "none" || mac.modelState === null)
    return { tone: "wait", text: `Waiting for ${engine}` };
  // The Mac keeps its engine until it has the files of the chosen one.
  if (macChangesEngine(mac))
    return {
      tone: "ready",
      text: `Ready with ${engine}. Downloads ${VOICE_ENGINES[mac.engineChoice].label}.`,
    };
  return { tone: "ready", text: `Ready with ${engine}` };
}

function macChangesEngine(mac: VoiceMacView): boolean {
  return mac.engine !== null && mac.engine !== mac.engineChoice;
}

/** The Mac is on its way, so its row changes soon. A heartbeat comes each minute. */
function macIsSettled(mac: VoiceMacView): boolean {
  const { tone } = macStatus(mac);
  return tone === "problem" || (tone === "ready" && !macChangesEngine(mac));
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

const MAC_POLL_SOON_MS = 5_000;
const MAC_POLL_SETTLED_MS = 30_000;

type ShopMacs = Readonly<{
  /** Null while the list has not loaded, and for a member who does not manage. */
  macs: readonly VoiceMacView[] | null;
  /** The command that the manager has now. It goes when the Mac uses its code. */
  install: VoiceMacEnrollmentStart | null;
  error: string | null;
  add: () => Promise<void>;
  revoke: (macId: string) => Promise<void>;
  chooseEngine: (macId: string, engine: VoiceEngineId) => Promise<void>;
}>;

/**
 * The manager's list of Macs, read again while the dialog is open. The state
 * lives with the dialog, so that a closed dialog does not lose the one-time code.
 */
function useShopMacs(organisationId: string, open: boolean): ShopMacs {
  const [listed, setListed] = React.useState<readonly VoiceMacView[] | null>(
    null,
  );
  const [started, setStarted] = React.useState<VoiceMacEnrollmentStart | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const latest = React.useRef(0);

  const load = React.useCallback(async () => {
    const request = ++latest.current;
    const response = await macRequest(macsPath(organisationId), "GET");
    // A member who does not manage the workspace gets a refusal: show nothing.
    if (!response.ok) return null;
    const macs = parseVoiceMacList(response.body)?.macs ?? [];
    if (request === latest.current) setListed(macs);
    return macs;
  }, [organisationId]);

  React.useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = (ms: number) => {
      timer = setTimeout(() => void read(), ms);
    };
    const read = async () => {
      if (document.visibilityState !== "visible") {
        next(MAC_POLL_SOON_MS);
        return;
      }
      try {
        const macs = await load();
        if (stopped || macs === null) return;
        const active = macs.filter((mac) => mac.state !== "revoked");
        next(
          active.every(macIsSettled) ? MAC_POLL_SETTLED_MS : MAC_POLL_SOON_MS,
        );
      } catch {
        if (!stopped) next(MAC_POLL_SETTLED_MS);
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load, open]);

  const add = async () => {
    setError(null);
    const response = await macRequest(macsPath(organisationId), "POST");
    const start = response.ok
      ? parseVoiceMacEnrollmentStart(response.body)
      : null;
    if (start === null) {
      setError(
        response.status === 503
          ? "This deployment has no voice name zone yet. Every command uses the transcription service."
          : "The Mac could not be added. Try again.",
      );
      return;
    }
    setStarted(start);
    await load();
  };
  const revoke = async (macId: string) => {
    setError(null);
    const response = await macRequest(
      `${macsPath(organisationId)}/${macId}/revoke`,
      "POST",
    );
    if (!response.ok) setError("The Mac could not be revoked. Try again.");
    await load();
  };
  const chooseEngine = async (macId: string, engine: VoiceEngineId) => {
    setError(null);
    const response = await macRequest(
      `${macsPath(organisationId)}/${macId}/engine`,
      "POST",
      { engine },
    );
    if (!response.ok)
      setError("The speech engine could not be changed. Try again.");
    await load();
  };

  const install =
    started !== null &&
    started.expiresAt > Date.now() &&
    listed?.some(
      (mac) => mac.macId === started.macId && mac.state === "pending",
    )
      ? started
      : null;
  return { macs: listed, install, error, add, revoke, chooseEngine };
}

/** The dialog's row for a manager. The list and the install are on their own view. */
function ShopMacLink(
  props: Readonly<{
    macs: readonly VoiceMacView[];
    focus: boolean;
    open: () => void;
  }>,
): React.ReactNode {
  const active = props.macs.filter((mac) => mac.state !== "revoked");
  const statuses = active.map(macStatus);
  const best =
    statuses.find((status) => status.tone === "ready") ?? statuses[0] ?? null;
  const prefix = active.length > 1 ? `${active.length} Macs. ` : "";
  return (
    <button
      type="button"
      className="voice-mac-link"
      data-voice-view-focus={props.focus ? "" : undefined}
      onClick={props.open}
    >
      <span className="voice-mac-link-icon" aria-hidden="true">
        <Laptop size={18} />
      </span>
      <span className="voice-mac-link-copy">
        <span>Shop Mac</span>
        <small>
          {best === null ? null : (
            <span
              className="voice-dot"
              data-tone={best.tone}
              aria-hidden="true"
            />
          )}
          {best === null ? "Not added" : `${prefix}${best.text}`}
        </small>
      </span>
      <ChevronRight aria-hidden="true" size={18} />
    </button>
  );
}

/** A manager adds and revokes the shop's Mac here. Other members do not see it. */
function ShopMacView(
  props: Readonly<{
    titleId: string;
    shopMacs: ShopMacs;
    back: () => void;
    close: () => void;
  }>,
): React.ReactNode {
  const { macs, install, error, add, revoke, chooseEngine } = props.shopMacs;
  const active = (macs ?? []).filter((mac) => mac.state !== "revoked");
  return (
    <>
      <div className="access35-dialog-heading">
        <div className="voice-view-title">
          <button
            type="button"
            className="icon-button"
            aria-label="Back to voice control"
            data-voice-view-focus=""
            onClick={props.back}
          >
            <ArrowLeft aria-hidden="true" size={18} />
          </button>
          <h2 id={props.titleId}>Shop Mac</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close voice control"
          onClick={props.close}
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <p className="voice-lead">
        A Mac with Apple silicon in the shop transcribes each command, so the
        audio stays in the shop. If there is no Mac, each command uses the
        transcription service.
      </p>
      {active.length === 0 ? null : (
        <ul className="voice-mac-list">
          {active.map((mac) => (
            <ShopMacRow
              key={mac.macId}
              mac={mac}
              hasCommand={install?.macId === mac.macId}
              revoke={revoke}
              chooseEngine={chooseEngine}
            />
          ))}
        </ul>
      )}
      {install === null ? (
        <button
          type="button"
          className={
            active.length === 0 ? "primary-button" : "voice-secondary-button"
          }
          data-voice-add=""
          onClick={() => void add()}
        >
          Add a shop Mac
        </button>
      ) : (
        <InstallSteps start={install} />
      )}
      {error === null ? null : (
        <p className="voice-error" role="alert">
          {error}
        </p>
      )}
      <p className="voice-note">Only owners and admins see this page.</p>
    </>
  );
}

function ShopMacRow(
  props: Readonly<{
    mac: VoiceMacView;
    hasCommand: boolean;
    revoke: (macId: string) => Promise<void>;
    chooseEngine: (macId: string, engine: VoiceEngineId) => Promise<void>;
  }>,
): React.ReactNode {
  const { mac, hasCommand, revoke, chooseEngine } = props;
  const [confirming, setConfirming] = React.useState(false);
  const status = macStatus(mac);
  const pending = mac.state === "pending";
  return (
    <li className="voice-mac-row">
      <div className="voice-mac-row-main">
        <span className="voice-mac-row-copy">
          <strong>{mac.hostname}</strong>
          <small>
            <span
              className="voice-dot"
              data-tone={status.tone}
              aria-hidden="true"
            />
            {status.text}
          </small>
        </span>
        {confirming ? null : (
          <button
            type="button"
            className="voice-text-button"
            onClick={() =>
              pending ? void revoke(mac.macId) : setConfirming(true)
            }
          >
            {pending ? "Remove" : "Revoke"}
          </button>
        )}
      </div>
      {mac.state === "enrolled" && mac.engines.length > 1 ? (
        <MacEngineChoice mac={mac} chooseEngine={chooseEngine} />
      ) : null}
      {pending && !hasCommand ? (
        <p className="voice-note">
          The install command shows one time and works for a short time. If you
          do not have it, remove this Mac and add it again.
        </p>
      ) : null}
      {confirming ? (
        <div className="voice-mac-confirm">
          <p>
            This Mac stops and deletes its model, certificate and credential
            within about one minute. To use it again, add it again.
          </p>
          <div className="voice-dialog-actions">
            <button
              type="button"
              className="voice-secondary-button"
              onClick={() => setConfirming(false)}
            >
              Keep this Mac
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void revoke(mac.macId)}
            >
              Revoke this Mac
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * A manager chooses the Mac's speech engine (Plan 82C D2). The Mac downloads a
 * new engine's files, keeps the old engine until then, and keeps the old files
 * for 14 days, so a change back needs no download.
 */
function MacEngineChoice(
  props: Readonly<{
    mac: VoiceMacView;
    chooseEngine: (macId: string, engine: VoiceEngineId) => Promise<void>;
  }>,
): React.ReactNode {
  const { mac, chooseEngine } = props;
  const items = mac.engines.map((engine) => ({
    value: engine,
    label: VOICE_ENGINES[engine].label,
  }));
  const chosen = VOICE_ENGINES[mac.engineChoice];
  const running = VOICE_ENGINES[mac.engine ?? DEFAULT_MAC_VOICE_ENGINE];
  return (
    <div className="voice-mac-engine">
      <span>Speech engine</span>
      <Select.Root
        items={items}
        value={mac.engineChoice}
        onValueChange={(engine) => {
          if (engine !== null && engine !== mac.engineChoice)
            void chooseEngine(mac.macId, engine);
        }}
      >
        <Select.Trigger size="sm" aria-label="Speech engine">
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>
          {items.map((item) => (
            <Select.Item key={item.value} value={item.value}>
              {item.label}
            </Select.Item>
          ))}
        </Select.Popup>
      </Select.Root>
      {macChangesEngine(mac) ? (
        <p className="voice-note">
          {`The Mac downloads ${chosen.label} (${gigabytes(chosen.macDownloadBytes)}, ${chosen.licence} licence) and then changes to it. It uses ${gigabytes(chosen.macMemoryBytes)} of memory. Until then, it uses ${running.label}.`}
        </p>
      ) : null}
    </div>
  );
}

/** Each flag and its value stay on one line when the command wraps. */
function commandParts(command: string): readonly string[] {
  return command.split(/ (?=--[a-z])/u);
}

function InstallSteps(
  props: Readonly<{ start: VoiceMacEnrollmentStart }>,
): React.ReactNode {
  const command = installCommand(props.start);
  const [copy, setCopy] = React.useState<"ready" | "copied" | "failed">(
    "ready",
  );
  const until = new Date(props.start.expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const copyCommand = () => {
    void navigator.clipboard.writeText(command).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };
  return (
    <div className="voice-install">
      <p>
        Run this command in Terminal on the Mac before {until}. It downloads
        about 0.7 GB now. {INSTALL_DOWNLOAD} It also accepts the Let's Encrypt
        subscriber agreement for the Mac's certificate.
      </p>
      <code>
        {commandParts(command).map((part, index) => (
          <React.Fragment key={part}>
            {index === 0 ? "" : " "}
            <span>{part}</span>
          </React.Fragment>
        ))}
      </code>
      <div className="voice-dialog-actions">
        <button type="button" className="primary-button" onClick={copyCommand}>
          {copy === "copied" ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <Copy aria-hidden="true" size={16} />
          )}
          <span aria-live="polite">
            {copy === "copied" ? "Copied" : "Copy command"}
          </span>
        </button>
      </div>
      {copy === "failed" ? (
        <p className="voice-error" role="alert">
          The browser did not copy the command. Select the command and copy it.
        </p>
      ) : null}
    </div>
  );
}

/** The Organisation's off switch is on: ask for it in place, not on the Access page. */
function VoiceAccessPrompt(
  props: Props & Readonly<{ close: () => void }>,
): React.ReactNode {
  const { access, organisationId, session, close } = props;
  const [authority, setAuthority] = React.useState<
    "loading" | "grant" | "explain"
  >("loading");
  const [pending, setPending] = React.useState<"allow" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let current = true;
    void access.read(organisationId, null, null).then((result) => {
      if (current)
        setAuthority(
          result.ok && mayEnableEvery(result.value, [VOICE_CAPABILITY])
            ? "grant"
            : "explain",
        );
    });
    return () => {
      current = false;
    };
  }, [access, organisationId]);

  const allow = async (): Promise<boolean> => {
    session.unlockSpeech();
    setPending("allow");
    setError(null);
    const failed = await enableCapabilities(access, organisationId, [
      VOICE_CAPABILITY,
    ]);
    setPending(null);
    if (failed !== null) {
      setError(failed);
      return false;
    }
    close();
    await session.turnOn(chosenMicrophone());
    return true;
  };
  const decline = () => {
    close();
    void session.turnOff();
  };
  const decision: PermissionRequestDecision =
    authority === "explain"
      ? {
          kind: "explain",
          message:
            "Ask an owner or admin of this workspace to allow voice control.",
          pending: null,
          error,
          primary: {
            label: "Check again",
            onSelect: () => {
              close();
              void session.turnOn(chosenMicrophone());
            },
          },
          secondary: { label: "Close", onSelect: decline },
        }
      : {
          kind: "grant",
          pending: authority === "loading" ? "allow" : pending,
          error,
          onAllow: allow,
          onDeny: decline,
        };
  return (
    <PermissionRequestDialog
      open={true}
      onClose={decline}
      requester={{ name: "Voice control", icon: <PantryMark /> }}
      target={{
        name: props.workspaceName,
        icon: <Mic aria-hidden="true" size={30} strokeWidth={1.5} />,
      }}
      title="Voice control would like to transcribe spoken commands"
      subtitle={
        authority === "explain"
          ? "Voice control is off for this workspace."
          : "Voice control is off for this workspace. Only allow this if you expected this request."
      }
      scope={null}
      listHeading="This will allow:"
      items={[
        {
          id: VOICE_CAPABILITY.capabilityId,
          label: VOICE_CAPABILITY.label,
          description: "Members can give the chat agent commands by voice.",
          required: true,
        },
      ]}
      selectedIds={[VOICE_CAPABILITY.capabilityId]}
      onSelectionChange={ignoreSelection}
      decision={decision}
      footnote={
        authority === "explain" ? null : (
          <>
            Allow turns this on for the whole workspace. You can turn it off in{" "}
            <a href={props.accessPath}>Access</a>.
          </>
        )
      }
      signedInAs={
        props.signedInAs === null
          ? null
          : { name: props.signedInAs, action: null }
      }
    />
  );
}

function ignoreSelection(): void {}

function stopSubmit(event: React.FormEvent): void {
  event.stopPropagation();
}
