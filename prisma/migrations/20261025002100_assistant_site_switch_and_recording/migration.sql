-- AS-160 (A3, D-254 §2). El asistente se enciende y se apaga por sede.
--
-- UNA SEDE NUEVA NACE APAGADA: P7 del plan del asistente, «cada función entra
-- apagada y se enciende por sede». `trg_site_parameter_defaults` crea la fila
-- de la sede nueva con el DEFAULT, así que basta con él.
--
-- LAS QUE YA EXISTEN QUEDAN ENCENDIDAS, como estaban hasta hoy (sólo con el
-- interruptor de la instalación), para no apagar la presentación. Es la
-- recomendación de D-254 §2, pendiente del autor: una instalación real migra
-- con ellas apagadas.
ALTER TABLE "site_parameter"
  ADD COLUMN "assistant_enabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "site_parameter" SET "assistant_enabled" = true;

-- AS-164 (D-221 §3, D-254 §3). Grabar la consulta para el asistente: una
-- autorización opcional más, sin canal. `patient_authorization_channel_
-- matches_purpose` ya exige canal sólo a REMINDERS y MARKETING, y
-- `trg_patient_authorization_one_standing` deja una vigente por persona.
ALTER TYPE "authorization_purpose" ADD VALUE 'ASSISTANT_RECORDING';
