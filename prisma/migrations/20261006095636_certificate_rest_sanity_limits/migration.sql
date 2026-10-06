-- certificate_rest_sanity_limits
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CER-056 (D-133.3, resuelta por el autor el 05-10-2026)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Rechazar lo absurdo, no lo largo. Con CER-055 un error de tecleo —3 000
-- días, un inicio en 2062— se emitía con un aviso, y además bloqueaba por
-- solape futuras maternidades. El disparador vuelve a rechazar dos cosas, y
-- sólo esas:
--
--  · `medical_certificate_rest_at_most_365_days`: más de 365 días, contados
--    los dos extremos.
--  · `medical_certificate_rest_starts_within_a_year`: un inicio más de un año
--    (de calendario) antes o después del día de la atención en Ecuador.
--
-- Por debajo de esos topes, los límites de CER-055 siguen avisando y no
-- frenan. El resto del disparador es el de 20261005060500, sin cambios.
--
-- SIN DATOS QUE TOCAR: el disparador sólo corre al insertar (BEFORE INSERT),
-- así que no revalida ninguna fila guardada. Ensayada sobre
-- clinica_menos_preguntas_copia.
-- Después: pnpm migrations:check && pnpm db:deploy


CREATE OR REPLACE FUNCTION medical_certificate_issue_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attending     uuid;
  attention_day date;
  late_day      date;
  is_maternity  boolean;
  chart         uuid;
  current_chart uuid;
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
    -- CER-056 (D-133.3): lo que sólo puede ser un error de tecleo. Antes del
    -- candado: no depende de ninguna otra fila. El año es de calendario, como
    -- `addMonths` en el dominio (desde un 29 de febrero, el 28).
    IF NEW."rest_to" IS NOT NULL AND NEW."rest_to" - NEW."rest_from" + 1 > 365 THEN
      RAISE EXCEPTION 'medical_certificate_rest_at_most_365_days: a rest of more than 365 days is a typo'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'medical_certificate_rest_at_most_365_days';
    END IF;
    IF NEW."rest_from" < (attention_day - interval '1 year')::date
       OR NEW."rest_from" > (attention_day + interval '1 year')::date THEN
      RAISE EXCEPTION 'medical_certificate_rest_starts_within_a_year: a rest starting more than a year from its attention is a typo'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'medical_certificate_rest_starts_within_a_year';
    END IF;

    -- Nunca NULL: un NULL aquí saltaría las reglas de la maternidad.
    is_maternity := NEW."contingency_type" IS NOT DISTINCT FROM 'MATERNITY';

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
    -- detecta (40P01) y una de las dos falla con un 409 (`CONCURRENT_UPDATE`)
    -- que se repite a mano: no hay reintento automático.
    SELECT COALESCE(p."merged_into_id", p."id") INTO chart
      FROM "patient" p
     WHERE p."id" = NEW."patient_id";
    PERFORM pg_advisory_xact_lock(hashtextextended('medical_certificate_rest:' || chart::text, 0));
    -- PA-062: una fusión, y su deshacer, toman los candados de las dos fichas
    -- antes de cambiar el enlace. Si mientras se esperaba aquí cambió la
    -- ficha, se vuelve a leer y se toma también el candado de la nueva, hasta
    -- que no cambie: así se juzga la ficha que quedó, no la que había al
    -- llegar. Una emisión que ya tiene una ficha y espera otra puede chocar
    -- con una fusión o un deshacer que esperan la primera: PostgreSQL lo
    -- detecta (40P01) y una de las dos falla con un 409 (`CONCURRENT_UPDATE`)
    -- que se repite a mano: no hay reintento automático.
    LOOP
      SELECT COALESCE(p."merged_into_id", p."id") INTO current_chart
        FROM "patient" p
       WHERE p."id" = NEW."patient_id";
      EXIT WHEN current_chart = chart;
      chart := current_chart;
      PERFORM pg_advisory_xact_lock(hashtextextended('medical_certificate_rest:' || chart::text, 0));
    END LOOP;

    -- D-109 y D-110: lo que sigue rechazando en la maternidad, que no son
    -- límites sino coherencia (CER-049, CER-050). Con una fecha NULL estas
    -- comparaciones no rechazan; no hace falta un COALESCE: una maternidad sin
    -- sus tres fechas la para después el CHECK
    -- `medical_certificate_maternity_dates_together`.
    IF is_maternity THEN
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

