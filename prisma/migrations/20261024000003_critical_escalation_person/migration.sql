-- critical_escalation_person
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy




-- QUÉ GARANTIZA (ORD-179, D-207 §2 decidida por el autor en D-223, por
-- confirmar con un clínico):
--
-- La guardia de críticos de una sede puede ser una PERSONA concreta, no sólo
-- un rol: la Joint Commission (NPSG.02.03.01) pide una escalada nominal, y un
-- rol que tienen seis personas es un aviso que cada una cree que atiende otra.
--
--  - `critical_escalation_user_id` apunta a la cuenta; sin borrado en cascada
--    (una cuenta no se borra, se desactiva, y entonces la sede queda sin
--    guardia atendida: la cola lo dice, ORD-167).
--  - `site_parameter_one_escalation`: rol o persona, nunca los dos. Con dos, a
--    quién toca el aviso vencido dejaría de ser una sola respuesta.
--
-- NO toca datos: las sedes siguen con el rol que tenían, o sin guardia.
--
-- PARA DESHACERLA: `ALTER TABLE site_parameter DROP COLUMN
-- critical_escalation_user_id;` (se lleva la restricción).

ALTER TABLE "site_parameter"
  ADD COLUMN "critical_escalation_user_id" UUID
    CONSTRAINT "site_parameter_critical_escalation_user_id_fkey"
    REFERENCES "app_user"("id") ON DELETE RESTRICT;

ALTER TABLE "site_parameter"
  ADD CONSTRAINT "site_parameter_one_escalation" CHECK (
    "critical_escalation_role_id" IS NULL OR "critical_escalation_user_id" IS NULL
  );
