-- BI-190, EN-189. Lo que se pregunta por atención y no tenía índice.
--
-- El recuento de antiguas sin cobrar (BI-190) se calcula en cada carga de caja
-- y no tiene techo: por cada atención pregunta si tiene certificado, referencia
-- o cuenta. `patient_account` sólo tenía el índice parcial de la cuenta abierta,
-- que no sirve para buscar la liquidada ni la anulada. El índice de
-- certificados sirve además a `encounter_diagnosis_retraction_needs_reason`.

CREATE INDEX IF NOT EXISTS "medical_certificate_encounter_id_idx"
  ON "medical_certificate" ("encounter_id");

CREATE INDEX IF NOT EXISTS "referral_encounter_id_idx"
  ON "referral" ("encounter_id");

CREATE INDEX IF NOT EXISTS "patient_account_encounter_id_status_idx"
  ON "patient_account" ("encounter_id", "status");
