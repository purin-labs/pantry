/**
 * The voice settings that this browser keeps (Plan 82). The setting is for one
 * member's browser profile on one device. This module holds no voice code, so
 * the workspace frame can read the setting without the voice bundle.
 */

function onKey(organisationId: string): string {
  return `satyr.voice.on.${organisationId}`;
}

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // The setting then lasts only for this page.
  }
}

export function voiceControlIsOn(organisationId: string): boolean {
  return readStored(onKey(organisationId)) === "on";
}

export function rememberVoiceControl(
  organisationId: string,
  on: boolean,
): void {
  writeStored(onKey(organisationId), on ? "on" : null);
}
