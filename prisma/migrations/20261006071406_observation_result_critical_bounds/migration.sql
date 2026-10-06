-- observation_result_critical_bounds
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (orders/SPEC.md ORD-122, ORD-114; D-130.1, resuelta por el
-- autor: C).
--
-- Cada resultado numérico congela los límites CRÍTICOS con que se calculó su
-- bandera, como ya congela la referencia (ORD-037). «¿Qué umbral regía para
-- este paciente?» se lee en la fila, y una corrección compara con lo que se
-- aplicó al original. Y la base rechaza una bandera que sus límites no
-- explican: un CRITICAL_HIGH sin un límite alto por debajo del valor, o un
-- valor fuera de sus límites marcado como no crítico.
--
-- ⚠️ TODO EN UNA TRANSACCIÓN. PostgreSQL no envuelve la migración: sin el
-- BEGIN, un fallo a mitad del relleno dejaría las columnas creadas y medio
-- rellenas. Un fallo aquí deshace el archivo entero.
BEGIN;

ALTER TABLE "observation_result"
  ADD COLUMN IF NOT EXISTS "critical_low"  DECIMAL(18,6),
  ADD COLUMN IF NOT EXISTS "critical_high" DECIMAL(18,6);

-- ═════════════════════════════════════════════════════════════════════════════
-- EL RELLENO: el umbral que regía al registrar cada informe (ORD-113).
--
-- Se reconstruye con LA MISMA RESOLUCIÓN que calculó la bandera
-- (`criticalBounds`, ORD-036): por cada lado, el crítico más específico que
-- alcanza al paciente y tiene ese lado —sexo vale 2, edad 1—, desempatando en
-- el orden en que el código leía las filas (`ANALYTE_SELECT`).
--
--   · CUÁNDO: `diagnostic_report.created_at`, el instante del registro. Las
--     filas vigentes entonces: `valid_from <= t < valid_to`.
--   · A QUIÉN: el sexo de la ficha y `encounter.age_days`, LO MISMO que leyó
--     la clasificación. Que esa columna sea el resto de días de la edad y no
--     la edad en días es el fallo que corrige esta misma rama en el código;
--     aquí se congela lo que SE APLICÓ, que es lo que explica la bandera
--     guardada. (Ningún rango por edad existía en la base del autor.)
--   · QUÉ ANALITO: el que lleva el nombre congelado (ORD-031: la fila no
--     guarda su id), prefiriendo el del examen de su línea y el activo.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TEMPORARY TABLE "d130_applied" ON COMMIT DROP AS
SELECT r.id,
       (SELECT rr.low
          FROM analyte_reference_range rr
         WHERE rr.analyte_definition_id = x.analyte_id
           AND rr.range_kind = 'CRITICAL' AND rr.low IS NOT NULL
           AND rr.valid_from <= x.at AND (rr.valid_to IS NULL OR rr.valid_to > x.at)
           AND (rr.sex IS NULL OR rr.sex = x.sex)
           AND ((rr.age_min_days IS NULL AND rr.age_max_days IS NULL)
                OR (x.age_days IS NOT NULL
                    AND (rr.age_min_days IS NULL OR x.age_days >= rr.age_min_days)
                    AND (rr.age_max_days IS NULL OR x.age_days <= rr.age_max_days)))
         ORDER BY (CASE WHEN rr.sex IS NOT NULL THEN 2 ELSE 0 END
                   + CASE WHEN rr.age_min_days IS NOT NULL OR rr.age_max_days IS NOT NULL THEN 1 ELSE 0 END) DESC,
                  rr.sex ASC NULLS FIRST, rr.age_min_days ASC NULLS FIRST, rr.valid_from ASC
         LIMIT 1) AS low,
       (SELECT rr.high
          FROM analyte_reference_range rr
         WHERE rr.analyte_definition_id = x.analyte_id
           AND rr.range_kind = 'CRITICAL' AND rr.high IS NOT NULL
           AND rr.valid_from <= x.at AND (rr.valid_to IS NULL OR rr.valid_to > x.at)
           AND (rr.sex IS NULL OR rr.sex = x.sex)
           AND ((rr.age_min_days IS NULL AND rr.age_max_days IS NULL)
                OR (x.age_days IS NOT NULL
                    AND (rr.age_min_days IS NULL OR x.age_days >= rr.age_min_days)
                    AND (rr.age_max_days IS NULL OR x.age_days <= rr.age_max_days)))
         ORDER BY (CASE WHEN rr.sex IS NOT NULL THEN 2 ELSE 0 END
                   + CASE WHEN rr.age_min_days IS NOT NULL OR rr.age_max_days IS NOT NULL THEN 1 ELSE 0 END) DESC,
                  rr.sex ASC NULLS FIRST, rr.age_min_days ASC NULLS FIRST, rr.valid_from ASC
         LIMIT 1) AS high
  FROM observation_result r
  JOIN LATERAL (
    SELECT dr.created_at AS at, p.sex::text AS sex, e.age_days,
           (SELECT a.id
              FROM analyte_definition a
             WHERE a.name = r.analyte_display
             ORDER BY EXISTS (SELECT 1
                                FROM service_order_item i
                                JOIN exam_definition ed ON ed.code = i.test_code
                                JOIN exam_definition_analyte ea ON ea.exam_definition_id = ed.id
                               WHERE i.id = r.order_item_id
                                 AND ea.analyte_definition_id = a.id) DESC,
                      a.active DESC, a.created_at ASC
             LIMIT 1) AS analyte_id
      FROM diagnostic_report dr
      JOIN service_order so ON so.id = dr.service_order_id
      JOIN encounter e ON e.id = so.encounter_id
      JOIN patient p ON p.id = e.patient_id
     WHERE dr.id = r.report_id
  ) x ON true
 WHERE r.value_numeric IS NOT NULL;

