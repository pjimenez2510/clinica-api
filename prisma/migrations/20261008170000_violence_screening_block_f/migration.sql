-- violence_screening_block_f
--
-- El tamizaje de violencia, bloque F del formulario 002 (EN-070 a EN-078,
-- REQ-025, REQ-115).
--
-- ⚠️ ES EL DATO MÁS SENSIBLE DEL EXPEDIENTE, y nada de eso se ve en el SQL: su
-- lectura exige `record:protected` además de `record:read`, se lee por UNA
-- ruta (`GET /encounters/:id/screening`) que deja su fila de bitácora, y
-- ningún listado, error ni log lo lleva. Quien añada esta tabla a otra lectura
-- estará quitando esa puerta sin que nada falle.
--
-- La tabla existe desde `20260806022931_clinical_core` y nadie escribía en
-- ella: ninguna fila que convertir, así que `NOT NULL` entra sin relleno.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. QUIÉN APLICÓ EL TAMIZAJE (EN-076)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Era nullable y sin clave foránea. `RESTRICT` por lo mismo que
-- `patient_merge.performed_by`: la pregunta que se hace doce meses después es
-- quién.
ALTER TABLE "violence_screening"
  ALTER COLUMN "screened_by_id" SET NOT NULL;

ALTER TABLE "violence_screening"
  ADD CONSTRAINT "violence_screening_screened_by_id_fkey"
  FOREIGN KEY ("screened_by_id") REFERENCES "practitioner"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. LA NOTIFICACIÓN A LA AUTORIDAD (EN-074)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Columnas 35 a 38 del instructivo, copiadas del formulario oficial de
-- notificación (Form. 094, D-052 §1). Listas cerradas y cortas: enum, no
-- catálogo. El número de serie es del formulario FÍSICO y viaja como texto.
CREATE TYPE "violence_injury" AS ENUM ('DAMAGE', 'ILLNESS', 'DISABILITY');
CREATE TYPE "aggressor_identified" AS ENUM ('YES', 'NO', 'UNKNOWN');
CREATE TYPE "aggressor_relationship" AS ENUM (
  'FRIEND', 'ACQUAINTANCE', 'STRANGER', 'RELATIVE', 'NEIGHBOUR', 'UNKNOWN'
);

ALTER TABLE "violence_screening"
  ADD COLUMN "authority_form_serial" VARCHAR(40),
  ADD COLUMN "injury" "violence_injury",
  ADD COLUMN "aggressor_identified" "aggressor_identified",
  ADD COLUMN "aggressor_relationship" "aggressor_relationship";

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. LO QUE EL TAMIZAJE NO PUEDE DECIR A LA VEZ
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EN-071. Positivo (sospecha o confirmado) ⇔ al menos un tipo. Un tamizaje
-- «sin signos» con tipos, o positivo sin ninguno, no se puede contar.
ALTER TABLE "violence_screening"
  ADD CONSTRAINT "violence_screening_types_iff_positive" CHECK (
    ("result" IN ('SUSPECTED', 'CONFIRMED'))
      = (COALESCE(cardinality("types"), 0) > 0)
  );

-- EN-077. Lo que se hizo ante un caso positivo es obligatorio, y sólo existe
-- si lo es: escrito sobre un «sin signos» no tiene a qué referirse.
ALTER TABLE "violence_screening"
  ADD CONSTRAINT "violence_screening_action_iff_positive" CHECK (
    ("result" IN ('SUSPECTED', 'CONFIRMED'))
      = ("action_taken" IS NOT NULL AND btrim("action_taken") <> '')
  );

-- EN-074. Sólo se notifica un caso positivo.
ALTER TABLE "violence_screening"
  ADD CONSTRAINT "violence_screening_report_needs_positive" CHECK (
    NOT "reported_to_authority" OR "result" IN ('SUSPECTED', 'CONFIRMED')
  );

-- EN-074. El bloque se llena sólo al notificar —«en caso contrario va en
-- blanco»— y, al notificar, entero: lo que se copia del formulario es todo o
-- nada.
ALTER TABLE "violence_screening"
  ADD CONSTRAINT "violence_screening_report_block_iff_reported" CHECK (
    CASE WHEN "reported_to_authority" THEN
      "authority_form_serial" IS NOT NULL AND btrim("authority_form_serial") <> ''
        AND "injury" IS NOT NULL
        AND "aggressor_identified" IS NOT NULL
        AND "aggressor_relationship" IS NOT NULL
    ELSE
      "authority_form_serial" IS NULL
        AND "injury" IS NULL
        AND "aggressor_identified" IS NULL
        AND "aggressor_relationship" IS NULL
    END
  );

COMMENT ON TABLE "violence_screening" IS
  'EN-070 a EN-078, REQ-025, REQ-115. Tamizaje de violencia, bloque F del 002. '
  'DATO DE ACCESO RESTRINGIDO: se lee sólo por GET /encounters/:id/screening '
  'con record:protected, con fila de bitácora; ningún listado ni log lo lleva. '
  'Sin fila = sin responder (la firma del alta lo rechaza, EN-240); '
  'NOT_APPLIED = «no se aplicó», respondido.';
