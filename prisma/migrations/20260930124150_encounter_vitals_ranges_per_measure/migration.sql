-- encounter_vitals_ranges_per_measure
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA (EN-062, D-058): que ninguna de las diez medidas del bloque D
-- se guarde fuera de su rango admisible. Antes sólo seis lo estaban: la
-- temperatura, las frecuencias cardiaca y respiratoria y los perímetros
-- cefálico y abdominal no tenían límite en ninguna parte, y 45 °C o 900 lpm se
-- guardaban.
--
-- EL CRITERIO NO CAMBIA, y es el de `20260806022956_clinical_core_constraints`:
-- rangos deliberadamente amplios. El objetivo es cazar el dedo que tecleó 750
-- en vez de 75, no discutir de fisiología con la clínica. Un CHECK demasiado
-- estricto acaba desactivado, y entonces no protege nada. Por eso 25 °C y 300
-- lpm entran: la hipotermia profunda y la taquicardia del neonato son lecturas
-- reales (D-058, opción A).
--
-- POR QUÉ UNA RESTRICCIÓN POR MEDIDA Y NO UNA SOLA. `encounter_vitals_ranges`
-- era un único CHECK con todas las condiciones unidas por AND, y PostgreSQL
-- sólo dice el NOMBRE de la restricción que falló. El valor que la hizo fallar
-- viaja en `detail` —«Failing row contains (…)»—, que `database-problem.ts`
-- no lee jamás porque es la fila entera del paciente. Con un solo nombre, el
-- 422 `VITALS_OUT_OF_RANGE` no podía decir CUÁL casilla estaba mal, que es lo
-- que el SPEC pide («por campo, señalando cuál»): la enfermera recibía
-- «alguno de los signos vitales está fuera de rango» y tenía que adivinar
-- entre diez. Una restricción por medida hace que el nombre sea la respuesta,
-- sin repetir los rangos en TypeScript.
--
-- Los nombres conservan el prefijo `encounter_vitals_ranges_`: quien busque la
-- restricción antigua encuentra las nuevas, y `encounter.constraints.ts` las
-- enumera todas con ese prefijo, cada una con el campo del DTO que señala.
--
-- UNA SOLA SENTENCIA `ALTER TABLE`, a propósito: quitar la antigua y poner las
-- nuevas es atómico. No hay un instante en que la tabla quede sin rangos.
--
-- LAS SEIS QUE YA EXISTÍAN SE AÑADEN VALIDADAS: toda fila escrita hasta hoy
-- cumplía `encounter_vitals_ranges`, que las contenía, así que comprobarlas
-- no puede fallar.
--
-- LAS CINCO NUEVAS VAN `NOT VALID`, por la misma razón que
-- `20260813054359_auth_user_cedula_check`, y no por comodidad. Se comprueban
-- en cada INSERT y en cada UPDATE desde este momento —que es lo que protege—,
-- y no obligan a que las filas ya escritas las cumplan: hasta hoy nada impedía
-- guardar 370 °C, y una instalación que lo hizo no puede quedarse sin poder
-- desplegar. La corrige desde la pantalla —el PUT de signos reescribe la fila
-- entera, y ese UPDATE sí pasa por aquí—, y cuando no quede ninguna,
-- `VALIDATE CONSTRAINT` las promueve sin bloquear escrituras.
ALTER TABLE encounter_vitals
  DROP CONSTRAINT IF EXISTS encounter_vitals_ranges,

  ADD CONSTRAINT encounter_vitals_ranges_weight_kg CHECK (
    weight_kg IS NULL OR weight_kg BETWEEN 0.3 AND 400
  ),
  ADD CONSTRAINT encounter_vitals_ranges_height_cm CHECK (
    height_cm IS NULL OR height_cm BETWEEN 20 AND 260
  ),
  ADD CONSTRAINT encounter_vitals_ranges_systolic_bp CHECK (
    systolic_bp IS NULL OR systolic_bp BETWEEN 40 AND 300
  ),
  ADD CONSTRAINT encounter_vitals_ranges_diastolic_bp CHECK (
    diastolic_bp IS NULL OR diastolic_bp BETWEEN 20 AND 200
  ),
  -- El único par entre los rangos: 80/120 no es una tensión baja, son dos
  -- casillas llenadas al revés.
  ADD CONSTRAINT encounter_vitals_ranges_systolic_above_diastolic CHECK (
    systolic_bp IS NULL OR diastolic_bp IS NULL OR systolic_bp > diastolic_bp
  ),
  ADD CONSTRAINT encounter_vitals_ranges_oxygen_saturation CHECK (
    oxygen_saturation IS NULL OR oxygen_saturation BETWEEN 30 AND 100
  ),

  -- D-058: las cinco que no tenían límite en ninguna parte.
  ADD CONSTRAINT encounter_vitals_ranges_temperature_c CHECK (
    temperature_c IS NULL OR temperature_c BETWEEN 25 AND 45
  ) NOT VALID,
  ADD CONSTRAINT encounter_vitals_ranges_heart_rate CHECK (
    heart_rate IS NULL OR heart_rate BETWEEN 20 AND 300
  ) NOT VALID,
  ADD CONSTRAINT encounter_vitals_ranges_respiratory_rate CHECK (
    respiratory_rate IS NULL OR respiratory_rate BETWEEN 4 AND 100
  ) NOT VALID,
  ADD CONSTRAINT encounter_vitals_ranges_head_circumference_cm CHECK (
    head_circumference_cm IS NULL OR head_circumference_cm BETWEEN 20 AND 80
  ) NOT VALID,
  ADD CONSTRAINT encounter_vitals_ranges_abdominal_circumference_cm CHECK (
    abdominal_circumference_cm IS NULL
    OR abdominal_circumference_cm BETWEEN 20 AND 250
  ) NOT VALID;
