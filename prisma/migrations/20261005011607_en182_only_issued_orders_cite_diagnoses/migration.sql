-- en182_only_issued_orders_cite_diagnoses
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (encounter/SPEC.md EN-182; orders/SPEC.md ORD-100, ORD-102).
--
-- Un diagnóstico no se quita ni se reordena mientras una orden con exámenes
-- vivos lo cite: el papel ya salió con él. Desde ORD-095 la orden nace en
-- BORRADOR, y un borrador —o uno descartado— nunca salió de la consulta: no
-- tiene número, no llegó a un laboratorio y no cita nada fuera de la sala.
-- Contarlo bloqueaba corregir un diagnóstico por una orden que nadie vio.
--
-- POR QUÉ AQUÍ Y NO EN `20261004230000`. Aquella migración define la función
-- antes de que `service_order.status` exista (`20261005001217`); ésta la
-- redefine después, con la misma firma, y los disparadores que la llaman no
-- cambian.

CREATE OR REPLACE FUNCTION encounter_has_document_citing_diagnoses(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1
                   FROM service_order o
                   JOIN service_order_item i ON i.service_order_id = o.id
                  WHERE o.encounter_id = p_encounter_id
                    AND o.status = 'ISSUED'
                    AND i.status <> 'CANCELLED');
$$;
