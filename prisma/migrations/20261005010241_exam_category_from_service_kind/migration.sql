-- exam_category_from_service_kind
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (orders/SPEC.md ORD-108; billing BI-186, BI-187).
--
-- El tipo de un examen (`exam_definition.category`, ORD-097) nació en
-- `LABORATORY` para todo lo que ya había. Desde ORD-108 la prestación con que
-- se cobra un examen es de la clase de su tipo, así que lo que ya existía se
-- alinea con la clase de la categoría de su prestación cuando esa clase es la
-- de una orden (laboratorio, imagen o procedimiento). No es inferir nada
-- clínico: es leer lo que caja ya clasificó (BI-186). Un examen sin prestación,
-- o con una de clase CONSULTATION, SUPPLY u OTHER, se queda como estaba, y la
-- pantalla del catálogo lo enseña para corregirlo a mano.
--
-- POR QUÉ NO UN DISPARADOR. La coherencia se comprueba en los dos lados que la
-- escriben —el catálogo de exámenes (ORD-108, ORD-109) y la categoría de la
-- prestación (BI-187)—, con el mismo criterio que caja ya aplicó a sus otras
-- ataduras. Una regla de tres tablas en disparadores pararía también la
-- corrección de un desajuste heredado, que es lo que esta migración resuelve.

UPDATE "exam_definition" AS "exam"
   SET "category" = "category_row"."kind"::"service_order_category",
       "updated_at" = CURRENT_TIMESTAMP
  FROM "billable_service" AS "service"
  JOIN "billable_service_category" AS "category_row"
    ON "category_row"."id" = "service"."category_id"
 WHERE "exam"."billable_service_id" = "service"."id"
   AND "category_row"."kind" IN ('LABORATORY', 'IMAGING', 'PROCEDURE')
   AND "exam"."category"::text <> "category_row"."kind";
