-- observation_result_classified_sex
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy




-- QUÉ GARANTIZA (PA-082, ORD-176; revisión clínica de la tarea 16 de
-- feat/d223-ordenes-resultados):
--
-- Cada resultado guarda el SEXO CON QUE SE CLASIFICÓ (`classified_sex`) y si su
-- determinación tiene rangos distintos por sexo (`sex_specific_ranges`). Con la
-- ficha unificada se clasifica con el sexo de la vigente (ORD-176); deshacer no
-- reclasifica (la bandera se congela, ORD-114), así que lo que hay que revisar
-- es exactamente «clasificado con un sexo que no es el de su ficha, en una
-- determinación que depende del sexo». Leído por fila, y no por la ventana de
-- `merged_at` y el sexo de hoy de la vigente, la lista:
--   - no desaparece al deshacer;
--   - no se esconde si la vigente se corrige durante la unificación;
--   - no lista lo que no dependía del sexo (una glucosa).
--
-- NO toca datos: los resultados anteriores nacen sin sexo de clasificación y
-- no se listan. La base no tiene emitidas reales (fase de desarrollo).
--
-- PARA DESHACERLA: `ALTER TABLE observation_result DROP COLUMN classified_sex,
-- DROP COLUMN sex_specific_ranges;`

ALTER TABLE "observation_result"
  ADD COLUMN "classified_sex" "patient_sex",
  ADD COLUMN "sex_specific_ranges" BOOLEAN NOT NULL DEFAULT false;
