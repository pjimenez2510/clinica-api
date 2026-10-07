-- medical_certificate_frozen_patient_sex
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. CER-058 (D-171.2): EL CERTIFICADO CONGELA EL SEXO AL EMITIRSE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El 117 ya guardaba sus diagnósticos (CER-027) y los datos laborales
-- (CER-038), pero el sexo se leía vivo de la ficha: corregirla después
-- cambiaba, al volver a generar el PDF, un papel que el empleador o el IESS ya
-- tienen. Desde aquí el certificado copia al insertarse el sexo de la ficha
-- VIGENTE de su atención —la superviviente si la ficha se unificó con otra,
-- CER-057— y lo escribe la BASE, no quien emite. `medical_certificate_frozen`
-- (CER-011) compara la fila entera, así que la copia queda congelada sin tocar
-- ese disparador.
--
-- `NOT NULL DEFAULT 'UNKNOWN'` como `number`: el valor por defecto sólo deja a
-- Prisma omitir la columna; el disparador siempre lo pisa.
--
-- LOS YA EMITIDOS imprimieron el sexo que su ficha tenía al emitirse. Si se
-- corrigió DESPUÉS, `patient_change_history` guarda lo que decía antes
-- (PA-026): se rellena con el `value_before` de la primera corrección de sexo
-- posterior a la emisión; si no hubo ninguna, con el de hoy, que entonces es el
-- mismo. Es lo mejor que se sabe, no una garantía —ese histórico no es
-- inmutable—, y es lo mismo que hizo la orden
-- (`20261007223900_service_order_frozen_patient_sex`). La ficha es la del
-- certificado (`patient_id`), que es lo que el papel leía.
--
-- ⚠️ EL RELLENO APAGA `medical_certificate_frozen` Y SOLO ÉL, dentro de la
-- misma transacción explícita que lo vuelve a encender: un certificado
-- emitido no se reescribe nunca, y esta es la única escritura que lo hace,
-- sobre una columna que nace aquí. Si algo falla, no entra nada.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ORD-161 (D-171.3): LA ORDEN, EL SEXO DE LA FICHA VIGENTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La orden emitida en la atención de una ficha ya absorbida copiaba el sexo de
-- la absorbida, que ya no se corrige (PA-045), bajo el nombre de la vigente
-- que su PDF imprime ahora (DOC-117). Copia el de la vigente. Las órdenes ya
-- emitidas no se tocan: dicen lo que imprimieron.
BEGIN;

ALTER TABLE "medical_certificate"
  ADD COLUMN IF NOT EXISTS "patient_sex" "patient_sex" NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE "medical_certificate" DISABLE TRIGGER "medical_certificate_frozen";

UPDATE "medical_certificate" c
   SET "patient_sex" = COALESCE(
         (SELECT h.value_before::patient_sex
            FROM patient_change_history h
           WHERE h.patient_id = c.patient_id
             AND h.field = 'sex'
             AND h.changed_at > c.issued_at
             AND h.value_before IN ('MALE', 'FEMALE', 'INTERSEX', 'UNKNOWN')
           ORDER BY h.changed_at ASC, h.id ASC
           LIMIT 1),
         p.sex)
  FROM patient p
 WHERE p.id = c.patient_id;

ALTER TABLE "medical_certificate" ENABLE TRIGGER "medical_certificate_frozen";

-- Lo copia la BASE en la inserción, mande lo que mande quien emite. La ficha
-- es la de la atención (CER-001), y la vigente si se unificó: un nivel, nunca
-- una cadena (`trg_patient_merge_not_chained`, PA-046).
CREATE OR REPLACE FUNCTION medical_certificate_freeze_patient_sex()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.patient_sex := (SELECT COALESCE(survivor.sex, chart.sex)
                        FROM encounter e
                        JOIN patient chart ON chart.id = e.patient_id
                        LEFT JOIN patient survivor ON survivor.id = chart.merged_into_id
                       WHERE e.id = NEW.encounter_id);
  RETURN NEW;
END;
$$;

-- «a_» para correr antes que `medical_certificate_issue_rules` y
-- `medical_certificate_number_assigned` (orden alfabético).
DROP TRIGGER IF EXISTS "a_medical_certificate_freeze_patient_sex" ON "medical_certificate";
CREATE TRIGGER "a_medical_certificate_freeze_patient_sex"
  BEFORE INSERT ON "medical_certificate"
  FOR EACH ROW
  EXECUTE FUNCTION medical_certificate_freeze_patient_sex();

-- ORD-161. El resto es la función de
-- `20261007223900_service_order_frozen_patient_sex`.
CREATE OR REPLACE FUNCTION service_order_freeze_patient_sex()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ISSUED'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'ISSUED') THEN
    NEW.patient_sex := (SELECT COALESCE(survivor.sex, chart.sex)
                          FROM encounter e
                          JOIN patient chart ON chart.id = e.patient_id
                          LEFT JOIN patient survivor ON survivor.id = chart.merged_into_id
                         WHERE e.id = NEW.encounter_id);
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
