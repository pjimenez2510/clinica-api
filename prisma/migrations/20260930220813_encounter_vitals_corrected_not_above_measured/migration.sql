-- encounter_vitals_corrected_not_above_measured
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA (EN-165, D-062 punto 3 B): la hemoglobina corregida por
-- altitud nunca es mayor que la medida. La corrección de la OMS 2024 —la que
-- el INEC adoptó para la ENDI— siempre resta, y al nivel del mar resta cero,
-- así que igual se admite. Una corregida mayor sólo sale de teclear las dos
-- cifras al revés, y en Quito eso oculta una anemia: el umbral de 11,0 g/dl se
-- compara con la cifra equivocada.
--
-- Si falta cualquiera de las dos no hay nada que comparar: la corregida sin
-- medida ya la rechaza `encounter_vitals_corrected_needs_hemoglobin`.
--
-- VALIDADA, no `NOT VALID` como las de D-058: mientras la atención está
-- abierta una toma se corrige (EN-143), y arrastrar el cruce dejaría una
-- anemia oculta en la historia. Las columnas nacen hoy y ninguna instalación
-- fuera de desarrollo tiene tomas. Una base con una fila que no cumple hace
-- fallar esta migración nombrando la restricción; si esa toma es de una
-- atención CERRADA, no se corrige desde la aplicación, y qué hacer (enmienda o
-- `NOT VALID`) es decisión clínica, no del despliegue.

ALTER TABLE "encounter_vitals"
  ADD CONSTRAINT "encounter_vitals_corrected_not_above_measured" CHECK (
    "hemoglobin_corrected_g_dl" IS NULL
    OR "hemoglobin_g_dl" IS NULL
    OR "hemoglobin_corrected_g_dl" <= "hemoglobin_g_dl"
  );
