import {
  isConversationId,
  parseVoiceMacEngineChoice,
  parseVoiceConfirmationCheckRequest,
  parseVoiceConfirmationRequest,
  parseVoiceGrantRequest,
  VOICE_DEVICE_HEADER,
  VOICE_GRANT_TTL_MS,
  type VoiceConfirmation,
  type VoiceConfirmationCheck,
  type VoiceConfirmationReceipts,
  type VoiceGrant,
  type VoiceMacEnrollmentStart,
  type VoiceMacList,
  type VoiceTranscription,
  type VoiceVocabulary,
} from "@purin-labs/control-api";

import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../control/authorization";
import { controlError, controlJson } from "../control/http";
import type { Env } from "../env";
import { parseOrganisationId, type OrganisationId } from "../ids";
import { removeVoiceMacRecords, voiceMacHostname } from "./dns";
import {
  checkVoiceConfirmation,
  issueVoiceConfirmation,
  readVoiceConfirmationReceipts,
} from "./confirmation";
import { signVoiceGrant } from "./grant";
import {
  beginVoiceTranscription,
  chooseVoiceMacEngine,
  finishVoiceTranscription,
  isVoiceTranscriptionEnabled,
  listVoiceMacs,
  readAnsweringVoiceMac,
  revokeVoiceMac,
  startVoiceMacEnrollment,
} from "./store";
import { transcribeWithWorkersAi } from "./transcribe";
import { readVoiceVocabulary } from "./vocabulary";
import { readBoundedBody, readVoiceWav, VOICE_BODY_BYTE_LIMIT } from "./wav";

/** The fallback does not wait longer than this for the shop vocabulary. */
const VOCABULARY_WAIT_MS = 800;
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

export type VoiceRoute = Readonly<{
  kind: "voice";
  organisationId: OrganisationId;
  target:
    | Readonly<{
        kind:
          | "grants"
          | "transcriptions"
          | "vocabulary"
          | "macs"
          | "confirmations"
          | "confirmationCheck";
      }>
    | Readonly<{ kind: "macRevoke" | "macEngine"; macId: string }>;
}>;

/**
 *   POST /v1/control/organisations/:id/voice/grants
 *   POST /v1/control/organisations/:id/voice/transcriptions
 *   GET /v1/control/organisations/:id/voice/vocabulary
 *   GET, POST /v1/control/organisations/:id/voice/macs
 *   POST /v1/control/organisations/:id/voice/macs/:macId/revoke
 *   POST /v1/control/organisations/:id/voice/macs/:macId/engine
 *   GET, POST /v1/control/organisations/:id/voice/confirmations
 *   POST /v1/control/organisations/:id/voice/confirmations/check
 */
export function matchVoiceRoute(pathname: string): VoiceRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/voice\/(grants|transcriptions|vocabulary|macs|confirmations|confirmations\/check|macs\/(vmac_[a-f0-9]{24})\/(revoke|engine))$/u.exec(
      pathname,
    );
  if (match === null) return null;
  let organisationId;
  try {
    organisationId = parseOrganisationId(decodeURIComponent(match[1] ?? ""));
  } catch {
    return null;
  }
  if (!organisationId.ok) return null;
  const macId = match[3];
  const name = match[2];
  return {
    kind: "voice",
    organisationId: organisationId.value,
    target:
      macId !== undefined
        ? { kind: match[4] === "engine" ? "macEngine" : "macRevoke", macId }
        : name === "confirmations/check"
          ? { kind: "confirmationCheck" }
          : {
              kind: name as
                | "grants"
                | "transcriptions"
                | "vocabulary"
                | "macs"
                | "confirmations",
            },
  };
}

export async function handleVoiceRoute(
  request: Request,
  env: Env,
  route: VoiceRoute,
): Promise<Response> {
  const { target } = route;
  if (target.kind === "macs" && request.method === "GET") {
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "admin",
      false,
    );
    return authorized.ok ? listMacs(env, authorized) : authorized.response;
  }
  if (target.kind === "vocabulary") {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "operator",
      false,
    );
    return authorized.ok
      ? readVocabulary(env, authorized)
      : authorized.response;
  }
  if (target.kind === "confirmations" && request.method === "GET") {
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "operator",
      false,
    );
    return authorized.ok
      ? listReceipts(request, authorized)
      : authorized.response;
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const manages =
    target.kind === "macs" ||
    target.kind === "macRevoke" ||
    target.kind === "macEngine";
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    manages ? "admin" : "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  switch (target.kind) {
    case "grants":
      return issueGrant(request, env, authorized);
    case "transcriptions":
      return transcribe(request, env, authorized);
    case "confirmations":
      return issueConfirmation(request, authorized);
    case "confirmationCheck":
      return checkConfirmation(request, authorized);
    case "macs":
      return startEnrollment(env, authorized);
    case "macRevoke":
      return revoke(env, authorized, target.macId);
    case "macEngine":
      return chooseEngine(request, authorized, target.macId);
  }
}

