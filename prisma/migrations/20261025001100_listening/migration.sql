-- listening
--
-- C1 (PLAN-ASISTENTE-IA §7). The listening of a consultation: its clock and
-- state (`listening_session`, one per attention) and the text it heard
-- (`transcript_segment`). The audio itself is stored nowhere (AS-053): neither
-- table has a binary column.

-- AS-049. The clock of the consultation, not of the connection: a pause, a
-- cut or a restart continue from `offset_ms`, never from zero.
CREATE TABLE "listening_session" (
  "encounter_id" UUID         NOT NULL,
  "state"        VARCHAR(16)  NOT NULL,
  "offset_ms"    INTEGER      NOT NULL DEFAULT 0,
  -- A code, never a sentence: it reaches logs and screens (AS-058).
  "reason"       VARCHAR(32),
  "device"       VARCHAR(80)  NOT NULL,
  "started_by"   UUID         NOT NULL,
  -- The application's clock, never now() (the e2e move it).
  "started_at"   TIMESTAMPTZ(6) NOT NULL,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "listening_session_pkey" PRIMARY KEY ("encounter_id"),
  CONSTRAINT "listening_session_encounter_id_fkey" FOREIGN KEY ("encounter_id")
    REFERENCES "encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "listening_session_started_by_fkey" FOREIGN KEY ("started_by")
    REFERENCES "app_user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "listening_session_state_known"
    CHECK ("state" IN ('LISTENING', 'PAUSED', 'STOPPED')),
  CONSTRAINT "listening_session_offset_non_negative" CHECK ("offset_ms" >= 0),
  -- AS-051, AS-055. Only a pause the physician did not ask for has a reason.
  CONSTRAINT "listening_session_reason_when_paused"
    CHECK ("reason" IS NULL
           OR ("state" = 'PAUSED'
               AND "reason" IN ('device-lost', 'recognizer-failed', 'store-failed')))
);

-- AS-052. What the recogniser confirmed, once. `UNIQUE (encounter_id,
-- start_ms)` is what makes a duplicated segment impossible: before E-031,
-- resuming in SigmAI rewrote the first half of the consultation.
CREATE TABLE "transcript_segment" (
  "id"           UUID         NOT NULL DEFAULT uuidv7(),
  "encounter_id" UUID         NOT NULL,
  "start_ms"     INTEGER      NOT NULL,
  "end_ms"       INTEGER      NOT NULL,
  "text"         TEXT         NOT NULL,
  -- The application's clock: the purge (AS-057) counts from it.
  "created_at"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "transcript_segment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transcript_segment_encounter_id_fkey" FOREIGN KEY ("encounter_id")
    REFERENCES "encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "transcript_segment_once" UNIQUE ("encounter_id", "start_ms"),
  CONSTRAINT "transcript_segment_start_non_negative" CHECK ("start_ms" >= 0),
  CONSTRAINT "transcript_segment_ends_after_start" CHECK ("end_ms" > "start_ms"),
  CONSTRAINT "transcript_segment_has_text"
    CHECK (length(btrim("text")) > 0 AND length("text") <= 4000)
);

-- AS-057. The purge reads by attention and by age.
CREATE INDEX "transcript_segment_created_at_idx" ON "transcript_segment" ("created_at");

-- AS-052. What was heard is not rewritten: the purge deletes, nothing updates.
CREATE OR REPLACE FUNCTION transcript_segment_is_kept_as_heard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'transcript_segment_is_kept_as_heard: a segment is never rewritten'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'transcript_segment_is_kept_as_heard';
END;
$$;

CREATE TRIGGER "transcript_segment_is_kept_as_heard"
  BEFORE UPDATE ON "transcript_segment"
  FOR EACH ROW EXECUTE FUNCTION transcript_segment_is_kept_as_heard();
