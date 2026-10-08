-- tariff_publication_final_amount
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-110, BI-113: EL CARTEL EXHIBE EL PRECIO FINAL CON IVA (LODC art. 9, D-192.1)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La Ley Orgánica de Defensa del Consumidor (art. 9) y su Reglamento (art. 9)
-- piden el VALOR FINAL con impuestos. La publicación lo copia como copia el
-- precio y el IVA: lo exhibido no depende de un cambio futuro del cálculo.
-- Lo calcula la aplicación con la función que grava una línea de factura
-- (`lineTax`, cantidad uno, sin descuento, centavo HALF UP), no este SQL.
--
-- SIN RELLENO, A PROPÓSITO. Las dos tablas son de solo inserción
-- (`trg_tariff_publication_item_immutable`, BI-113): las publicaciones ya
-- hechas son la foto de lo que decía la pared, y no se reescriben para
-- añadirles una cifra que no llevaban. Se quedan con `final_amount` NULL y la
-- aplicación se lo calcula al leerlas desde el precio y el % que sí copiaron.
--
-- `NOT VALID` hace el resto: PostgreSQL no comprueba la restricción en las
-- filas existentes, pero sí en TODA fila nueva. Desde aquí no entra una línea
-- publicada sin su precio final, ni uno menor que el precio sin impuesto.

ALTER TABLE "tariff_publication_item"
  ADD COLUMN "final_amount" DECIMAL(12, 2);

ALTER TABLE "tariff_publication_item"
  ADD CONSTRAINT "tariff_publication_item_final_amount_present"
  CHECK ("final_amount" IS NOT NULL AND "final_amount" >= "amount") NOT VALID;
