import type { VoiceMacView } from "@purin-labs/control-api";
import React from "react";
import { createRoot } from "react-dom/client";
import type {
  AccessControlView,
  AccessRouteTransport,
} from "@purin-labs/control-api/portal/access-models";
import { VoiceControl } from "@purin-labs/surface-voice/ui/features/voice/control";
import type {
  VoiceSession,
  VoiceStatus,
} from "@purin-labs/surface-voice/ui/features/voice/session";
import { usePortalTheme } from "@purin-labs/ui/use-portal-theme";
import "@purin-labs/surface-portal/ui/styles.css";
import "@purin-labs/surface-portal/ui/features/chat/styles.css";
import "./agent-components-preview.css";

/**
 * The voice dialog, its Shop Mac view and its access prompt, with no microphone
 * and no Platform. `status` picks the session's state, `macs` the manager's
 * list and `member=1` a refused list. `window.__voiceMacs` changes the list
 * while the dialog is open.
 */
const query = new URLSearchParams(window.location.search);
const organisationId = "organisation_preview";
const now = Date.now();

const STATUSES: Readonly<Record<string, VoiceStatus>> = {
  off: { kind: "off" },
  starting: { kind: "starting" },
  listening: { kind: "listening", path: "shop_mac" },
  cloud: { kind: "listening", path: "workers_ai" },
  hold: { kind: "capturing", path: "shop_mac", hold: true },
  tap: { kind: "needs_tap" },
  other_tab: { kind: "blocked", reason: "other_tab" },
  microphone: { kind: "blocked", reason: "microphone" },
  failed: { kind: "blocked", reason: "failed" },
  disabled: { kind: "blocked", reason: "voice_disabled" },
};

function mac(fields: Partial<VoiceMacView>): VoiceMacView {
  return {
    macId: "vmac_09040d6b8e664a59943bd001",
    hostname: "7c3e10ab52d9.voice.seams.sh",
    state: "enrolled",
    createdAt: now - 3_600_000,
    lastHeartbeatAt: now - 20_000,
    privateAddress: "192.168.1.20",
    serviceVersion: "1.0.0",
    modelState: "unloaded",
    engine: "whisper-large-v3-turbo",
    engines: ["whisper-large-v3-turbo", "qwen3-asr-1.7b"],
    engineChoice: "whisper-large-v3-turbo",
    ...fields,
  };
}

const LISTS: Readonly<Record<string, readonly VoiceMacView[]>> = {
  none: [],
  ready: [mac({})],
  changing: [mac({ modelState: "loaded", engineChoice: "qwen3-asr-1.7b" })],
  pending: [
    mac({
      state: "pending",
      lastHeartbeatAt: null,
      privateAddress: null,
      serviceVersion: null,
      modelState: null,
    }),
  ],
  downloading: [mac({ modelState: "downloading" })],
  silent: [mac({ lastHeartbeatAt: now - 3_600_000 })],
};

let macs: readonly VoiceMacView[] = LISTS[query.get("macs") ?? "none"] ?? [];
Object.assign(window, {
  __voiceMacs: (name: string) => {
    macs = LISTS[name] ?? [];
  },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The Portal sends a change only with a session's CSRF cookie, so the preview sets one.
document.cookie = "pantry_csrf=preview; path=/";

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = String(input);
  if (!path.includes("/voice/macs")) return realFetch(input, init);
  if (query.get("member") === "1") return json({ ok: false }, 403);
  if (path.endsWith("/revoke")) {
    const id = path.split("/").at(-2);
    macs = macs.filter((row) => row.macId !== id);
    return json({ ok: true, dnsRemoved: true });
  }
  if (path.endsWith("/engine")) {
    const id = path.split("/").at(-2);
    const { engine } = JSON.parse(String(init?.body)) as {
      engine: VoiceMacView["engineChoice"];
    };
    macs = macs.map((row) =>
      row.macId === id ? { ...row, engineChoice: engine } : row,
    );
    return json({ ok: true, engineChoice: engine });
  }
  if (init?.method !== "POST") return json({ macs });
  if (query.get("zone") === "none") return json({ ok: false }, 503);
  const macId = "vmac_09040d6b8e664a59943bd002";
  macs = [
    ...macs,
    mac({
      macId,
      hostname: "4f2a91c07de3.voice.seams.sh",
      state: "pending",
      createdAt: Date.now(),
      lastHeartbeatAt: null,
      privateAddress: null,
      serviceVersion: null,
      modelState: null,
    }),
  ];
  return json(
    {
      organisationId,
      macId,
      code: "previewCodeNotValid-previewCodeNotValid-000",
      expiresAt: Date.now() + 15 * 60_000,
    },
    201,
  );
};

/** The dialog needs the session's state and calls. A real one opens the microphone. */
function previewSession(): VoiceSession {
  let status = STATUSES[query.get("status") ?? "off"] ?? { kind: "off" };
  const key = `pantry.voice.on.${organisationId}`;
  if (status.kind === "off") localStorage.removeItem(key);
  else localStorage.setItem(key, "on");
  const listeners = new Set<() => void>();
  const set = (next: VoiceStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };
  const fake = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => status,
    resume: async () => undefined,
    unlockSpeech: () => undefined,
    close: () => undefined,
    tap: async () => set({ kind: "listening", path: "shop_mac" }),
    turnOn: async () => {
      localStorage.setItem(key, "on");
      set(
        query.get("policy") === "off"
          ? { kind: "blocked", reason: "voice_disabled" }
          : { kind: "listening", path: "shop_mac" },
      );
    },
    turnOff: async () => {
      localStorage.removeItem(key);
      set({ kind: "off" });
    },
  };
  return fake as unknown as VoiceSession;
}

const session = previewSession();

/** `role=member` reads no change action on the capability, so the prompt explains. */
const access: Pick<AccessRouteTransport, "read" | "mutate"> = {
  read: async () => ({
    ok: true,
    value: {
      revision: 1,
      capabilities: [
        {
          revision: 1,
          mode: "disabled",
          definition: {
            capabilityId: "voice.transcription",
            capabilityVersion: 1,
          },
          actions: {
            kind:
              query.get("role") === "member"
                ? "read_only"
                : "change_capability_mode",
          },
        },
      ],
    } as unknown as AccessControlView,
  }),
  mutate: async () => ({ ok: true }) as never,
};

function VoiceControlPreview(): React.ReactNode {
  usePortalTheme();
  return (
    <main className="agent-preview">
      <form
        className="chat-composer"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="chat-composer-surface">
          <VoiceControl
            session={session}
            organisationId={organisationId}
            workspaceName="Cafe Nini"
            signedInAs="Pta"
            accessPath="#access"
            access={access}
          />
          <textarea aria-label="Message" />
        </div>
      </form>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Voice control preview is development-only.");
createRoot(root).render(<VoiceControlPreview />);
