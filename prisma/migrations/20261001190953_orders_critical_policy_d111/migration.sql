-- ════════════════════════════════════════════════════════════════════════════
-- LA POLÍTICA DE VALORES CRÍTICOS QUE EL AUTOR DECIDIÓ (D-111, 01-10-2026)
-- ORD-063, ORD-066, ORD-067, ORD-068 · A.M. 00002393 art. 39
-- ════════════════════════════════════════════════════════════════════════════

-- §1. Sesenta minutos de fábrica, cambiables por sede. Las sedes que ya existen
-- nacieron sin plazo porque no estaba decidido; ahora lo está.
ALTER TABLE "site_parameter"
  ALTER COLUMN "critical_notice_within_minutes" SET DEFAULT 60;
UPDATE "site_parameter"
   SET "critical_notice_within_minutes" = 60
 WHERE "critical_notice_within_minutes" IS NULL;

-- §5. Una llamada que nadie contestó también se registra, y NO es un aviso: el
-- valor sigue en la cola. Mismo registro, porque es el mismo acto con otro
-- desenlace, y la misma inmutabilidad (ORD-064).
CREATE TYPE "CriticalNoticeOutcome" AS ENUM ('NOTIFIED', 'NO_ANSWER');

-- La tabla es append-only por disparador, y `ADD COLUMN` no dispara los de
-- fila: las constancias que existan no se reescriben. Nacen como avisos hechos,
-- dentro de horario, sin read-back (que entonces no se pedía); el `CHECK` de
-- abajo es `NOT VALID` para no exigirles lo que nadie les pidió.
ALTER TABLE "critical_result_notice"
  ADD COLUMN "outcome" "CriticalNoticeOutcome" NOT NULL DEFAULT 'NOTIFIED',
  -- §4. Quien recibió el aviso repitió el valor. Sólo tiene sentido en un aviso
  -- hecho: en un intento sin respuesta no hubo nadie que lo repitiera.
  ADD COLUMN "read_back_confirmed" BOOLEAN,
  -- §3. La constancia dice si fue fuera de horario de la sede (ORD-068).
  ADD COLUMN "after_hours" BOOLEAN NOT NULL DEFAULT false;

-- Sin defecto desde aquí: cada registro nuevo declara su desenlace y su
-- horario. Un defecto silencioso convertiría un intento en un aviso.
ALTER TABLE "critical_result_notice"
  ALTER COLUMN "outcome" DROP DEFAULT,
  ALTER COLUMN "after_hours" DROP DEFAULT;

-- §4 en la base: un aviso hecho lleva read-back confirmado; un intento, nada.
ALTER TABLE "critical_result_notice"
  ADD CONSTRAINT "critical_result_notice_read_back" CHECK (
    ("outcome" = 'NOTIFIED' AND "read_back_confirmed" IS TRUE)
    OR ("outcome" = 'NO_ANSWER' AND "read_back_confirmed" IS NULL)
  ) NOT VALID;

-- La cola busca «¿tiene ya un aviso hecho?» por resultado.
CREATE INDEX "critical_result_notice_done_by_result"
  ON "critical_result_notice" ("observation_result_id")
  WHERE "outcome" = 'NOTIFIED';
