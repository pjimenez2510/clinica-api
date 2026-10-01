-- certificate_maternity_d110
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--

-- QUÉ GARANTIZA (D-110, resuelta por el autor el 01-10-2026, PROVISIONAL
-- hasta que el IESS confirme el trámite de maternidad, D-105 §6). Cierra lo que
-- D-109 dejó abierto en el reposo de MATERNIDAD:
--
--  · CER-046: el parto, como mucho 84 días antes de la atención —el ingreso ya
--    no cuenta: rechazaba el último tramo de una licencia con ingreso antiguo—
--    y como mucho 28 días después: un parto prenatal declarado lejos daba
--    reposos mes a mes desde una sola consulta.
--  · CER-047: la licencia son doce semanas contando el día del parto; su último
--    día es parto + 83 (era + 84).
--  · CER-050: todas las maternidades no anuladas de la paciente comparten el
--    parto, salvo que disten más de 9 meses: un embarazo, un parto.
--  · CER-048: el solape en las dos direcciones: tampoco un reposo de otra
--    contingencia sobre una maternidad no anulada. El choque se corrige
--    anulando el anterior (D-110 §4). Por eso el candado de la ficha se toma
--    ahora para todo reposo.
--
-- Sólo al insertar, como el resto de la función. Lo de la fusión de fichas que
-- junta reposos solapados (D-110 §7) sigue pendiente.
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

    -- La paciente es su FICHA: la superviviente y las que absorbió (PA-055;
    -- no hay cadenas de fusión, PA-046). Dos atenciones bloquean dos filas
    -- distintas, así que las emisiones de reposo de la ficha se ordenan con
    -- este candado —la misma clave que toma el repositorio antes de leer sus
    -- reposos—: la segunda espera a que la primera confirme, y entonces la ve.
    -- Desde D-110 §5, para todo reposo: también el general mira las
    -- maternidades. Orden de candados: el repositorio bloquea la atención y
    -- luego la ficha; un INSERT directo toma la ficha aquí y la clave foránea
    -- de la atención después. Un INSERT por `psql` a la vez que una emisión por
    -- la API sobre la MISMA atención puede interbloquearse: PostgreSQL lo
    -- detecta (40P01) y una de las dos se reintenta.
    SELECT COALESCE(p."merged_into_id", p."id") INTO chart
      FROM "patient" p
     WHERE p."id" = NEW."patient_id";
    PERFORM pg_advisory_xact_lock(hashtextextended('medical_certificate_rest:' || chart::text, 0));

    -- D-109 y D-110: lo que acota la maternidad, una vez quitados los 3 y 8
    -- días. Con una fecha NULL estas comparaciones no rechazan; no hace falta
    -- un COALESCE: una maternidad sin sus tres fechas la para después el CHECK
    -- `medical_certificate_maternity_dates_together`.
    IF is_maternity THEN
      -- CER-046 (D-110 §3): el parto, como mucho 84 días antes de la atención.
      -- El ingreso no cuenta.
      IF NEW."birth_on" < attention_day - 84 THEN
        RAISE EXCEPTION 'medical_certificate_maternity_dates_within_84_days: a maternity birth is at most 84 days before the attention'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'medical_certificate_maternity_dates_within_84_days';
      END IF;
      -- CER-046 (D-110 §1): y como mucho 4 semanas después.
      IF NEW."birth_on" > attention_day + 28 THEN
        RAISE EXCEPTION 'medical_certificate_maternity_birth_within_4_weeks: a maternity birth is at most four weeks after the attention'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'medical_certificate_maternity_birth_within_4_weeks';
      END IF;

      -- CER-047 (D-110 §6): doce semanas contando el día del parto, el último
      -- es parto + 83; y emitido antes de que termine, con la madrugada.
      IF NEW."rest_to" > NEW."birth_on" + 83 OR late_day > NEW."birth_on" + 83 THEN
        RAISE EXCEPTION 'medical_certificate_maternity_within_leave: a maternity rest ends, and is issued, by the 84th day counting the birth'
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

      -- CER-050 (D-110 §2): un embarazo, un parto. Otra maternidad no anulada
      -- de la ficha con otro parto a 9 meses de calendario o menos. Un conflicto
      -- con lo ya emitido: 23P01 (409).
      IF EXISTS (
        SELECT 1
          FROM "medical_certificate" c
         WHERE c."patient_id" IN (SELECT p."id" FROM "patient" p
                                   WHERE p."id" = chart OR p."merged_into_id" = chart)
           AND c."type" = 'MEDICAL_REST'
           AND c."contingency_type" = 'MATERNITY'
           AND c."revoked_at" IS NULL
           AND c."birth_on" <> NEW."birth_on"
           -- Desde los DOS partos: el recorte de fin de mes hace asimétrico
           -- «9 meses después» (31-08 − 9 = 30-11, pero 30-11 + 9 = 30-08), y
           -- el resultado no puede depender de cuál se emitió antes.
           AND (c."birth_on" BETWEEN (NEW."birth_on" - interval '9 months')::date
                                 AND (NEW."birth_on" + interval '9 months')::date
                OR NEW."birth_on" BETWEEN (c."birth_on" - interval '9 months')::date
                                      AND (c."birth_on" + interval '9 months')::date)
      ) THEN
        RAISE EXCEPTION 'medical_certificate_maternity_same_birth: the maternity rests of one pregnancy share the birth'
          USING ERRCODE = 'exclusion_violation',
                CONSTRAINT = 'medical_certificate_maternity_same_birth';
      END IF;
    END IF;

    -- CER-048 (D-110 §5): una maternidad no pisa ningún reposo no anulado de
    -- la ficha, y ningún reposo pisa una maternidad no anulada. Dos reposos de
    -- otras contingencias, sí: nadie decidió lo contrario. Con el fin antes
    -- del inicio no hay período que juzgar: `daterange` fallaría (22000) antes
    -- de que `medical_certificate_rest_range` diga por qué.
    IF NEW."rest_to" >= NEW."rest_from" AND EXISTS (
      SELECT 1
        FROM "medical_certificate" c
       -- El predicado de `chartScopeIds`: la clave primaria y el índice
       -- parcial `patient_absorbed_charts` dan las fichas, y el índice por
       -- `patient_id` sus certificados. Se evalúa con el candado puesto.
       WHERE c."patient_id" IN (SELECT p."id" FROM "patient" p
                                 WHERE p."id" = chart OR p."merged_into_id" = chart)
         AND c."type" = 'MEDICAL_REST'
         AND c."revoked_at" IS NULL
         AND (is_maternity OR c."contingency_type" = 'MATERNITY')
         AND daterange(c."rest_from", c."rest_to", '[]')
             && daterange(NEW."rest_from", NEW."rest_to", '[]')
    ) THEN
      -- 23P01, como un EXCLUDE: un conflicto (409), no un dato inválido.
      RAISE EXCEPTION 'medical_certificate_maternity_rest_no_overlap: a maternity rest and another rest of the patient do not overlap'
        USING ERRCODE = 'exclusion_violation',
              CONSTRAINT = 'medical_certificate_maternity_rest_no_overlap';
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

