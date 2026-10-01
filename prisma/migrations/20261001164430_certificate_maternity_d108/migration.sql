-- certificate_maternity_d108
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA (D-108, resuelta por el autor el 01-10-2026):
--
--  · CER-044: en un reposo de contingencia MATERNIDAD el inicio puede ser el
--    día del ingreso o el del parto, aunque sea más de tres días antes de la
--    atención; un día cualquiera entre ellos, no. La paciente que da a luz en
--    un hospital acude días después por su 117 desde el parto, y se rechazaba.
--    Los tres días se conservan también en la maternidad: el reposo prenatal,
--    con el ingreso aún por llegar, sigue como estaba (D-106 §2).
--  · CER-035: ingreso ≤ parto ≤ alta. Lo comprobaba sólo el servicio; ahora
--    que esas fechas deciden el inicio admitido, también la base. Cuán atrás
--    pueden estar es D-109, pendiente del autor.
--  · CER-045: el reposo de maternidad no tiene el plazo de ocho días para
--    emitirse: la licencia (doce semanas) encadena certificados (CER-043).
--  · Los demás reposos no cambian, y el motivo de CER-030 se sigue pidiendo.
--
-- Sólo se reescribe la función; el disparador de 20261001090000_certificate_d105
-- la llama por su nombre y no cambia.

CREATE OR REPLACE FUNCTION medical_certificate_issue_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attending     uuid;
  attention_day date;
  issue_day     date;
  late_day      date;
  is_maternity  boolean;
BEGIN
  SELECT e."practitioner_id",
         (e."started_at" AT TIME ZONE 'America/Guayaquil')::date
    INTO attending, attention_day
    FROM "encounter" e
   WHERE e."id" = NEW."encounter_id";
  -- Sin atención no hay regla que juzgar: la clave foránea la rechaza.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  issue_day := (NEW."issued_at" AT TIME ZONE 'America/Guayaquil')::date;
  -- D-106 §5: para juzgar si la emisión es tardía, la madrugada siguiente
  -- (hasta las 06:00 en Ecuador) cuenta como el día anterior.
  late_day := ((NEW."issued_at" AT TIME ZONE 'America/Guayaquil') - interval '6 hours')::date;

  -- CER-039.
  IF NEW."issued_by_id" <> attending AND NEW."issued_by_other_reason" IS NULL THEN
    RAISE EXCEPTION 'medical_certificate_issuer_reason_required: a certificate issued by someone other than the attending practitioner needs a reason'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'medical_certificate_issuer_reason_required';
  END IF;
  IF NEW."issued_by_id" = attending AND NEW."issued_by_other_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'medical_certificate_issuer_reason_only_for_others: the attending practitioner keeps no third-party reason'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'medical_certificate_issuer_reason_only_for_others';
  END IF;

  IF NEW."type" = 'MEDICAL_REST' AND NEW."rest_from" IS NOT NULL THEN
    -- CER-041.
    IF NEW."rest_from" > issue_day + 1 THEN
      RAISE EXCEPTION 'medical_certificate_rest_starts_by_next_day: a rest starts no later than the day after it is issued'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'medical_certificate_rest_starts_by_next_day';
    END IF;

    -- Nunca NULL: un NULL aquí saltaría el plazo de CER-045.
    is_maternity := NEW."contingency_type" IS NOT DISTINCT FROM 'MATERNITY';

    -- CER-044 (D-106 §1): con motivo, como mucho tres días antes de la atención.
    -- D-108: la maternidad, también el día del ingreso o el del parto. Una
    -- maternidad lleva siempre las dos fechas
    -- (`medical_certificate_maternity_dates_together`); aun así, el COALESCE
    -- hace que una fecha NULL no admita nada en lugar de saltarse la regla.
    IF NEW."rest_from" < attention_day - 3
       AND NOT (is_maternity
                AND COALESCE(NEW."rest_from" IN (NEW."maternity_admission_on", NEW."birth_on"), false)) THEN
      RAISE EXCEPTION 'medical_certificate_rest_starts_at_most_3_days_before: a rest starts at most three days before the attention'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'medical_certificate_rest_starts_at_most_3_days_before';
    END IF;

    -- CER-045 (D-106 §4): pasados ocho días de la atención, una atención nueva.
    -- D-108: la maternidad encadena certificados y no lleva ese plazo.
    IF NOT is_maternity AND late_day > attention_day + 8 THEN
      RAISE EXCEPTION 'medical_certificate_rest_issued_within_8_days: a rest is issued within eight days of the attention'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'medical_certificate_rest_issued_within_8_days';
    END IF;

    -- CER-030, con el día de la emisión de D-106 §5.
    IF (NEW."rest_from" < attention_day OR late_day > attention_day) THEN
      IF NEW."rest_backdating_reason" IS NULL THEN
        RAISE EXCEPTION 'medical_certificate_backdating_reason_required: a backdated or late rest needs a reason'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'medical_certificate_backdating_reason_required';
      END IF;
    ELSIF NEW."rest_backdating_reason" IS NOT NULL THEN
      RAISE EXCEPTION 'medical_certificate_backdating_reason_only_when_late: a rest issued on the day of the attention keeps no backdating reason'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'medical_certificate_backdating_reason_only_when_late';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- CER-035. Las fechas de maternidad, en orden. NULL pasa: que vayan las tres
-- juntas lo exige `medical_certificate_maternity_dates_together`.
ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_maternity_dates_in_order";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_maternity_dates_in_order" CHECK (
    "maternity_admission_on" <= "birth_on"
    AND "birth_on" <= "maternity_discharge_on"
  );
