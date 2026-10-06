-- patient_merge_reason_optional
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PA-064 (D-126): UNIFICAR Y DESHACER YA NO EXIGEN MOTIVO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta aquí fusionar y deshacer exigían un motivo escrito (PA-044, PA-047).
-- D-126 lo quita: la pantalla pide UNA confirmación con el resumen de quién
-- absorbe a quién, y el motivo es opcional, de una lista («Duplicado en
-- admisión», «Recién nacido registrado dos veces», «Otro»). Quién, cuándo y
-- la instantánea siguen siendo obligatorios: son el rastro, y lo pone el
-- sistema.
--
-- LO QUE SIGUE GARANTIZANDO LA BASE: un motivo, si lo hay, no está en blanco.
-- El MISMO nombre de constraint, porque es el que el contrato ya conoce.
--
-- NO SE TOCA NINGUNA FILA. Quitar un NOT NULL y sustituir un CHECK por otro
-- más laxo no reescribe nada: toda fila guardada tiene un motivo no en blanco,
-- y lo sigue teniendo. `patient_merge` sigue siendo de solo inserción.

ALTER TABLE "patient_merge"
  ALTER COLUMN "reason" DROP NOT NULL;

ALTER TABLE "patient_merge"
  DROP CONSTRAINT "patient_merge_reason_not_blank";

ALTER TABLE "patient_merge"
  ADD CONSTRAINT "patient_merge_reason_not_blank"
  CHECK ("reason" IS NULL OR length(btrim("reason")) > 0);

COMMENT ON CONSTRAINT "patient_merge_reason_not_blank" ON "patient_merge" IS
  'PA-064. El motivo de fusionar o deshacer es opcional; si lo hay, no en blanco.';
