-- payer_ruc_format
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA (BI-036): que el RUC de un pagador, si lo tiene, sean trece
-- dígitos terminados en un código de establecimiento, `001` en adelante: la
-- misma forma que `establishment_ruc_format` y `site_ruc_format`. El resto de
-- la regla —provincia, tercer dígito y el verificador de persona natural— vive
-- en `Ruc` (OR-008, OR-009), porque no cabe en un CHECK legible.
--
-- POR QUÉ (D-057): la API sólo acotaba el RUC del pagador a 13 caracteres, y
-- «Particular» admitía `12345`. Un RUC mal escrito llega a la factura
-- electrónica y el SRI la rechaza meses después de teclearlo.
--
-- VALIDADO, no `NOT VALID`: antes de escribirlo se listaron los pagadores con
-- un RUC que no cumple y no había ninguno (base de desarrollo, 30-09-2026). Si
-- alguna base los tuviera, esta migración falla y dice cuál es la restricción:
-- se corrigen esas filas a mano, no se relaja la regla.

ALTER TABLE payer
  ADD CONSTRAINT payer_ruc_format
    CHECK (ruc IS NULL OR (ruc ~ '^[0-9]{13}$' AND right(ruc, 3) <> '000'));
