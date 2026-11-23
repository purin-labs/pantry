import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { configuredOrganisationDatabases } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  forgetRevokedVoiceMacAddress,
  listRevokedVoiceMacNames,
  type RevokedVoiceMacName,
} from "./store";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const RECORD_TTL_SECONDS = 60;

type VoiceDns = Readonly<{ token: string; zoneId: string; zoneName: string }>;

function voiceDns(env: Env): VoiceDns | null {
  const token = env.VOICE_DNS_API_TOKEN?.trim();
  const zoneId = env.VOICE_DNS_ZONE_ID?.trim();
  const zoneName = env.VOICE_DNS_ZONE_NAME?.trim();
  return token && zoneId && zoneName ? { token, zoneId, zoneName } : null;
}

/** Each Mac's public name holds its private address (Plan 82 D8). */
export function voiceMacHostname(env: Env, nameId: string): string | null {
  const dns = voiceDns(env);
  return dns === null ? null : `${nameId}.voice.${dns.zoneName}`;
}

/** Only a private IPv4 address enters a Pantry zone. */
export function isPrivateVoiceAddress(address: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (match.slice(1).some((part) => String(Number(part)) !== part))
    return false;
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

async function zoneFetch(
  dns: VoiceDns,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${CLOUDFLARE_API}/zones/${dns.zoneId}/dns_records${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${dns.token}`,
      "content-type": "application/json",
    },
  });
}

async function recordIds(
  dns: VoiceDns,
  type: "A" | "TXT",
  name: string,
): Promise<readonly string[] | null> {
  const query = new URLSearchParams({ type, name });
  const response = await zoneFetch(dns, `?${query.toString()}`);
  if (!response.ok) return null;
  const body = (await response.json()) as Readonly<{
    result?: readonly Readonly<{ id?: unknown }>[];
  }>;
  return (body.result ?? []).flatMap((record) =>
    typeof record.id === "string" ? [record.id] : [],
  );
}

async function putRecord(
  env: Env,
  type: "A" | "TXT",
  name: string,
  content: string,
): Promise<boolean> {
  const dns = voiceDns(env);
  if (dns === null) return false;
  try {
    const existing = await recordIds(dns, type, name);
    if (existing === null) return false;
    const body = JSON.stringify({
      type,
      name,
      content,
      ttl: RECORD_TTL_SECONDS,
      ...(type === "A" ? { proxied: false } : {}),
    });
    const id = existing[0];
    const response = await zoneFetch(dns, id === undefined ? "" : `/${id}`, {
      method: id === undefined ? "POST" : "PUT",
      body,
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function removeRecords(
  env: Env,
  type: "A" | "TXT",
  name: string,
): Promise<boolean> {
  const dns = voiceDns(env);
  if (dns === null) return false;
  try {
    const existing = await recordIds(dns, type, name);
    if (existing === null) return false;
    const responses = await Promise.all(
      existing.map((id) => zoneFetch(dns, `/${id}`, { method: "DELETE" })),
    );
    return responses.every((response) => response.ok);
  } catch {
    return false;
  }
}

export const putVoiceMacAddress = (
  env: Env,
  hostname: string,
  address: string,
) => putRecord(env, "A", hostname, address);

export const putVoiceMacChallenge = (
  env: Env,
  hostname: string,
  value: string,
) => putRecord(env, "TXT", `_acme-challenge.${hostname}`, `"${value}"`);

export const removeVoiceMacChallenge = (env: Env, hostname: string) =>
  removeRecords(env, "TXT", `_acme-challenge.${hostname}`);

async function removeVoiceMacRecords(
  env: Env,
  hostname: string,
): Promise<boolean> {
  const [address, challenge] = await Promise.all([
    removeRecords(env, "A", hostname),
    removeVoiceMacChallenge(env, hostname),
  ]);
  return address && challenge;
}

/**
 * The names of an Organisation that has ended. A repeat finds nothing to remove.
 * True when no name remains, which includes a deployment with no voice zone.
 */
export async function removeVoiceMacNames(
  env: Env,
  nameIds: readonly string[],
): Promise<boolean> {
  const removed = await Promise.all(
    nameIds.map(async (nameId) => {
      const hostname = voiceMacHostname(env, nameId);
      return hostname === null || removeVoiceMacRecords(env, hostname);
    }),
  );
  return removed.every(Boolean);
}

/**
 * Removes the names of a revoked Mac. Its row forgets the private address only
 * when the names are gone, so a name that stays is tried again.
 */
export async function removeRevokedVoiceMacName(
  env: Env,
  db: OrganisationDatabase,
  mac: RevokedVoiceMacName,
): Promise<boolean> {
  const hostname = voiceMacHostname(env, mac.nameId);
  if (hostname === null || !(await removeVoiceMacRecords(env, hostname)))
    return false;
  await forgetRevokedVoiceMacAddress(db, mac);
  return true;
}

/**
 * The 15-minute run tries again each name that a revoke could not remove, in
 * each Organisation database, so the private address of a revoked Mac does not
 * stay in public DNS. With no voice zone it reads nothing, and with no such
 * name it writes nothing.
 */
export async function retryRevokedVoiceMacNames(env: Env): Promise<void> {
  if (voiceDns(env) === null) return;
  for (const db of configuredOrganisationDatabases(env))
    for (const mac of await listRevokedVoiceMacNames(db))
      await removeRevokedVoiceMacName(env, db, mac);
}
