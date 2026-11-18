// A shop Mac in a journey (Plan 82): the Platform's DNS settings for Mac names,
// the Mac's own routes and its enrollment. The DNS API stand-in only answers; a
// journey that checks the records keeps its own recording stand-in.
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { isRecord } from "@seams/std";

import { PUBLIC_ORIGIN } from "./hibernatable-socket-support";
import { network } from "./network";

/** It returns the step that removes the settings again, for `afterEach`. */
export function installAnsweringVoiceDns(
  zoneId: string,
  zoneName: string,
): () => void {
  const settings = {
    VOICE_DNS_API_TOKEN: "dns-e2e-token",
    VOICE_DNS_ZONE_ID: zoneId,
    VOICE_DNS_ZONE_NAME: zoneName,
  };
  for (const [name, value] of Object.entries(settings))
    Object.defineProperty(env, name, { configurable: true, value });
  const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
  const answer = () => HttpResponse.json({ success: true, result: [] });
  const record = () =>
    HttpResponse.json({
      success: true,
      result: { id: crypto.randomUUID() },
    });
  network.use(
    http.get(base, answer),
    http.post(base, record),
    http.put(`${base}/:id`, record),
    http.delete(`${base}/:id`, record),
  );
  return () => {
    for (const name of Object.keys(settings)) Reflect.deleteProperty(env, name);
  };
}

/** A call of the Mac to its own routes, with its credential when it has one. */
export function voiceMacRequest(
  credential: string | null,
  route: string,
  method = "POST",
  body?: unknown,
): Promise<Response> {
  return exports.default.fetch(`${PUBLIC_ORIGIN}/v1/voice-macs/${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function readVoiceMacCredential(body: unknown): string {
  if (!isRecord(body) || typeof body.credential !== "string")
    throw new Error("No credential");
  return body.credential;
}

/** The Mac uses the one-time code of the enrollment that a manager started. */
export async function enrollVoiceMac(
  organisationId: string,
  macId: string,
  code: string,
): Promise<string> {
  const enrolled = await voiceMacRequest(null, "enroll", "POST", {
    organisationId,
    macId,
    code,
  });
  if (enrolled.status !== 200)
    throw new Error(`Enrollment refused: ${await enrolled.text()}`);
  return readVoiceMacCredential(await enrolled.json());
}
