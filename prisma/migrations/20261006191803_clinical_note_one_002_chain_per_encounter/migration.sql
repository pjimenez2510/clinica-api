-- clinical_note_one_002_chain_per_encounter
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy



-- QUÉ GARANTIZA (EN-229, D-139.5 resuelta por el autor el 06-10-2026):
--
-- Una atención tiene UNA cadena de nota 002. Cada cadena empieza en su
-- versión 1 (EN-024: chain_id = id), así que basta un índice único sobre la
-- atención de las versiones 1 de la 002. Las enmiendas (versión > 1) siguen
-- en la misma cadena y no cuentan. Otros formularios (005, 007…) no cuentan.
--
-- POR QUÉ: el resumen de la atención imprime la última 002 firmada de UNA
-- cadena (DOC-111); una segunda cadena dejaba la primera fuera del papel. La
-- pantalla no abre una segunda; esto cierra la puerta a dos pestañas o dos
-- clics, y a cualquier escritura que no pase por la aplicación.
--
-- DATOS EXISTENTES: si alguna atención tuviera ya dos cadenas 002, el índice
-- no se crea y la migración falla: es lo que se quiere. Se probó sobre una
-- copia de la base del autor (0 atenciones con dos). Si en otra base falla,
-- se informa y se decide qué cadena vale; no se arregla aquí.
--
-- PARA DESHACERLA: DROP INDEX clinical_note_one_002_chain_per_encounter.

CREATE UNIQUE INDEX "clinical_note_one_002_chain_per_encounter"
  ON "clinical_note" ("encounter_id")
  WHERE "form_code" = '002' AND "version" = 1;
