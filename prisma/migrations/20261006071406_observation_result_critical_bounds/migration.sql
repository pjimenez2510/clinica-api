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
-- LAS CORRECCIONES que la salida provisional mantuvo críticas.
--
-- Hasta hoy una corrección se clasificaba con los rangos de su día, salvo que
-- conservara crítico un valor igual o más extremo que uno que ya lo era
-- (`keepStandingCritical`, fix/examenes-criticos-d123). Esa fila lleva una
-- bandera que el umbral de su día NO explica: la explica el de la versión que
-- corrigió. Se le congela ése, que es lo que se le aplicó, y una corrección
-- futura comparará con él. Hasta que no quede ninguna: una cadena puede tener
-- varias.
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
  v_changed int;
BEGIN
  LOOP
    UPDATE observation_result r
       SET critical_low = prev.critical_low, critical_high = prev.critical_high
      FROM diagnostic_report dr
      JOIN observation_result prev ON prev.report_id = dr.supersedes_id
     WHERE dr.id = r.report_id
       AND prev.analyte_display = r.analyte_display
       AND prev.value_numeric IS NOT NULL
       AND r.value_numeric IS NOT NULL
       AND NOT pg_temp.d130_flag_agrees(r.value_numeric, r.abnormal_flag::text, r.critical_low, r.critical_high)
       AND pg_temp.d130_flag_agrees(r.value_numeric, r.abnormal_flag::text, prev.critical_low, prev.critical_high);
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    EXIT WHEN v_changed = 0;
  END LOOP;
END;
$$;

-- Ninguna bandera guardada cambia: si alguna fila no queda explicada por sus
-- límites, la migración se para aquí y dice cuántas, en vez de inventar un
-- umbral.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM observation_result r
   WHERE NOT pg_temp.d130_flag_agrees(r.value_numeric, r.abnormal_flag::text, r.critical_low, r.critical_high);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ORD-122: % resultados con una bandera que su umbral de entonces no explica', v_bad
      USING HINT = 'Revisar la vigencia de sus rangos (ORD-113) antes de reintentar; nada se ha escrito.';
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

COMMIT;
