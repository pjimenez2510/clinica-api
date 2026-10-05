-- prescription_off_formulary_mark
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- PR-110 (enmienda PR-009 y PR-104), D-128.6 resuelta por el autor el
-- 04-10-2026: la Res. ACESS-2023-0030 sólo ata al CNMB a la Red Pública
-- (art. 35) y REQ-054 sólo pide MARCAR lo que está fuera del cuadro. Recetar
-- fuera del CNMB deja de exigir justificación; queda la marca.
--
-- POR QUÉ HACE FALTA UNA COLUMNA. Hasta hoy la marca era la justificación: el
-- papel imprimía «fuera del CNMB» donde había una. Sin justificación
-- obligatoria, una línea del CNMB en una presentación que el cuadro no trae
-- (PR-104) quedaría sin marca, porque las presentaciones declaradas viven en
-- `catalog_concept.attributes`, que cambia con cada carga del cuadro. La marca
-- la decide el servidor al escribir la línea y se congela con ella.
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN … DEFAULT false` no ejecuta
-- un UPDATE ni dispara `prescription_item_frozen`: las líneas escritas antes
-- quedan con `off_formulary = false` y su justificación, que es la que
-- entonces hacía de marca. La aplicación lee como marcada toda línea con la
-- marca, sin concepto o con justificación, así que ninguna receta antigua
-- pierde la suya. Ninguna justificación se borra.
--
-- LA RESTRICCIÓN SE RELAJA, NO SE QUITA, y conserva su nombre (es contrato).
-- Antes: sin concepto, justificación. Ahora: sin concepto, la marca o —una
-- línea anterior a ella— la justificación. Toda fila existente cumplía la
-- anterior, así que cumple ésta y la validación no rechaza nada.

ALTER TABLE "prescription_item"
  ADD COLUMN IF NOT EXISTS "off_formulary" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "prescription_item"
  DROP CONSTRAINT IF EXISTS "prescription_item_off_formulary";
ALTER TABLE "prescription_item"
  ADD CONSTRAINT "prescription_item_off_formulary" CHECK (
    "concept_id" IS NOT NULL
    OR "off_formulary"
    OR "off_formulary_justification" IS NOT NULL
  );
