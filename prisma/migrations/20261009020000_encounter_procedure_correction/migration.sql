-- encounter_procedure_correction
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-244 A EN-246 (D-194): EL PROCEDIMIENTO SE CORRIGE Y SE QUITA COMO EL
-- DIAGNÓSTICO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. CORREGIR ES EDITAR (EN-244, D-127). El procedimiento se edita en su fila
--    —concepto, código, cantidad, nota— y la fila anterior queda en
--    `record_version` con quién y cuándo, por `record_version_archive`: sin
--    sello nuevo, no hay edición.
--
-- 2. QUITAR ES ARCHIVAR (EN-245). Como `encounter_diagnosis_retraction`
--    (EN-180): la fila entera pasa a `encounter_procedure_retraction` con
--    quién, cuándo y POR QUÉ, y sólo entonces se borra de la tabla viva. Así
--    nadie que lea `encounter_procedure` —el acto clínico de la atención, lo
--    que caja propone— tiene que acordarse de filtrar.
--
-- 3. RESTAURAR (EN-246). El procedimiento vuelve como fila NUEVA, y el
--    archivo dice, UNA vez, quién lo restauró, cuándo y como qué fila.
--
-- NO SE TOCA NINGUNA FILA GUARDADA: los procedimientos existentes quedan sin
-- sello de edición, que es la verdad («nadie los editó»).

-- ── 1. El sello y la versión ─────────────────────────────────────────────
ALTER TABLE "encounter_procedure"
  ADD COLUMN "edited_by_id" UUID,
  ADD COLUMN "edited_at" TIMESTAMPTZ(6);

ALTER TABLE "encounter_procedure"
  ADD CONSTRAINT "encounter_procedure_edited_by_id_fkey"
  FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quién y cuándo, juntos o ninguno.
ALTER TABLE "encounter_procedure"
  ADD CONSTRAINT "encounter_procedure_edit_states_who_and_when" CHECK (
    ("edited_by_id" IS NULL) = ("edited_at" IS NULL)
  );

CREATE TRIGGER "trg_encounter_procedure_record_version"
  BEFORE UPDATE ON "encounter_procedure"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'id');

-- ── 2. El archivo de los quitados ─────────────────────────────────────────
CREATE TABLE "encounter_procedure_retraction" (
  -- El id que tenía el procedimiento: el archivo es el mismo hecho, movido.
  "id"                UUID NOT NULL,
  "encounter_id"      UUID NOT NULL,
  "concept_id"        UUID NOT NULL,
  "procedure_code"    VARCHAR(20) NOT NULL,
  "procedure_display" VARCHAR(512) NOT NULL,
  "quantity"          SMALLINT NOT NULL,
  "performed_at"      TIMESTAMPTZ(6) NOT NULL,
  "note"              TEXT,
  -- La última edición de la fila viva, que se iría con ella.
  "edited_by_id"      UUID,
  "edited_at"         TIMESTAMPTZ(6),

  -- El instante lo pone la aplicación: los recorridos mueven su reloj.
  "retracted_at"      TIMESTAMPTZ(6) NOT NULL,
  "retracted_by_id"   UUID NOT NULL,
  "reason"            VARCHAR(500) NOT NULL,

  "restored_at"       TIMESTAMPTZ(6),
  "restored_by_id"    UUID,
  -- No es clave foránea: el restaurado se puede volver a quitar.
  "restored_as_id"    UUID,

  CONSTRAINT "encounter_procedure_retraction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "encounter_procedure_retraction_reason_not_blank"
    CHECK (btrim("reason") <> ''),
  CONSTRAINT "encounter_procedure_retraction_restored_states_who_when_what" CHECK (
    ("restored_at" IS NULL) = ("restored_by_id" IS NULL)
    AND ("restored_at" IS NULL) = ("restored_as_id" IS NULL)
  )
);

CREATE INDEX "encounter_procedure_retraction_encounter_id_idx"
  ON "encounter_procedure_retraction"("encounter_id");