async function issueGrant(
  request: Request,
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const db = authorized.executionScope.database;
  if (!(await isVoiceTranscriptionEnabled(db, authorized.organisationId)))
    return controlError("voice_disabled", 403);
  const body = parseVoiceGrantRequest(await request.json().catch(() => null));
  if (body === null) return controlError("voice_device_invalid", 400);
  const now = Date.now();
  const mac = await readAnsweringVoiceMac(db, authorized.organisationId, now);
  const hostname = mac === null ? null : voiceMacHostname(env, mac.nameId);
  if (mac === null || hostname === null)
    return controlJson({ mac: null } satisfies VoiceGrant);
  const expiresAt = now + VOICE_GRANT_TTL_MS;
  const grant = await signVoiceGrant(env.DATA_ENCRYPTION_ROOT, {
    version: 1,
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
    deviceId: body.deviceId,
    macId: mac.macId,
    expiresAt,
  });
  return controlJson({
    mac: {
      macId: mac.macId,
      origin: `https://${hostname}`,
      grant,
      expiresAt,
    },
  } satisfies VoiceGrant);
}

async function transcribe(
  request: Request,
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const db = authorized.executionScope.database;
  const { organisationId } = authorized;
  if (!(await isVoiceTranscriptionEnabled(db, organisationId)))
    return controlError("voice_disabled", 403);
  const deviceId = request.headers.get(VOICE_DEVICE_HEADER);
  if (deviceId === null || !DEVICE_PATTERN.test(deviceId))
    return controlError("voice_device_invalid", 400);
  const body = await readBoundedBody(request, VOICE_BODY_BYTE_LIMIT);
  if (body === null) return controlError("too_long", 413);
  const wav = readVoiceWav(body);
  if (wav.kind === "too_long") return controlError("too_long", 413);
  if (wav.kind === "invalid") return controlError("voice_audio_invalid", 400);

  const useId = crypto.randomUUID();
  const begun = await beginVoiceTranscription(db, {
    organisationId,
    userId: authorized.authenticated.session.userId,
    deviceId,
    useId,
    now: Date.now(),
  });
  if (!begun) return controlError("rate_limited", 429);

  const vocabulary = await Promise.race([
    readVoiceVocabulary(env, organisationId),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), VOCABULARY_WAIT_MS),
    ),
  ]);
  const text = await transcribeWithWorkersAi(env, body, vocabulary ?? []);
  await finishVoiceTranscription(db, {
    organisationId,
    useId,
    audioMilliseconds: text === null ? 0 : wav.audioMilliseconds,
    now: Date.now(),
  });
  if (text === null) return controlError("transcription_unavailable", 503);
  return controlJson({
    text: text.slice(0, 8000),
    audioSeconds: wav.audioMilliseconds / 1000,
  } satisfies VoiceTranscription);
}

/**
 * The shop vocabulary for the Portal's text check (Plan 82C D1), which drops
 * the list that an engine reads back on noise. The names are the ones that a
 * member reads from the viewer role up (`vocabulary.ts`), and this route asks
 * for the operator role, as the grant does. So a member gets no name that their
 * pages do not show. The Portal only compares a transcript with the names; it
 * shows them nowhere.
 */
async function readVocabulary(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const db = authorized.executionScope.database;
  if (!(await isVoiceTranscriptionEnabled(db, authorized.organisationId)))
    return controlError("voice_disabled", 403);
  const terms = await readVoiceVocabulary(env, authorized.organisationId);
  return terms === null
    ? controlError("voice_vocabulary_unavailable", 503)
    : controlJson({ terms: [...terms] } satisfies VoiceVocabulary);
}

