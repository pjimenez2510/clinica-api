-- professional_voiceprint
--
-- AS-310 to AS-316 (E17, D-265 §1, LOPDP art. 26). The professional's
-- voiceprint, and who said each line of a listening.

-- AS-310, AS-312. One voiceprint per person: only the vector clinica-ai made
-- from their reading, never the recording. Biometric data: deleting it removes
-- the row, so no `record_version` trigger is attached and nothing copies it.
CREATE TABLE "professional_voiceprint" (
  "user_id"          UUID           NOT NULL,
  -- The voice model that made the vector; another model's is refused (CAI-019).
  "model"            VARCHAR(120)   NOT NULL,
  "dimension"        INTEGER        NOT NULL,
  "vector"           REAL[]         NOT NULL,
  "phrases"          INTEGER        NOT NULL,
  "seconds"          REAL           NOT NULL,
  -- AS-313. Off when the first voiceprint is registered; a new one keeps it.
  "attribution"      BOOLEAN        NOT NULL DEFAULT false,
  "consented_at"     TIMESTAMPTZ(6) NOT NULL,
  "updated_at"       TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "professional_voiceprint_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "professional_voiceprint_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "app_user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "professional_voiceprint_dimension_matches"
    CHECK ("dimension" BETWEEN 1 AND 4096
           AND array_ndims("vector") = 1
           AND cardinality("vector") = "dimension"),
  -- NaN and infinity are valid REAL values: a vector holding one compares as
  -- nothing, so it is refused here rather than at the first listening.
  CONSTRAINT "professional_voiceprint_vector_finite"
    CHECK (array_position("vector", 'NaN'::real) IS NULL
           AND array_position("vector", 'Infinity'::real) IS NULL
           AND array_position("vector", '-Infinity'::real) IS NULL
           AND array_position("vector", NULL) IS NULL),
  CONSTRAINT "professional_voiceprint_heard"
    CHECK ("phrases" > 0 AND "seconds" > 0)
);

-- AS-315, AS-316. Who said the line, and who said so. Both or neither: a
-- NULL inside `IN` would make the CHECK pass, so each case is spelled out.
ALTER TABLE "transcript_segment"
  ADD COLUMN "speaker"        VARCHAR(16),
  ADD COLUMN "speaker_source" VARCHAR(16),
  ADD CONSTRAINT "transcript_segment_speaker_known"
    CHECK (CASE WHEN "speaker" IS NULL THEN "speaker_source" IS NULL
                ELSE "speaker" IN ('PROFESSIONAL', 'PATIENT')
                     AND "speaker_source" IS NOT NULL
                     AND "speaker_source" IN ('MODEL', 'PROFESSIONAL')
           END);

-- AS-316, AS-317. A segment is still kept as heard: only its label and the
-- label's source may change, and a label given by hand stays the professional's. Every other column is compared, so a column added later
-- is protected unless it is named here.
CREATE OR REPLACE FUNCTION transcript_segment_is_kept_as_heard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'speaker' - 'speaker_source')
     IS DISTINCT FROM (to_jsonb(OLD) - 'speaker' - 'speaker_source') THEN
    RAISE EXCEPTION 'transcript_segment_is_kept_as_heard: a segment is never rewritten'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'transcript_segment_is_kept_as_heard';
  END IF;
  -- AS-317. What the professional said of a line, the model never takes back:
  -- once labelled by hand, the source stays the professional's.
  IF OLD."speaker_source" = 'PROFESSIONAL'
     AND NEW."speaker_source" IS DISTINCT FROM 'PROFESSIONAL' THEN
    RAISE EXCEPTION 'transcript_segment_label_by_hand_is_kept: a line labelled by hand stays so'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'transcript_segment_label_by_hand_is_kept';
  END IF;
  RETURN NEW;
END;
$$;
