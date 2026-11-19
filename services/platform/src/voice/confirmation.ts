import type { OrganisationDatabase } from "../database-handles";
import {
  isVoiceEngineId,
  normalizeVoicePhrase,
  type VoiceEngineId,
  type ChatTranscriptionPath,
  type VoiceConfirmation,
  type VoiceConfirmationCheck,
  type VoiceConfirmationReceipts,
  type VoiceConfirmationTarget,
} from "@purin-labs/control-api";

import type { OrganisationId, UserId } from "../ids";

/**
 * Spoken confirmation of approval cards (Plan 82 Phase 3). A receipt names the
 * host and the engine that heard the phrase (Plan 82C D4). The words of each
 * phrase passed 18 of 18 on real Whisper with six macOS voices, with no near
 * miss accepted. "approve change" passed 5 of 18, as "Approved Change".
 */
const PHRASE_HEAD: Readonly<Record<VoiceConfirmationTarget["kind"], string>> = {
  configuration_draft: "confirm change",
  slack_draft: "send message",
  email_draft: "send email",
};
/** "one", "two", "four" and "eight" sound like other words (the bench's rule). */
const DIGIT_WORDS = ["three", "five", "six", "seven", "nine"] as const;
const PHRASE_TTL_MS = 30 * 60_000;
const REFUSALS_BEFORE_NEW_PHRASE = 5;

function newPhrase(kind: VoiceConfirmationTarget["kind"]): string {
  const digits = Array.from(
    crypto.getRandomValues(new Uint8Array(3)),
    (byte) => DIGIT_WORDS[byte % DIGIT_WORDS.length],
  );
  return `${PHRASE_HEAD[kind]} ${digits.join(" ")}`;
}

type Member = Readonly<{
  organisationId: OrganisationId;
  userId: UserId;
  conversationId: string;
}>;

export async function issueVoiceConfirmation(
  db: OrganisationDatabase,
  input: Member & Readonly<{ target: VoiceConfirmationTarget; now: number }>,
): Promise<VoiceConfirmation> {
  const existing = await db
    .prepare(
      `SELECT confirmation_id, phrase, expires_at FROM voice_confirmation
        WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?
          AND target_kind = ? AND target_id = ? AND state = 'open' AND expires_at > ?
        LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.userId,
      input.conversationId,
      input.target.kind,
      input.target.id,
      input.now,
    )
    .first<{ confirmation_id: string; phrase: string; expires_at: number }>();
  if (existing !== null)
    return {
      confirmationId: existing.confirmation_id,
      phrase: existing.phrase,
      expiresAt: existing.expires_at,
    };
  const confirmation = {
    confirmationId: crypto.randomUUID(),
    phrase: newPhrase(input.target.kind),
    expiresAt: input.now + PHRASE_TTL_MS,
  };
  await db
    .prepare(
      `INSERT INTO voice_confirmation
         (confirmation_id, organisation_id, user_id, conversation_id, target_kind,
          target_id, phrase, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .bind(
      confirmation.confirmationId,
      input.organisationId,
      input.userId,
      input.conversationId,
      input.target.kind,
      input.target.id,
      confirmation.phrase,
      input.now,
      confirmation.expiresAt,
    )
    .run();
  return confirmation;
}

export async function checkVoiceConfirmation(
  db: OrganisationDatabase,
  input: Member &
    Readonly<{
      transcript: string;
      transcriptionPath: ChatTranscriptionPath;
      /** Null from a Portal tab from before Plan 82C. */
      transcriptionEngine: VoiceEngineId | null;
      now: number;
    }>,
): Promise<VoiceConfirmationCheck> {
  const open = await db
    .prepare(
      `SELECT confirmation_id, target_kind, target_id, phrase FROM voice_confirmation
        WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?
          AND state = 'open' AND expires_at > ?`,
    )
    .bind(input.organisationId, input.userId, input.conversationId, input.now)
    .all<{
      confirmation_id: string;
      target_kind: VoiceConfirmationTarget["kind"];
      target_id: string;
      phrase: string;
    }>();
  const spoken = normalizeVoicePhrase(input.transcript);
  const match = open.results.find(
    (row) => normalizeVoicePhrase(row.phrase) === spoken,
  );
  if (match !== undefined) {
    // The condition on the state spends the phrase once, for one approval.
    const spent = await db
      .prepare(
        `UPDATE voice_confirmation
            SET state = 'matched', matched_at = ?, transcription_path = ?,
                transcription_engine = ?
          WHERE confirmation_id = ? AND state = 'open'
          RETURNING confirmation_id`,
      )
      .bind(
        input.now,
        input.transcriptionPath,
        input.transcriptionEngine,
        match.confirmation_id,
      )
      .first();
    if (spent !== null)
      return {
        outcome: "matched",
        target: { kind: match.target_kind, id: match.target_id },
      };
    return { outcome: "refused" };
  }
  await db
    .prepare(
      `UPDATE voice_confirmation
          SET refused_attempts = refused_attempts + 1,
              state = CASE WHEN refused_attempts + 1 >= ? THEN 'spent' ELSE state END
        WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?
          AND state = 'open'`,
    )
    .bind(
      REFUSALS_BEFORE_NEW_PHRASE,
      input.organisationId,
      input.userId,
      input.conversationId,
    )
    .run();
  return { outcome: "refused" };
}

export async function readVoiceConfirmationReceipts(
  db: OrganisationDatabase,
  input: Member,
): Promise<VoiceConfirmationReceipts["receipts"]> {
  const rows = await db
    .prepare(
      `SELECT target_kind, target_id, phrase, transcription_path,
              transcription_engine, matched_at
         FROM voice_confirmation
        WHERE organisation_id = ? AND user_id = ? AND conversation_id = ?
          AND state = 'matched'
        ORDER BY matched_at`,
    )
    .bind(input.organisationId, input.userId, input.conversationId)
    .all<{
      target_kind: VoiceConfirmationTarget["kind"];
      target_id: string;
      phrase: string;
      transcription_path: ChatTranscriptionPath;
      transcription_engine: string | null;
      matched_at: number;
    }>();
  return rows.results.map((row) => ({
    target: { kind: row.target_kind, id: row.target_id },
    phrase: row.phrase,
    transcriptionPath: row.transcription_path,
    transcriptionEngine: isVoiceEngineId(row.transcription_engine)
      ? row.transcription_engine
      : null,
    matchedAt: row.matched_at,
  }));
}
