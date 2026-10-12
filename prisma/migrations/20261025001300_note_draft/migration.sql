-- note_draft
--
-- C2 (PLAN-ASISTENTE-IA §7). Each draft of the consultation note asked for,
-- by the stretch of the transcript it covers. The draft's sections are
-- proposals in `ai_suggestion` (AS-090); this table only says which stretch
-- was asked for, by whom, and how it ended. No text (AS-095): the failure is
-- a code.
CREATE TABLE "note_draft" (
  "id"           UUID         NOT NULL DEFAULT uuidv7(),
  "encounter_id" UUID         NOT NULL,
  -- The end of the last segment the draft reads, in the listening's clock.
  "up_to_ms"     INTEGER      NOT NULL,
  "status"       VARCHAR(16)  NOT NULL,
  "failure_code" VARCHAR(64),
  "requested_by" UUID         NOT NULL,
  -- The attempt that answered (AS-020): the proposals cite the same one.
  "ai_run_id"    UUID,
  -- The application's clock, never now() (the e2e move it).
  "requested_at" TIMESTAMPTZ(6) NOT NULL,
  "started_at"   TIMESTAMPTZ(6),
  "finished_at"  TIMESTAMPTZ(6),
  CONSTRAINT "note_draft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "note_draft_encounter_id_fkey" FOREIGN KEY ("encounter_id")
    REFERENCES "encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "note_draft_requested_by_fkey" FOREIGN KEY ("requested_by")
    REFERENCES "app_user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "note_draft_ai_run_id_fkey" FOREIGN KEY ("ai_run_id")
    REFERENCES "ai_run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- AS-086. The same words are never drafted twice: a failed stretch is put
  -- back in the queue, not asked for again.
  CONSTRAINT "note_draft_once_per_stretch" UNIQUE ("encounter_id", "up_to_ms"),
  CONSTRAINT "note_draft_stretch_positive" CHECK ("up_to_ms" > 0),
  CONSTRAINT "note_draft_status_known"
    CHECK ("status" IS NOT NULL AND "status" IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
  -- AS-093. A failure always says why, and only a failure does.
  CONSTRAINT "note_draft_failure_has_code"
    CHECK (("status" = 'FAILED') = ("failure_code" IS NOT NULL)),
  CONSTRAINT "note_draft_timeline_coherent" CHECK (
    ("status" = 'QUEUED'  AND "started_at" IS NULL AND "finished_at" IS NULL AND "ai_run_id" IS NULL)
    OR ("status" = 'RUNNING' AND "started_at" IS NOT NULL AND "finished_at" IS NULL AND "ai_run_id" IS NULL)
    OR ("status" = 'DONE'    AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL AND "ai_run_id" IS NOT NULL)
    OR ("status" = 'FAILED'  AND "finished_at" IS NOT NULL)
  )
);

-- AS-086. One draft in flight per attention: a hesitant provider is never
-- asked twice for the same consultation (SigmAI R-02 was one for all).
CREATE UNIQUE INDEX "note_draft_one_in_flight" ON "note_draft" ("encounter_id")
  WHERE "status" IN ('QUEUED', 'RUNNING');
