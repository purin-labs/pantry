import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  parseVoiceMacChallenge,
  parseVoiceMacEnrollRequest,
  parseVoiceMacHeartbeat,
  type VoiceMacEnrollResponse,
  type VoiceMacHeartbeatAnswer,
  type VoiceVocabulary,
} from "@purin-labs/control-api";

import { controlError, controlJson } from "../control/http";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  isPrivateVoiceAddress,
  putVoiceMacAddress,
  putVoiceMacChallenge,
  removeVoiceMacChallenge,
  voiceMacHostname,
} from "./dns";
import { voiceMacGrantKey } from "./grant";
import {
  completeVoiceMacEnrollment,
  readVoiceMacByCredential,
  recordVoiceMacHeartbeat,
  type VoiceMac,
} from "./store";
import { readVoiceVocabulary } from "./vocabulary";

/**
 * The routes of a shop Mac (Plan 82), with no Portal session:
 *
 *   POST /v1/voice-macs/enroll              the one-time code, for a credential
 *   POST /v1/voice-macs/heartbeat           address, version and model state
 *   GET  /v1/voice-macs/vocabulary          the shop vocabulary
 *   PUT, DELETE /v1/voice-macs/certificate-challenge   the DNS-01 record
 *
 * The credential can do only these things. The Platform never calls the Mac.
 */
export async function handleVoiceMacRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const route = new URL(request.url).pathname.slice("/v1/voice-macs/".length);
  if (route === "enroll")
    return request.method === "POST"
      ? enroll(request, env)
      : controlError("method_not_allowed", 405);
  const caller = await authenticate(request, env);
  if (caller === null) return controlError("voice_mac_refused", 401);
  if (route === "heartbeat")
    return request.method === "POST"
      ? heartbeat(request, env, caller)
      : controlError("method_not_allowed", 405);
  if (route === "vocabulary")
    return request.method === "GET"
      ? vocabulary(env, caller)
      : controlError("method_not_allowed", 405);
  if (route === "certificate-challenge")
    return request.method === "PUT" || request.method === "DELETE"
      ? challenge(request, env, caller)
      : controlError("method_not_allowed", 405);
  return controlError("not_found", 404);
}

type MacCaller = Readonly<{
  organisationId: OrganisationId;
  database: OrganisationDatabase;
  mac: VoiceMac;
  hostname: string;
}>;

async function scopeDatabase(
  env: Env,
  organisationId: OrganisationId,
): Promise<OrganisationDatabase | null> {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  return scope.ok ? scope.value.database : null;
}

async function authenticate(
  request: Request,
  env: Env,
): Promise<MacCaller | null> {
  const match =
    /^Bearer svm1\.([A-Za-z0-9][A-Za-z0-9:_-]{0,127})\.(vmac_[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/u.exec(
      request.headers.get("authorization") ?? "",
    );
  if (match === null) return null;
  const organisationId = parseOrganisationId(match[1] ?? "");
  if (!organisationId.ok) return null;
  const database = await scopeDatabase(env, organisationId.value);
  if (database === null) return null;
  const mac = await readVoiceMacByCredential(database, {
    organisationId: organisationId.value,
    macId: match[2] ?? "",
    secret: match[3] ?? "",
  });
  if (mac === null) return null;
  const hostname = voiceMacHostname(env, mac.nameId);
  return hostname === null
    ? null
    : { organisationId: organisationId.value, database, mac, hostname };
}

async function enroll(request: Request, env: Env): Promise<Response> {
  const body = parseVoiceMacEnrollRequest(
    await request.json().catch(() => null),
  );
  if (body === null) return controlError("voice_mac_refused", 401);
  const organisationId = parseOrganisationId(body.organisationId);
  if (!organisationId.ok) return controlError("voice_mac_refused", 401);
  const database = await scopeDatabase(env, organisationId.value);
  if (database === null) return controlError("voice_mac_refused", 401);
  const enrolled = await completeVoiceMacEnrollment(database, {
    organisationId: organisationId.value,
    macId: body.macId,
    code: body.code,
    now: Date.now(),
  });
  if (enrolled === null) return controlError("voice_mac_refused", 401);
  const hostname = voiceMacHostname(env, enrolled.nameId);
  if (hostname === null) return controlError("voice_dns_unavailable", 503);
  return controlJson({
    credential: `svm1.${organisationId.value}.${body.macId}.${enrolled.secret}`,
    grantKey: await voiceMacGrantKey(env.DATA_ENCRYPTION_ROOT, body.macId),
    hostname,
  } satisfies VoiceMacEnrollResponse);
}

async function heartbeat(
  request: Request,
  env: Env,
  caller: MacCaller,
): Promise<Response> {
  const body = parseVoiceMacHeartbeat(await request.json().catch(() => null));
  if (body === null) return controlError("voice_mac_heartbeat_invalid", 400);
  // A public address here would point a Pantry name at any host.
  if (!isPrivateVoiceAddress(body.privateAddress))
    return controlError("voice_mac_address_refused", 400);
  const moved = body.privateAddress !== caller.mac.privateAddress;
  const placed =
    !moved ||
    (await putVoiceMacAddress(env, caller.hostname, body.privateAddress));
  const engineChoice = await recordVoiceMacHeartbeat(caller.database, {
    organisationId: caller.organisationId,
    macId: caller.mac.macId,
    heartbeat: body,
    privateAddress: placed ? body.privateAddress : null,
    now: Date.now(),
  });
  return placed
    ? controlJson({
        ok: true,
        hostname: caller.hostname,
        engineChoice,
      } satisfies VoiceMacHeartbeatAnswer)
    : controlError("voice_dns_unavailable", 503);
}

async function vocabulary(env: Env, caller: MacCaller): Promise<Response> {
  const terms = await readVoiceVocabulary(env, caller.organisationId);
  return terms === null
    ? controlError("voice_vocabulary_unavailable", 503)
    : controlJson({ terms: [...terms] } satisfies VoiceVocabulary);
}

async function challenge(
  request: Request,
  env: Env,
  caller: MacCaller,
): Promise<Response> {
  if (request.method === "DELETE")
    return (await removeVoiceMacChallenge(env, caller.hostname))
      ? controlJson({ ok: true })
      : controlError("voice_dns_unavailable", 503);
  const body = parseVoiceMacChallenge(await request.json().catch(() => null));
  if (body === null) return controlError("voice_mac_challenge_invalid", 400);
  return (await putVoiceMacChallenge(env, caller.hostname, body.value))
    ? controlJson({ ok: true })
    : controlError("voice_dns_unavailable", 503);
}
