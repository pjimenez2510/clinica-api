-- site_parameter_retention_minimum
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-032, EN-157: EL PLAZO DE CONSERVACIÓN NO BAJA DE QUINCE AÑOS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- D-A-011 fijó quince años desde la última atención (5 de archivo activo + 10
-- de pasivo) como el mínimo que la clínica declara mientras no aparezca la
-- norma que delegó la Disposición Transitoria Primera del A.M. 00115-2021.
-- `site_parameter_retention_is_positive` sólo pedía que fuera mayor que cero:
-- la base aceptaba un año. El mínimo legal se garantiza aquí y no en un DTO,
-- porque quien lo baje por SQL no pasa por ningún DTO.
--
-- Se AÑADE y no sustituye a la anterior: la de «positivo» queda como estaba y
-- ésta es la que manda; quitarla no compraría nada.
--
-- LAS FILAS QUE YA EXISTEN: todas en 15 (el defecto) en la base del autor el
-- 07-10-2026. Una sede con menos haría fallar esta migración, que es lo
-- correcto: alguien declaró un plazo ilegal y tiene que verlo.
--
-- Y NADA SE BORRA AL VENCER (EN-158): ningún proceso lee este número para
-- purgar. Es lo que se declara, no lo que se ejecuta.

ALTER TABLE "site_parameter"
  ADD CONSTRAINT "site_parameter_retention_minimum"
    CHECK ("record_retention_years" >= 15);