UPDATE observation_result r
   SET critical_low = d.low, critical_high = d.high
  FROM d130_applied d
 WHERE d.id = r.id;

-- ═════════════════════════════════════════════════════════════════════════════
-- LAS CORRECCIONES: lo que habría congelado el código nuevo, si explica la
-- bandera que se guardó.
--
-- Una corrección se marca hoy con el límite MÁS PROTECTOR entre el congelado
-- en la versión que corrige y el vigente (ORD-114, D-135), y congela ése. Las
-- ya registradas se clasificaron de otra forma —con los rangos de su día, o
-- conservando crítico un valor igual o más extremo (`keepStandingCritical`,
-- fix/examenes-criticos-d123)—, y NINGUNA BANDERA GUARDADA CAMBIA aquí. Así
-- que, en orden de registro (una cadena puede tener varias), cada corrección
-- congela:
--
--   1. el más protector de su versión anterior y el de su día, si explica su
--      bandera: lo que el código nuevo habría congelado;
--   2. si no, el de la versión anterior, si la explica: la corrección que la
--      salida provisional mantuvo crítica;
--   3. si no, el de su día, que la explica (su bandera salió de él).
--
-- Los casos 2 y 3 son correcciones que con la regla de hoy se habrían marcado
-- distinto —un crítico que entonces no se marcó—. No se reescriben: se
-- anuncian por su id para que alguien las mire (D-138).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pg_temp.d130_flag_agrees(
  v numeric, flag text, lo numeric, hi numeric
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN v IS NULL THEN lo IS NULL AND hi IS NULL
           WHEN flag = 'CRITICAL_LOW'  THEN lo IS NOT NULL AND v < lo
           WHEN flag = 'CRITICAL_HIGH' THEN hi IS NOT NULL AND v > hi
           ELSE (lo IS NULL OR v >= lo) AND (hi IS NULL OR v <= hi)
         END
$$;

DO $$
DECLARE
  c record;
  v_low numeric;
  v_high numeric;
  v_differ bigint[] := '{}';
BEGIN
  FOR c IN
    SELECT r.id, r.value_numeric AS v, r.abnormal_flag::text AS flag,
           r.critical_low AS own_low, r.critical_high AS own_high,
           r.analyte_display, dr.supersedes_id
      FROM observation_result r
      JOIN diagnostic_report dr ON dr.id = r.report_id
     WHERE dr.supersedes_id IS NOT NULL
       AND r.value_numeric IS NOT NULL
     ORDER BY dr.created_at, r.id
  LOOP
    SELECT prev.critical_low, prev.critical_high INTO v_low, v_high
      FROM observation_result prev
     WHERE prev.report_id = c.supersedes_id
       AND prev.analyte_display = c.analyte_display
       AND prev.value_numeric IS NOT NULL
     LIMIT 1;
    CONTINUE WHEN NOT FOUND;  -- nueva en la corrección: rige su día

    -- GREATEST y LEAST ignoran NULL: un lado sin crítico toma el otro.
    IF pg_temp.d130_flag_agrees(c.v, c.flag, GREATEST(v_low, c.own_low), LEAST(v_high, c.own_high)) THEN
      UPDATE observation_result
         SET critical_low = GREATEST(v_low, c.own_low),
             critical_high = LEAST(v_high, c.own_high)
       WHERE id = c.id;
    ELSIF pg_temp.d130_flag_agrees(c.v, c.flag, v_low, v_high) THEN
      UPDATE observation_result
         SET critical_low = v_low, critical_high = v_high
       WHERE id = c.id;
      v_differ := v_differ || c.id;
    ELSE
      v_differ := v_differ || c.id;
    END IF;
  END LOOP;

  IF cardinality(v_differ) > 0 THEN
    RAISE NOTICE 'ORD-122, D-138: % correcciones se habrían marcado distinto con la regla de hoy (observation_result.id: %). Su bandera no se cambia.',
      cardinality(v_differ), v_differ;
  END IF;
END;
$$;

-- El analito se reconoce por el nombre (ORD-031). Si un resultado sin línea
-- tiene más de un analito con ese nombre, el umbral elegido puede ser el de
-- otro: se avisa por su id.
DO $$
DECLARE
  v_ambiguous bigint[];
BEGIN
  SELECT coalesce(array_agg(r.id), '{}') INTO v_ambiguous
    FROM observation_result r
   WHERE r.value_numeric IS NOT NULL
     AND r.order_item_id IS NULL
     AND (SELECT count(*) FROM analyte_definition a WHERE a.name = r.analyte_display) > 1;
  IF cardinality(v_ambiguous) > 0 THEN
    RAISE NOTICE 'ORD-122: % resultados sin línea con un nombre de analito repetido; revisar su umbral congelado (observation_result.id: %).',
      cardinality(v_ambiguous), v_ambiguous;
  END IF;
END;
$$;

-- Ninguna bandera guardada cambia: si alguna fila no queda explicada por sus
-- límites, la migración se para aquí y dice cuántas, en vez de inventar un
-- umbral.
DO $$
DECLARE
  v_bad bigint[];
BEGIN
  SELECT coalesce(array_agg(r.id), '{}') INTO v_bad
    FROM observation_result r
   WHERE NOT pg_temp.d130_flag_agrees(r.value_numeric, r.abnormal_flag::text, r.critical_low, r.critical_high);
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'ORD-122: % resultados con una bandera que su umbral de entonces no explica (observation_result.id: %)', cardinality(v_bad), v_bad
      USING HINT = 'Nada se ha escrito. Lo habitual: el informe es anterior a la vigencia de los rangos (20261005034644 fechó cada rango en su created_at) o su analito cambió de nombre. Consultar el historial del analito (ORD-114) y decidir con el autor qué umbral regía.';
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- ORD-122. La bandera y los límites congelados no se contradicen nunca.
-- Lo mismo que `d130_flag_agrees`, escrito sobre las columnas.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "observation_result"
  DROP CONSTRAINT IF EXISTS "observation_result_flag_agrees_with_critical_bounds";
ALTER TABLE "observation_result"
  ADD CONSTRAINT "observation_result_flag_agrees_with_critical_bounds"
  CHECK (
    CASE
      WHEN "value_numeric" IS NULL
        THEN "critical_low" IS NULL AND "critical_high" IS NULL
      WHEN "abnormal_flag" = 'CRITICAL_LOW'
        THEN "critical_low" IS NOT NULL AND "value_numeric" < "critical_low"
      WHEN "abnormal_flag" = 'CRITICAL_HIGH'
        THEN "critical_high" IS NOT NULL AND "value_numeric" > "critical_high"
      ELSE ("critical_low" IS NULL OR "value_numeric" >= "critical_low")
       AND ("critical_high" IS NULL OR "value_numeric" <= "critical_high")
    END
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- ORD-050, ORD-122. UN RESULTADO NO SE REESCRIBE NI SE BORRA (revisión clínica
-- de fix/criticos-d130). Sin esto, `UPDATE … SET critical_high = 500,
-- abnormal_flag = 'HIGH'` pasaba el CHECK y sacaba de la cola de críticos un
-- valor sin aviso ni rastro. Lo único que cambia en una fila es su línea, y
-- una sola vez: el emparejamiento a mano del resultado sin orden (ORD-040,
-- ORD-043). Una migración que rellene una columna nueva apagará este
-- disparador por su nombre, sólo dentro de su transacción.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION observation_result_is_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'observation_result_frozen: a result is corrected with a new report, never deleted'
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'ORD-050.';
  END IF;
  IF OLD.order_item_id IS NULL
     AND NEW.order_item_id IS NOT NULL
     AND (to_jsonb(NEW) - 'order_item_id') = (to_jsonb(OLD) - 'order_item_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'observation_result_frozen: a result is corrected with a new report, never rewritten'
    USING ERRCODE = 'integrity_constraint_violation', HINT = 'ORD-050, ORD-122; only an orphan is matched to its line (ORD-043).';
END;
$$;

DROP TRIGGER IF EXISTS "observation_result_frozen" ON "observation_result";
CREATE TRIGGER "observation_result_frozen"
  BEFORE UPDATE OR DELETE ON "observation_result"
  FOR EACH ROW
  EXECUTE FUNCTION observation_result_is_frozen();

COMMIT;
