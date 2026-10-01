-- certificate_d105
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (D-105, resuelta por el autor el 01-10-2026):
--
--  · CER-039: el 117 lo emite el profesional de la atención. Un tercero, sólo
--    con un motivo escrito que queda en la fila (`issued_by_other_reason`); y
--    quien atendió NO guarda ese motivo, que leído en su certificado diría que
--    no lo atendió.
--  · CER-041: el reposo empieza, como tarde, el día siguiente a la emisión. Un
--    reposo que empieza dentro de 90 días se aceptaba.
--  · CER-030, ampliado: el reposo pide motivo cuando empieza antes del día de
--    la atención O cuando se emite un día posterior al de la atención; sin
--    ninguno de los dos casos, no guarda motivo. La madrugada siguiente, hasta
--    las 06:00, cuenta como día de la atención (D-106 §5).
--  · CER-044 (D-106 §1): aun con motivo, el reposo empieza como mucho tres
--    días antes de la atención.
--  · CER-045 (D-106 §4): un reposo no se emite pasados ocho días de la
--    atención.
--
-- POR QUÉ UN DISPARADOR Y NO UN CHECK. Las tres reglas comparan la fila con
-- su atención —quién la atendió, qué día—, y un CHECK no puede leer otra
-- tabla. Antes de esto CER-030 lo garantizaba sólo el servicio; ahora también
-- lo para un import o un `psql`.
--
-- SÓLO AL INSERTAR. Son reglas de la emisión: las filas anteriores se
-- emitieron con las reglas de entonces y no se reescriben, y la anulación es
-- un UPDATE que no debe tropezar con ellas.
--
-- LAS FECHAS, EN ECUADOR. «El día de la atención» y «el día de la emisión»
-- son fechas de calendario en America/Guayaquil: un `::date` en el huso de la
-- sesión pasa una emisión de las 20:00 al día siguiente.

ALTER TABLE "medical_certificate"
  ADD COLUMN IF NOT EXISTS "issued_by_other_reason" TEXT;

-- Los dos motivos, con el mínimo del servicio (diez caracteres sin los
-- espacios de los extremos), también para un import o un `psql`: «x» no dice
-- nada. El nombre se conserva para el de retroactividad, que ya existía como
-- «no en blanco» y ahora pide lo mismo que el servicio.
ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_issuer_reason_not_blank";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_issuer_reason_not_blank" CHECK (
    "issued_by_other_reason" IS NULL
    OR char_length(btrim("issued_by_other_reason")) >= 10
  );
ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_backdating_reason_not_blank";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_backdating_reason_not_blank" CHECK (
    "rest_backdating_reason" IS NULL
    OR char_length(btrim("rest_backdating_reason")) >= 10
  );

CREATE OR REPLACE FUNCTION medical_certificate_issue_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attending     uuid;
  attention_day date;
  issue_day     date;
  late_day      date;
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

    -- CER-044 (D-106 §1): con motivo, como mucho tres días antes de la atención.
    IF NEW."rest_from" < attention_day - 3 THEN
      RAISE EXCEPTION 'medical_certificate_rest_starts_at_most_3_days_before: a rest starts at most three days before the attention'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'medical_certificate_rest_starts_at_most_3_days_before';
    END IF;

    -- CER-045 (D-106 §4): pasados ocho días de la atención, una atención nueva.
    IF late_day > attention_day + 8 THEN
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

DROP TRIGGER IF EXISTS "medical_certificate_issue_rules" ON "medical_certificate";
CREATE TRIGGER "medical_certificate_issue_rules"
  BEFORE INSERT ON "medical_certificate"
  FOR EACH ROW EXECUTE FUNCTION medical_certificate_issue_rules();