/** The phrase of one approval card, for this member in this chat. */
async function issueConfirmation(
  request: Request,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const db = authorized.executionScope.database;
  if (!(await isVoiceTranscriptionEnabled(db, authorized.organisationId)))
    return controlError("voice_disabled", 403);
  const body = parseVoiceConfirmationRequest(
    await request.json().catch(() => null),
  );
  if (body === null || !isConversationId(body.conversationId))
    return controlError("voice_confirmation_invalid", 400);
  return controlJson(
    (await issueVoiceConfirmation(db, {
      organisationId: authorized.organisationId,
      userId: authorized.authenticated.session.userId,
      conversationId: body.conversationId,
      target: body.target,
      now: Date.now(),
    })) satisfies VoiceConfirmation,
  );
}

/**
 * A spoken confirmation. Only an exact match after normalization gives the
 * Portal the card to confirm, through the same route and authority as a click.
 * The transcript of a refusal is not stored.
 */
async function checkConfirmation(
  request: Request,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const db = authorized.executionScope.database;
  if (!(await isVoiceTranscriptionEnabled(db, authorized.organisationId)))
    return controlError("voice_disabled", 403);
  const body = parseVoiceConfirmationCheckRequest(
    await request.json().catch(() => null),
  );
  if (body === null || !isConversationId(body.conversationId))
    return controlError("voice_confirmation_invalid", 400);
  return controlJson(
    (await checkVoiceConfirmation(db, {
      organisationId: authorized.organisationId,
      userId: authorized.authenticated.session.userId,
      conversationId: body.conversationId,
      transcript: body.transcript,
      transcriptionPath: body.transcriptionPath,
      transcriptionEngine: body.transcriptionEngine ?? null,
      now: Date.now(),
    })) satisfies VoiceConfirmationCheck,
  );
}

async function listReceipts(
  request: Request,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const conversationId = new URL(request.url).searchParams.get(
    "conversationId",
  );
  if (conversationId === null || !isConversationId(conversationId))
    return controlError("voice_confirmation_invalid", 400);
  return controlJson({
    receipts: await readVoiceConfirmationReceipts(
      authorized.executionScope.database,
      {
        organisationId: authorized.organisationId,
        userId: authorized.authenticated.session.userId,
        conversationId,
      },
    ),
  } satisfies VoiceConfirmationReceipts);
}

async function listMacs(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const macs = await listVoiceMacs(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  return controlJson({
    macs: macs.flatMap(({ nameId, ...mac }) => {
      const hostname = voiceMacHostname(env, nameId);
      return hostname === null ? [] : [{ ...mac, hostname }];
    }),
  } satisfies VoiceMacList);
}

async function startEnrollment(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  // A Mac cannot get a name when this deployment has no voice zone.
  if (voiceMacHostname(env, "check") === null)
    return controlError("voice_dns_unavailable", 503);
  const started = await startVoiceMacEnrollment(
    authorized.executionScope.database,
    {
      organisationId: authorized.organisationId,
      userId: authorized.authenticated.session.userId,
      now: Date.now(),
    },
  );
  return controlJson(
    {
      organisationId: authorized.organisationId,
      ...started,
    } satisfies VoiceMacEnrollmentStart,
    201,
  );
}

/**
 * A manager chooses a Mac's speech engine (Plan 82C D2). The agent has no tool
 * for it: a change downloads up to 4.1 GB onto shop hardware and changes the
 * model that hears spoken approvals, so a person decides.
 */
async function chooseEngine(
  request: Request,
  authorized: AuthorizedOrganisationRequest,
  macId: string,
): Promise<Response> {
  const body = parseVoiceMacEngineChoice(
    await request.json().catch(() => null),
  );
  if (body === null) return controlError("voice_engine_invalid", 400);
  const chosen = await chooseVoiceMacEngine(
    authorized.executionScope.database,
    { organisationId: authorized.organisationId, macId, engine: body.engine },
  );
  switch (chosen) {
    case "chosen":
      return controlJson({ ok: true, engineChoice: body.engine });
    case "not_found":
      return controlError("voice_mac_not_found", 404);
    case "unsupported":
      return controlError("voice_engine_unsupported", 409);
  }
}

async function revoke(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  macId: string,
): Promise<Response> {
  const revoked = await revokeVoiceMac(authorized.executionScope.database, {
    organisationId: authorized.organisationId,
    macId,
    userId: authorized.authenticated.session.userId,
    now: Date.now(),
  });
  if (revoked === null) return controlError("voice_mac_not_found", 404);
  const hostname = voiceMacHostname(env, revoked.nameId);
  const dnsRemoved =
    hostname !== null && (await removeVoiceMacRecords(env, hostname));
  return controlJson({ ok: true, dnsRemoved });
}
