-- prescription_discard_reason_optional
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- PR-011 (enmendado) y PR-107, D-126 resuelta por el autor el 04-10-2026.
--
-- QUÉ GARANTIZA. Un borrador de receta descartado sigue diciendo QUIÉN lo
-- descartó y CUÁNDO —el sistema lo pone solo—, pero ya no exige un motivo:
-- un borrador nunca salió de la consulta, y lo que no ha salido se quita sin
-- preguntar (D-126.1). Si alguien escribe un motivo, `discard_reason` lo
-- guarda igual que antes.
--
-- NO SE BORRA NINGÚN MOTIVO YA GUARDADO. Sólo cambia la restricción: las filas
-- que ya tenían motivo lo conservan, y todas cumplen la nueva, que pide menos
-- que la anterior.
--
-- Volver de DISCARDED a DRAFT (deshacer, PR-107) no necesita nada aquí:
-- `prescription_discard_only_from_draft` ya obliga a limpiar el instante del
-- descarte, esta restricción no mira un DRAFT, `prescription_issued_coherence`
-- deja a los dos sin instante de emisión y `prescription_frozen` no toca una
-- receta que nunca se emitió.

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_discard_states_who_when_and_why";

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_discard_states_who_and_when";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_discard_states_who_and_when" CHECK (
    ("status" <> 'DISCARDED')
    OR ("discarded_at" IS NOT NULL AND "discarded_by_id" IS NOT NULL)
  );