ALTER TABLE "encounter_procedure_retraction"
  ADD CONSTRAINT "encounter_procedure_retraction_encounter_id_fkey"
  FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "encounter_procedure_retraction"
  ADD CONSTRAINT "encounter_procedure_retraction_concept_id_fkey"
  FOREIGN KEY ("concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "encounter_procedure_retraction"
  ADD CONSTRAINT "encounter_procedure_retraction_retracted_by_id_fkey"
  FOREIGN KEY ("retracted_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "encounter_procedure_retraction"
  ADD CONSTRAINT "encounter_procedure_retraction_restored_by_id_fkey"
  FOREIGN KEY ("restored_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "encounter_procedure_retraction"
  ADD CONSTRAINT "encounter_procedure_retraction_edited_by_id_fkey"
  FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El archivo es la fila viva tal cual, y nace sin restaurar.
CREATE OR REPLACE FUNCTION encounter_procedure_retraction_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  live encounter_procedure%ROWTYPE;
BEGIN
  SELECT * INTO live FROM encounter_procedure WHERE id = NEW.id;
  IF NOT FOUND
     OR live.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR live.concept_id IS DISTINCT FROM NEW.concept_id
     OR live.procedure_code IS DISTINCT FROM NEW.procedure_code
     OR live.procedure_display IS DISTINCT FROM NEW.procedure_display
     OR live.quantity IS DISTINCT FROM NEW.quantity
     OR live.performed_at IS DISTINCT FROM NEW.performed_at
     OR live.note IS DISTINCT FROM NEW.note
     OR live.edited_by_id IS DISTINCT FROM NEW.edited_by_id
     OR live.edited_at IS DISTINCT FROM NEW.edited_at THEN
    RAISE EXCEPTION
      'encounter_procedure_retraction_matches: the archive must be the procedure being removed, as it is'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-245.';
  END IF;

  IF NEW.restored_at IS NOT NULL OR NEW.restored_by_id IS NOT NULL
     OR NEW.restored_as_id IS NOT NULL THEN
    RAISE EXCEPTION
      'encounter_procedure_retraction_frozen: an archive is born not restored'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-246.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_procedure_retraction_admits"
  BEFORE INSERT ON "encounter_procedure_retraction"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_retraction_admits();

-- La única escritura admitida: marcar UNA vez quién lo restauró, hacia ese
-- mismo procedimiento de vuelta en su atención. Nada más cambia ni se borra.
CREATE OR REPLACE FUNCTION encounter_procedure_retraction_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.restored_at IS NULL
       AND NEW.restored_at IS NOT NULL
       AND (to_jsonb(NEW) - 'restored_at' - 'restored_by_id' - 'restored_as_id')
           = (to_jsonb(OLD) - 'restored_at' - 'restored_by_id' - 'restored_as_id') THEN
      IF NOT EXISTS (SELECT 1 FROM encounter_procedure p
                      WHERE p.id = NEW.restored_as_id
                        AND p.id <> OLD.id
                        AND p.encounter_id = OLD.encounter_id
                        AND p.concept_id = OLD.concept_id) THEN
        RAISE EXCEPTION
          'encounter_procedure_retraction_restored_as_itself: a removed procedure is restored as the same procedure, back on its attention'
          USING ERRCODE = 'integrity_constraint_violation',
                HINT = 'EN-246.';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'encounter_procedure_retraction_frozen: the archive of removed procedures never changes'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'EN-245, EN-246.';
END;
$$;

CREATE TRIGGER "encounter_procedure_retraction_frozen"
  BEFORE UPDATE OR DELETE ON "encounter_procedure_retraction"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_retraction_guard();

CREATE OR REPLACE FUNCTION encounter_procedure_never_truncated()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'encounter_procedure_retraction_frozen: procedures and their archive are never truncated'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'EN-245.';
END;
$$;

CREATE TRIGGER "encounter_procedure_retraction_never_truncated"
  BEFORE TRUNCATE ON "encounter_procedure_retraction"
  FOR EACH STATEMENT
  EXECUTE FUNCTION encounter_procedure_never_truncated();

CREATE TRIGGER "encounter_procedure_never_truncated"
  BEFORE TRUNCATE ON "encounter_procedure"
  FOR EACH STATEMENT
  EXECUTE FUNCTION encounter_procedure_never_truncated();

-- ── 3. Sin archivo, no hay borrado. Tampoco desde psql ──────────────────
CREATE OR REPLACE FUNCTION encounter_procedure_delete_requires_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM encounter_procedure_retraction r WHERE r.id = OLD.id) THEN
    RAISE EXCEPTION
      'encounter_procedure_archived: a procedure is removed only after it is archived'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-245. Insert it into encounter_procedure_retraction first.';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "trg_encounter_procedure_delete_archived"
  BEFORE DELETE ON "encounter_procedure"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_delete_requires_archive();
