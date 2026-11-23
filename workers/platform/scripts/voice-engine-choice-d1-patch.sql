-- Plan 82C Phase 2: a manager's choice of each shop Mac's speech engine. Adds
-- voice_mac.engines, the JSON array of engine ids that the Mac's service
-- reports in its heartbeat, and voice_mac.engine_choice, the engine that a
-- manager chose. Both are null for older rows: such a Mac runs only its
-- reported engine, and its choice is Whisper. The columns hold no CHECK,
-- because a new engine is one catalogue entry
-- (`packages/control-api/src/voice-engines.ts`); the Platform parses each value
-- at the boundary. Apply once to each deployed regional database before the
-- release that writes the columns.
ALTER TABLE voice_mac ADD COLUMN engines TEXT;
ALTER TABLE voice_mac ADD COLUMN engine_choice TEXT;
