-- certificate_maternity_d109
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--

-- QUÉ GARANTIZA (D-109, resuelta por el autor el 01-10-2026). D-108 quitó al
-- reposo de MATERNIDAD los topes de 3 y 8 días; sin otro límite era la vía
-- para un reposo retroactivo o encadenado sin fin. La licencia es de doce
-- semanas, 84 días:
--
--  · CER-046: ingreso y parto, como mucho 84 días antes de la atención.
--  · CER-047: el reposo termina, como tarde, el parto + 84 días, y no se emite
--    pasado ese día (con la madrugada de D-106 §5, como CER-045).
--  · CER-048: no se solapa con otro reposo no anulado de la paciente —su
--    ficha y las que absorbió—, de cualquier contingencia y atención, AL
--    EMITIR: una fusión posterior puede juntar reposos solapados (D-110 §7). Un candado por ficha ordena las
--    emisiones concurrentes desde atenciones distintas.
--  · CER-049: la atención tiene un diagnóstico CIE-10 obstétrico.
--  · La ventana de 3 días del prenatal (CER-044) no cambia (D-109 §4).
--
-- Sólo al insertar, como el resto de la función: la anulación es un UPDATE y
-- un reposo anulado deja libre su período. Los demás reposos no cambian.
-- Después: pnpm migrations:check && pnpm db:deploy


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
  chart         uuid;
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

    -- D-109: lo que acota la maternidad, una vez quitados los 3 y 8 días.
    IF is_maternity THEN
      -- CER-046: ingreso y parto, como mucho 84 días antes de la atención.
      -- Con una fecha NULL estas comparaciones no rechazan; no hace falta un
      -- COALESCE: una maternidad sin sus tres fechas la para después el CHECK
      -- `medical_certificate_maternity_dates_together`.
      IF NEW."maternity_admission_on" < attention_day - 84
         OR NEW."birth_on" < attention_day - 84 THEN
        RAISE EXCEPTION 'medical_certificate_maternity_dates_within_84_days: maternity admission and birth are at most 84 days before the attention'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'medical_certificate_maternity_dates_within_84_days';
      END IF;

      -- CER-047: dentro de la licencia (parto + 84 días), y emitido antes de
      -- que termine, con la madrugada de D-106 §5.
      IF NEW."rest_to" > NEW."birth_on" + 84 OR late_day > NEW."birth_on" + 84 THEN
        RAISE EXCEPTION 'medical_certificate_maternity_within_leave: a maternity rest ends, and is issued, within 84 days of the birth'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'medical_certificate_maternity_within_leave';
      END IF;

      -- CER-049: un diagnóstico obstétrico en la atención. El código, como
      -- lo escribe el catálogo: O00–O99 y Z34–Z39 con sus subcategorías; un
      -- capítulo («O00-O9A») no lo es.
      IF NOT EXISTS (
        SELECT 1
          FROM "encounter_diagnosis" d
         WHERE d."encounter_id" = NEW."encounter_id"
           AND d."cie10_code" ~ '^(O[0-9]{2}|Z3[4-9])[0-9A-Z]*$'
      ) THEN
        RAISE EXCEPTION 'medical_certificate_maternity_obstetric_diagnosis: a maternity rest needs an obstetric diagnosis on its encounter'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'medical_certificate_maternity_obstetric_diagnosis';
      END IF;

      -- CER-048: ningún otro reposo no anulado de la paciente en esos días,
      -- de cualquier atención. Dos atenciones bloquean dos filas distintas, así
      -- que las emisiones de la paciente se ordenan con este candado —la misma
      -- clave que toma el repositorio antes de leer sus reposos—: la segunda
      -- espera a que la primera confirme, y entonces la ve.
      -- Orden de candados: el repositorio bloquea la atención y luego la
      -- paciente; un INSERT directo toma la paciente aquí y la clave foránea de
      -- la atención después. Un INSERT por `psql` a la vez que una emisión por
      -- la API sobre la MISMA atención puede interbloquearse: PostgreSQL lo
      -- detecta (40P01) y una de las dos se reintenta.
      -- La paciente es su FICHA: la superviviente y las que absorbió (PA-055;
      -- no hay cadenas de fusión, PA-046). El candado, también por ficha.
      SELECT COALESCE(p."merged_into_id", p."id") INTO chart
        FROM "patient" p
       WHERE p."id" = NEW."patient_id";
      PERFORM pg_advisory_xact_lock(hashtextextended('medical_certificate_rest:' || chart::text, 0));
      IF EXISTS (
        SELECT 1
          FROM "medical_certificate" c
         -- El predicado de `chartScopeIds`: la clave primaria y el índice
         -- parcial `patient_absorbed_charts` dan las fichas, y el índice por
         -- `patient_id` sus certificados. Se evalúa con el candado puesto.
         WHERE c."patient_id" IN (SELECT p."id" FROM "patient" p
                                   WHERE p."id" = chart OR p."merged_into_id" = chart)
           AND c."type" = 'MEDICAL_REST'
           AND c."revoked_at" IS NULL
           AND daterange(c."rest_from", c."rest_to", '[]')
               && daterange(NEW."rest_from", NEW."rest_to", '[]')
      ) THEN
        -- 23P01, como un EXCLUDE: un conflicto (409), no un dato inválido.
        RAISE EXCEPTION 'medical_certificate_maternity_rest_no_overlap: a maternity rest does not overlap another rest of the patient'
          USING ERRCODE = 'exclusion_violation',
                CONSTRAINT = 'medical_certificate_maternity_rest_no_overlap';
      END IF;
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

