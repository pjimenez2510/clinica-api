-- invoice_buyer_identification_format
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA (BI-159): que el receptor de una factura identificado con RUC
-- (tipo `04` del SRI) lleve trece dígitos terminados en un código de
-- establecimiento, `001` en adelante —la forma de `payer_ruc_format`—, y que
-- el identificado con cédula (`05`) lleve diez dígitos. El resto de la regla
-- —provincia, tercer dígito, verificador— vive en `Ruc` y `Cedula`, porque no
-- cabe en un CHECK legible. `06`, `07` y `08` no se tocan: `07` ya lo gobierna
-- `invoice_final_consumer_identification`, y los otros dos los emite otro país.
--
-- POR QUÉ: la emisión sólo exigía que el número no estuviera vacío, y el SRI
-- rechaza la factura DESPUÉS de emitida, cuando ya no se puede editar (BI-084).
--
-- VALIDADOS, no `NOT VALID`: la base de desarrollo no tiene facturas
-- (30-09-2026). Si alguna base tuviera una que no cumple, esta migración falla
-- y dice cuál es la restricción; una factura no se corrige editándola, así que
-- esa base necesita decidir qué hacer con ella antes de seguir.

ALTER TABLE invoice
  ADD CONSTRAINT invoice_buyer_ruc_format
    CHECK (
      buyer_identification_type <> '04'
      OR (buyer_identification ~ '^[0-9]{13}$'
          AND right(buyer_identification, 3) <> '000')
    ),
  ADD CONSTRAINT invoice_buyer_cedula_format
    CHECK (
      buyer_identification_type <> '05'
      OR buyer_identification ~ '^[0-9]{10}$'
    );
