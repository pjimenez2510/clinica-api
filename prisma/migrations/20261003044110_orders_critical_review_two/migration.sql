-- ════════════════════════════════════════════════════════════════════════════
-- SEGUNDA REVISIÓN CLÍNICA DE F-07 · ORD-062, ORD-063 · D-111 §1, D-113 b
-- ════════════════════════════════════════════════════════════════════════════

-- ORD-063, D-111 §1: el plazo de aviso es cambiable, no eliminable. Sin plazo
-- no se escalaría nunca en horario. Las sedes que lo vaciaron vuelven a 60.
UPDATE "site_parameter"
   SET "critical_notice_within_minutes" = 60
 WHERE "critical_notice_within_minutes" IS NULL;
ALTER TABLE "site_parameter"
  ALTER COLUMN "critical_notice_within_minutes" SET NOT NULL;

-- ORD-062, D-113 b: el médico que pidió el examen y se «avisa a sí mismo».
-- La constancia queda —es lo que pasó—, pero no cierra la cola: el valor sigue
-- esperando el aviso al paciente o a otra persona. Se guarda el HECHO
-- (`self_notice`) y no la política: qué cierra la cola lo decide la consulta.
--
-- `ADD COLUMN` con defecto constante no dispara los disparadores de fila de
-- `critical_result_notice_append_only`: las constancias que existan no se
-- reescriben. Sin defecto desde aquí: cada registro nuevo lo declara.
ALTER TABLE "critical_result_notice"
  ADD COLUMN "self_notice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "critical_result_notice"
  ALTER COLUMN "self_notice" DROP DEFAULT;

-- La cola busca «¿tiene ya un aviso que la cierre?» por resultado.
DROP INDEX "critical_result_notice_done_by_result";
CREATE INDEX "critical_result_notice_done_by_result"
  ON "critical_result_notice" ("observation_result_id")
  WHERE "outcome" = 'NOTIFIED' AND NOT "self_notice";
