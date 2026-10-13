-- listening_scope
--
-- B3 (AS-241, D-260 §1). The preparation is listened to with the same channel
-- as the consultation, by whoever prepares, before the consultation: its state
-- and its lines are kept apart from the consultation's, so the draft, the
-- questions and the signing review (which read the consultation, and were
-- measured on it) never see them. Every listening that exists is a
-- consultation's.

ALTER TABLE "listening_session"
  ADD COLUMN "scope" VARCHAR(16) NOT NULL DEFAULT 'CONSULTATION',
  ADD CONSTRAINT "listening_session_scope_known"
    CHECK ("scope" IN ('CONSULTATION', 'PREPARATION'));

-- One listening per attention AND scope.
ALTER TABLE "listening_session"
  DROP CONSTRAINT "listening_session_pkey",
  ADD CONSTRAINT "listening_session_pkey" PRIMARY KEY ("encounter_id", "scope");

ALTER TABLE "transcript_segment"
  ADD COLUMN "scope" VARCHAR(16) NOT NULL DEFAULT 'CONSULTATION',
  ADD CONSTRAINT "transcript_segment_scope_known"
    CHECK ("scope" IN ('CONSULTATION', 'PREPARATION'));

-- AS-052 per scope: each listening has its own clock, starting at zero.
ALTER TABLE "transcript_segment"
  DROP CONSTRAINT "transcript_segment_once",
  ADD CONSTRAINT "transcript_segment_once" UNIQUE ("encounter_id", "scope", "start_ms");
