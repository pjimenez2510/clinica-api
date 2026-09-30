-- El `CHECK` tiene que admitir el estado nuevo, y no podía hacerlo en la misma
-- migración: PostgreSQL no deja USAR un valor de enum añadido en la
-- transacción que lo añade.
--
-- La forma cambia de una igualdad a una regla por estado, porque ahora son
-- tres casos y no dos:
--
--   DRAFT      → sin instante de emisión: no ha salido de la consulta.
--   DISCARDED  → sin instante tampoco: se descartó ANTES de emitirse. Es la
--                mitad que faltaba.
--   el resto   → con instante: existe un papel en la mano de alguien.
ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_issued_coherence";

ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_issued_coherence" CHECK (
    ("status" IN ('DRAFT', 'DISCARDED')) = ("issued_at" IS NULL)
  );

-- Descartar un borrador exige decir por qué, por la misma razón que anular una
-- cita: sin motivo, es una forma de hacer desaparecer lo que se escribió.
ALTER TABLE "prescription"
  ADD COLUMN IF NOT EXISTS "discarded_at"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "discarded_by_id"  UUID,
  ADD COLUMN IF NOT EXISTS "discard_reason"   VARCHAR(500);

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_discarded_by_fk";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_discarded_by_fk"
    FOREIGN KEY ("discarded_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_discard_states_who_when_and_why";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_discard_states_who_when_and_why" CHECK (
    ("status" <> 'DISCARDED')
    OR ("discarded_at" IS NOT NULL
        AND "discarded_by_id" IS NOT NULL
        AND "discard_reason" IS NOT NULL)
  );

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_discard_only_from_draft";
-- Sólo un borrador se descarta: lo emitido se anula, que es otro acto.
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_discard_only_from_draft" CHECK (
    "discarded_at" IS NULL OR "status" = 'DISCARDED'
  );
