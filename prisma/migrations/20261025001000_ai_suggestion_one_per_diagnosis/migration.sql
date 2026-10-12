-- ai_suggestion_one_per_diagnosis
--
-- AS-037 (D-245 §6). A diagnosis answers ONE proposal: two proposals linked to
-- the same diagnosis would count it twice in what phase F measures. Only the
-- diagnosis destination: a section of a note, a receta or an order may
-- legitimately be the record of several proposals (one per section or line).
CREATE UNIQUE INDEX "ai_suggestion_one_per_diagnosis"
  ON "ai_suggestion" ("encounter_diagnosis_id")
  WHERE "encounter_diagnosis_id" IS NOT NULL;
