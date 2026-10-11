-- critical_read_back_by_site
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy




-- QUÉ GARANTIZA (ORD-177, D-207 §2 decidida por el autor en D-223, por
-- confirmar con un clínico):
--
-- El read-back —que quien recibe un valor crítico lo repita— deja de ser
-- obligatorio en todo aviso y pasa a ser un AJUSTE DE LA SEDE, apagado de
-- fábrica (`site_parameter.critical_read_back_required`). La Joint Commission
-- (NPSG.02.03.01) deja a cada organización definir el procedimiento.
--
--  - `critical_result_notice_read_back` se relaja: un aviso hecho dice si se
--    confirmó (verdadero o falso, nunca vacío); un intento sin respuesta sigue
--    sin read-back. Los avisos existentes lo tienen confirmado y cumplen.
--  - `trg_critical_result_notice_read_back_by_site` rechaza el aviso hecho sin
--    confirmar cuando la sede del valor lo exige, también el que llega sin
--    pasar por el servicio. Se juzga al escribir: encender el ajuste no toca
--    las constancias ya guardadas, pero editarlas pide confirmarlo.
--
-- La sede es la de la ORDEN del valor: es la que lleva la cola de críticos.
--
-- PARA DESHACERLA: volver al CHECK de 20261001190953_orders_critical_policy_d111,
-- `DROP TRIGGER trg_critical_result_notice_read_back_by_site ON
-- critical_result_notice; DROP FUNCTION critical_result_notice_read_back_by_site();`
-- y `ALTER TABLE site_parameter DROP COLUMN critical_read_back_required;`

ALTER TABLE "site_parameter"
  ADD COLUMN "critical_read_back_required" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "critical_result_notice"
  DROP CONSTRAINT "critical_result_notice_read_back";
ALTER TABLE "critical_result_notice"
  ADD CONSTRAINT "critical_result_notice_read_back" CHECK (
    ("outcome" = 'NOTIFIED' AND "read_back_confirmed" IS NOT NULL)
    OR ("outcome" = 'NO_ANSWER' AND "read_back_confirmed" IS NULL)
  );

CREATE OR REPLACE FUNCTION critical_result_notice_read_back_by_site()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.outcome = 'NOTIFIED' AND NEW.read_back_confirmed IS NOT TRUE
     AND EXISTS (
       SELECT 1
         FROM observation_result result
         JOIN diagnostic_report report ON report.id = result.report_id
         JOIN service_order ord ON ord.id = report.service_order_id
         JOIN site_parameter parameter ON parameter.site_id = ord.site_id
        WHERE result.id = NEW.observation_result_id
          AND parameter.critical_read_back_required
     ) THEN
    -- El prefijo `<nombre>: ` es lo que lee database-problem.ts: el adaptador
    -- no copia CONSTRAINT para un 23514.
    RAISE EXCEPTION 'critical_result_notice_read_back_by_site: La sede exige que quien recibió el aviso repita el valor (ORD-177)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'critical_result_notice_read_back_by_site';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_critical_result_notice_read_back_by_site
  BEFORE INSERT OR UPDATE ON critical_result_notice
  FOR EACH ROW EXECUTE FUNCTION critical_result_notice_read_back_by_site();
