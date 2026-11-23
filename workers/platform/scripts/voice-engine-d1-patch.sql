-- Plan 82C Phase 1: the speech engine of each shop Mac and of each spoken
-- approval. Adds voice_mac.engine, which a Mac reports in its heartbeat, and
-- voice_confirmation.transcription_engine, which names the engine that heard a
-- matched phrase. Both are null for older rows: a Mac from before Plan 82C runs
-- Whisper. The columns hold no CHECK, because a new engine is one catalogue
-- entry (`packages/control-api/src/voice-engines.ts`) and needs no table
-- rebuild; the Platform parses each value at the boundary. Apply once to each
-- deployed regional database before the release that writes the columns.
ALTER TABLE voice_mac ADD COLUMN engine TEXT;
ALTER TABLE voice_confirmation ADD COLUMN transcription_engine TEXT;
